/**
 * Agents — the frontend store.
 *
 * A `useSyncExternalStore` source over the agents commands. The backend is the
 * authority and pushes four events: `registry` (the list changed: reload it),
 * `status` (an agent started, is doing something, or went idle), `message`
 * (a new or updated chat line), and `draft` (a reply still being written).
 * Messages are kept only for chats that have been opened in this session,
 * newest page first and older pages as you scroll up; a draft is kept for any
 * agent until the message that completes it (same id) arrives or the turn ends.
 *
 * Components subscribe to a slice (`useAgentsSelector`), never the whole
 * state: a reply streaming in another chat updates the store every 40 ms, and
 * that must not re-render the app, the sidebar or the chat on screen.
 *
 * @module lib/agentsStore
 */

import { useRef, useSyncExternalStore } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  AGENT_EVENTS,
  getAgentMessages,
  getAgentsOverview,
  needsYou,
  type Agent,
  type AgentMessage,
  type AgentStatus,
  type EngineInfo,
} from './agents';
import { asCommandError, formatCommandError } from './errors';
import { logger } from './logger';

export interface AgentsState {
  agents: Agent[];
  engineReady: boolean;
  engines: EngineInfo[];
  loaded: boolean;
  error: string | null;
  /** Chat lines per agent, oldest first; absent until that chat is opened. */
  messages: Record<string, AgentMessage[]>;
  /** Chats with lines older than the ones loaded. */
  older: Record<string, boolean>;
  /** The reply each agent is writing right now, if any. */
  drafts: Record<string, AgentMessage>;
}

let state: AgentsState = {
  agents: [],
  engineReady: true,
  engines: [],
  loaded: false,
  error: null,
  messages: {},
  older: {},
  drafts: {},
};
const listeners = new Set<() => void>();
let unlistens: UnlistenFn[] = [];
let generation = 0;
let refreshTimer: number | null = null;

function emit(next: AgentsState) {
  state = next;
  for (const listener of listeners) listener();
}

export function getAgentsSnapshot(): AgentsState {
  return state;
}

export async function refreshAgents(): Promise<void> {
  try {
    const overview = await getAgentsOverview();
    emit({
      ...state,
      agents: keepUnchanged(state.agents, overview.agents),
      engineReady: overview.engineReady,
      engines: overview.engines ?? [],
      loaded: true,
      error: null,
    });
  } catch (error) {
    logger.error('[Agents] overview failed', { error: String(error) });
    emit({ ...state, loaded: true, error: formatCommandError(asCommandError(error)) });
  }
}

/**
 * A reload returns every agent anew, though usually one row changed. Keep the
 * objects (and the list) that didn't, so only what changed re-renders.
 */
function keepUnchanged(previous: Agent[], next: Agent[]): Agent[] {
  const before = new Map(previous.map((a) => [a.id, a]));
  let same = previous.length === next.length;
  const merged = next.map((agent, i) => {
    const old = before.get(agent.id);
    if (old && JSON.stringify(old) === JSON.stringify(agent)) {
      if (previous[i] !== old) same = false;
      return old;
    }
    same = false;
    return agent;
  });
  return same ? previous : merged;
}

/** Coalesce bursts of registry events (every message bumps the row). */
function scheduleRefresh() {
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshAgents();
  }, 120);
}

/** Lines a chat opens with; older ones load a page at a time as you scroll up. */
export const MESSAGE_PAGE = 150;
/** The most `agents_messages` returns in one call. */
export const MESSAGE_MAX = 5000;

function setMessages(agentId: string, messages: AgentMessage[], older: boolean) {
  emit({
    ...state,
    messages: { ...state.messages, [agentId]: messages },
    older: { ...state.older, [agentId]: older },
  });
}

/** (Re)load a chat's newest page. */
export async function loadMessages(agentId: string): Promise<void> {
  try {
    const messages = await getAgentMessages(agentId, MESSAGE_PAGE);
    setMessages(agentId, messages, messages.length >= MESSAGE_PAGE);
  } catch (error) {
    logger.error('[Agents] messages failed', { agentId, error: String(error) });
    setMessages(agentId, state.messages[agentId] ?? [], false);
  }
}

/** One request per chat at a time: a scroll and a search jump can both ask. */
const loadingOlder = new Map<string, Promise<void>>();

/**
 * Load the page before the oldest line loaded, or with `through`, every line
 * back to that one (a search hit). Resolves once the store has them.
 */
export function loadOlderMessages(agentId: string, through?: string): Promise<void> {
  const inFlight = loadingOlder.get(agentId);
  if (inFlight)
    return inFlight.then(() => (through ? loadOlderMessages(agentId, through) : undefined));
  const loaded = state.messages[agentId];
  if (!loaded || !state.older[agentId] || (through && loaded.some((m) => m.id === through))) {
    return Promise.resolve();
  }
  const request = getAgentMessages(agentId, MESSAGE_PAGE, { before: loaded[0]?.id, through })
    .then((page) => {
      const current = state.messages[agentId] ?? [];
      const have = new Set(current.map((m) => m.id));
      const fresh = page.filter((m) => !have.has(m.id));
      // Nothing new (a backend that ignores the cursor) means nothing older either.
      setMessages(agentId, [...fresh, ...current], fresh.length > 0 && page.length >= MESSAGE_PAGE);
    })
    .catch((error: unknown) => {
      logger.error('[Agents] older messages failed', { agentId, error: String(error) });
    })
    .finally(() => loadingOlder.delete(agentId));
  loadingOlder.set(agentId, request);
  return request;
}

