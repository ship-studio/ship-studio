/**
 * Agents — the frontend store.
 *
 * A `useSyncExternalStore` source over the agents commands. The backend is the
 * authority and pushes three events: `registry` (the list changed: reload it),
 * `status` (an agent started, is doing something, or went idle), and
 * `message` (a new or updated chat line). Messages are kept only for chats
 * that have been opened in this session.
 *
 * @module lib/agentsStore
 */

import { useSyncExternalStore } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  AGENT_EVENTS,
  getAgentMessages,
  getAgentsOverview,
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
}

let state: AgentsState = {
  agents: [],
  engineReady: true,
  loaded: false,
  error: null,
  messages: {},
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

export async function loadMessages(agentId: string): Promise<void> {
  try {
    const messages = await getAgentMessages(agentId);
    emit({ ...state, messages: { ...state.messages, [agentId]: messages } });
  } catch (error) {
    logger.error('[Agents] messages failed', { agentId, error: String(error) });
    emit({ ...state, messages: { ...state.messages, [agentId]: state.messages[agentId] ?? [] } });
  }
}

/** Insert or replace a chat line (approvals are updated in place). */
export function upsertMessage(message: AgentMessage) {
  const existing = state.messages[message.agentId];
  if (!existing) return;
  const index = existing.findIndex((m) => m.id === message.id);
  const next =
    index === -1 ? [...existing, message] : existing.map((m, i) => (i === index ? message : m));
  emit({ ...state, messages: { ...state.messages, [message.agentId]: next } });
}

function patchStatus(agentId: string, status: AgentStatus) {
  emit({
    ...state,
    agents: state.agents.map((a) => (a.id === agentId ? { ...a, status } : a)),
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

/** Unread plus pending approvals across agents: the sidebar nav badge, same as the Dock's. */
export function useAgentsUnread(): number {
  const { agents } = useAgents();
  return agents.reduce((sum, a) => sum + (a.hidden ? 0 : a.unread + (a.pendingApprovals ?? 0)), 0);
}

/** Test hook. */
export function __resetAgentsStore() {
  stop();
  state = { agents: [], engineReady: true, loaded: false, error: null, messages: {} };
}
