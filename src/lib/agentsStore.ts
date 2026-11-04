/**
 * Agents — the frontend store.
 *
 * A `useSyncExternalStore` source over the agents commands. The backend is the
 * authority and pushes four events: `registry` (the list changed: reload it),
 * `status` (an agent started, is doing something, or went idle), `message`
 * (a new or updated chat line), and `draft` (a reply still being written).
 * Messages are kept only for chats that have been opened in this session; a
 * draft is kept for any agent until the message that completes it (same id)
 * arrives or the turn ends.
 *
 * @module lib/agentsStore
 */

import { useSyncExternalStore } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  AGENT_EVENTS,
  getAgentMessages,
  getAgentsOverview,
  needsYou,
  type Agent,
  type AgentMessage,
  type AgentStatus,
} from './agents';
import { asCommandError, formatCommandError } from './errors';
import { logger } from './logger';

export interface AgentsState {
  agents: Agent[];
  engineReady: boolean;
  loaded: boolean;
  error: string | null;
  /** Chat lines per agent, oldest first; absent until that chat is opened. */
  messages: Record<string, AgentMessage[]>;
  /** The reply each agent is writing right now, if any. */
  drafts: Record<string, AgentMessage>;
}

let state: AgentsState = {
  agents: [],
  engineReady: true,
  loaded: false,
  error: null,
  messages: {},
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
      agents: overview.agents,
      engineReady: overview.engineReady,
      loaded: true,
      error: null,
    });
  } catch (error) {
    logger.error('[Agents] overview failed', { error: String(error) });
    emit({ ...state, loaded: true, error: formatCommandError(asCommandError(error)) });
  }
}

/** Coalesce bursts of registry events (every message bumps the row). */
function scheduleRefresh() {
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshAgents();
  }, 120);
}

/** Lines a chat loads by default; must match `agents_messages`' default. */
export const MESSAGE_PAGE = 400;
/** The most `agents_messages` returns: what a search jump loads to reach an old line. */
export const MESSAGE_MAX = 5000;

export async function loadMessages(agentId: string, limit?: number): Promise<void> {
  try {
    const messages = await getAgentMessages(agentId, limit);
    emit({ ...state, messages: { ...state.messages, [agentId]: messages } });
  } catch (error) {
    logger.error('[Agents] messages failed', { agentId, error: String(error) });
    emit({ ...state, messages: { ...state.messages, [agentId]: state.messages[agentId] ?? [] } });
  }
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

export function useAgents(): AgentsState {
  return useSyncExternalStore(subscribeAgents, getAgentsSnapshot);
}

/** What the Agents side wants from you: who is waiting on your OK, and how many have news. */
export interface AgentsAttention {
  /** Names of the visible agents waiting on an approval or an answer. */
  waiting: string[];
  /** Visible agents with unread replies, not counting the ones above. */
  unread: number;
}

/** Agents attention for the mode toggle's dot and tooltip. Hidden agents never ask. */
export function useAgentsAttention(): AgentsAttention {
  const { agents } = useAgents();
  const visible = agents.filter((a) => !a.hidden);
  const waiting = visible.filter(needsYou);
  return {
    waiting: waiting.map((a) => a.name),
    unread: visible.filter((a) => !needsYou(a) && a.unread > 0).length,
  };
}

/** Test hook. */
export function __resetAgentsStore() {
  stop();
  state = { agents: [], engineReady: true, loaded: false, error: null, messages: {}, drafts: {} };
}