function withoutDraft(agentId: string, id?: string): AgentsState['drafts'] {
  const draft = state.drafts[agentId];
  if (!draft || (id !== undefined && draft.id !== id)) return state.drafts;
  const { [agentId]: _gone, ...rest } = state.drafts;
  return rest;
}

/**
 * Insert or replace a chat line (approvals are updated in place). The line
 * that completes a draft replaces it in the same render, so nothing flickers.
 */
export function upsertMessage(message: AgentMessage) {
  const drafts = withoutDraft(message.agentId, message.id);
  const existing = state.messages[message.agentId];
  if (!existing) {
    if (drafts !== state.drafts) emit({ ...state, drafts });
    return;
  }
  const index = existing.findIndex((m) => m.id === message.id);
  const next =
    index === -1 ? [...existing, message] : existing.map((m, i) => (i === index ? message : m));
  emit({ ...state, drafts, messages: { ...state.messages, [message.agentId]: next } });
}

/** A reply grew. Keeps the time it started, so it doesn't jump past a divider. */
export function updateDraft(agentId: string, id: string, text: string) {
  const previous = state.drafts[agentId];
  if (state.messages[agentId]?.some((m) => m.id === id)) return;
  const ts = previous?.id === id ? previous.ts : Date.now();
  emit({
    ...state,
    drafts: { ...state.drafts, [agentId]: { id, agentId, ts, kind: 'agent', text } },
  });
}

/**
 * You just sent `text`: the row shows it and moves up at once, as the
 * backend's own update will (its first line: `preview_for` in runner.rs).
 */
export function markSent(agentId: string, text: string) {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  emit({
    ...state,
    agents: state.agents.map((a) =>
      a.id === agentId
        ? { ...a, preview: line?.slice(0, 140) ?? a.preview, lastActivityAt: Date.now() }
        : a
    ),
  });
}

function patchStatus(agentId: string, status: AgentStatus) {
  emit({
    ...state,
    agents: state.agents.map((a) => (a.id === agentId ? { ...a, status } : a)),
    // A turn that ended without completing its draft took it with it.
    drafts: status.state === 'idle' ? withoutDraft(agentId) : state.drafts,
  });
}

function start() {
  const mine = ++generation;
  void refreshAgents();
  void Promise.all([
    listen<AgentMessage>(AGENT_EVENTS.message, (e) => upsertMessage(e.payload)),
    listen<{ agentId: string; status: AgentStatus }>(AGENT_EVENTS.status, (e) =>
      patchStatus(e.payload.agentId, e.payload.status)
    ),
    listen(AGENT_EVENTS.registry, () => scheduleRefresh()),
    listen<{ agentId: string; id: string; text: string }>(AGENT_EVENTS.draft, (e) =>
      updateDraft(e.payload.agentId, e.payload.id, e.payload.text)
    ),
  ]).then((handles) => {
    if (mine !== generation) {
      handles.forEach((h) => h());
      return;
    }
    unlistens = handles;
  });
}

function stop() {
  generation++;
  unlistens.forEach((h) => h());
  unlistens = [];
}

export function subscribeAgents(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/**
 * A slice of the store; the component re-renders only when the slice changes
 * (by `isEqual`, identity by default). `select` may be an inline function.
 */
export function useAgentsSelector<T>(
  select: (state: AgentsState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  const last = useRef<{ state: AgentsState; select: typeof select; value: T } | null>(null);
  const getSlice = () => {
    const prev = last.current;
    if (prev && prev.state === state && prev.select === select) return prev.value;
    const value = select(state);
    last.current = {
      state,
      select,
      value: prev && isEqual(prev.value, value) ? prev.value : value,
    };
    return last.current.value;
  };
  return useSyncExternalStore(subscribeAgents, getSlice);
}

const selectAgents = (s: AgentsState) => s.agents;
export const useAgentsList = () => useAgentsSelector(selectAgents);

/** What the Agents side wants from you: who is waiting on your OK, and how many have news. */
export interface AgentsAttention {
  /** Names of the visible agents waiting on an approval or an answer. */
  waiting: string[];
  /** Visible agents with unread replies, not counting the ones above. */
  unread: number;
}

/** Agents attention for the mode toggle's dot and tooltip. Hidden agents never ask. */
export function useAgentsAttention(): AgentsAttention {
  return useAgentsSelector(attentionOf, sameAttention);
}

function attentionOf({ agents }: AgentsState): AgentsAttention {
  const visible = agents.filter((a) => !a.hidden);
  const waiting = visible.filter(needsYou);
  return {
    waiting: waiting.map((a) => a.name),
    unread: visible.filter((a) => !needsYou(a) && a.unread > 0).length,
  };
}

const sameAttention = (a: AgentsAttention, b: AgentsAttention) =>
  a.unread === b.unread && a.waiting.join('\n') === b.waiting.join('\n');

/** Test hook. */
export function __resetAgentsStore() {
  stop();
  state = {
    agents: [],
    engineReady: true,
    engines: [],
    loaded: false,
    error: null,
    messages: {},
    older: {},
    drafts: {},
  };
  loadingOlder.clear();
}
