/**
 * Agents — types mirroring `src-tauri/src/agents/` and the invoke wrappers.
 *
 * @module lib/agents
 */

import { invoke } from '@tauri-apps/api/core';

/** Avatar colour keys. The CSS maps each to a feature token. */
export const AGENT_COLORS = [
  'white',
  'brown',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'gray',
] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

/** Number of avatar shapes; must match `SHAPE_COUNT` in store.rs. */
export const AGENT_SHAPE_COUNT = 14;

export interface AgentStatus {
  state: 'idle' | 'working' | 'waiting';
  activity: string | null;
  since: number | null;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  shape: number;
  /** One of AGENT_COLORS; typed loosely because the registry is a file. */
  color: string;
  isMain: boolean;
  pinned: boolean;
  hidden: boolean;
  sessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
  preview: string | null;
  unread: number;
  /** Approval cards still waiting on the user, including ones the agent paused on. */
  pendingApprovals: number;
  /** `--model`; null is Claude Code's default. */
  model: string | null;
  status: AgentStatus;
}

export interface AgentsOverview {
  agents: Agent[];
  engineReady: boolean;
}

export type MessageKind = 'user' | 'agent' | 'sent_to_agent' | 'from_agent' | 'approval' | 'error';

export interface AgentRef {
  id: string;
  name: string;
}

export interface Approval {
  requestId: string;
  title: string;
  detail: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  tool?: string;
  input?: unknown;
}

export interface AgentMessage {
  id: string;
  agentId: string;
  ts: number;
  kind: MessageKind;
  text: string;
  peer?: AgentRef;
  approval?: Approval;
}

export interface NewAgentInput {
  name: string;
  shape?: number;
  color?: string;
  role?: string;
  instructions?: string;
  model?: string;
}

export interface UpdateAgentInput {
  name?: string;
  shape?: number;
  color?: string;
  role?: string;
  instructions?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** An alias from AGENT_MODELS, or '' for Claude Code's default. */
  model?: string;
}

/**
 * The models an agent can run on: Claude Code's own `--model` aliases, which
 * always mean the current model of that family. Must match `MODELS` in store.rs.
 */
export const AGENT_MODELS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
] as const;

export function modelLabel(model: string | null): string {
  return AGENT_MODELS.find((m) => m.value === (model ?? ''))?.label ?? model ?? 'Default';
}

export interface SearchHit {
  agentId: string;
  agentName: string;
  agentColor: string;
  messageId: string;
  ts: number;
  kind: MessageKind;
  peerName?: string;
  /** Text around the first match, on one line, with … where cut. */
  snippet: string;
}

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Turns that reported a cost; costUsd is complete only when this equals turns. */
  pricedTurns: number;
  durationMs: number;
}

export interface UsageSummary {
  week: UsageTotals;
  allTime: UsageTotals;
}

export const AGENT_EVENTS = {
  message: 'agents://message',
  status: 'agents://status',
  registry: 'agents://registry',
} as const;

export const getAgentsOverview = () => invoke<AgentsOverview>('agents_overview');
export const getAgentMessages = (agentId: string, limit?: number) =>
  invoke<AgentMessage[]>('agents_messages', { agentId, limit });
export const sendAgentMessage = (agentId: string, text: string) =>
  invoke<AgentMessage>('agents_send', { agentId, text });
export const createAgent = (input: NewAgentInput) =>
  invoke<Omit<Agent, 'status'>>('agents_create', { input });
export const updateAgent = (agentId: string, input: UpdateAgentInput) =>
  invoke<Omit<Agent, 'status'>>('agents_update', { agentId, input });
export const getAgentInstructions = (agentId: string) =>
  invoke<string>('agents_instructions', { agentId });
export const deleteAgent = (agentId: string) => invoke<void>('agents_delete', { agentId });
export const stopAgent = (agentId: string) => invoke<boolean>('agents_stop', { agentId });
export const answerApproval = (agentId: string, requestId: string, allow: boolean) =>
  invoke<void>('agents_answer_approval', { agentId, requestId, allow });
export const focusAgent = (agentId: string | null) => invoke<void>('agents_focus', { agentId });
export const markAgentUnread = (agentId: string) => invoke<void>('agents_mark_unread', { agentId });
export const getImportPrompt = () => invoke<string>('agents_import_prompt');
export const searchAgents = (query: string) => invoke<SearchHit[]>('agents_search', { query });
export const getAgentUsage = (agentId: string) => invoke<UsageSummary>('agents_usage', { agentId });

/** Hits grouped by agent, groups in the order their newest hit appears. */
export function groupHits(hits: SearchHit[]): { agentId: string; hits: SearchHit[] }[] {
  const groups = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.agentId);
    if (group) group.push(hit);
    else groups.set(hit.agentId, [hit]);
  }
  return [...groups].map(([agentId, group]) => ({ agentId, hits: group }));
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * "$0.42 · 38k tokens · 6 turns · 4 min", from what Claude Code reported.
 * The cost is left out unless every turn reported one: a partial sum would
 * read as the whole. Null when there were no turns.
 */
export function formatUsage(totals: UsageTotals): string | null {
  if (totals.turns === 0) return null;
  const tokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const parts = [
    `${compact(tokens)} tokens`,
    `${totals.turns} ${totals.turns === 1 ? 'turn' : 'turns'}`,
  ];
  if (totals.durationMs > 0) parts.push(duration(totals.durationMs));
  if (totals.pricedTurns === totals.turns) {
    parts.unshift(totals.costUsd < 0.01 ? '<$0.01' : `$${totals.costUsd.toFixed(2)}`);
  }
  return parts.join(' · ');
}

/** Who said a hit's line, when it wasn't the agent itself. */
export function hitSpeaker(hit: SearchHit): string | null {
  if (hit.kind === 'user') return 'You';
  if (hit.kind === 'sent_to_agent') return hit.peerName ? `To ${hit.peerName}` : null;
  if (hit.kind === 'from_agent') return hit.peerName ?? null;
  return null;
}

/** "2:01 PM" today, "Nov 2" this year, "Nov 2, 2025" before. */
export function formatHitTime(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

/**
 * Split text into plain and matching runs for highlighting: every
 * case-insensitive occurrence of any query word is a match.
 */
export function highlightRuns(text: string, query: string): { text: string; match: boolean }[] {
  const words = query
    .split(/\s+/)
    .filter(Boolean)
    // Longest first, so "invoice" wins over "in" at the same spot.
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return [{ text, match: false }];
  // With one capturing group, split puts the matches at the odd indices.
  return text
    .split(new RegExp(`(${words.join('|')})`, 'gi'))
    .map((part, i) => ({ text: part, match: i % 2 === 1 }))
    .filter((run) => run.text.length > 0);
}

/**
 * Sidebar order: pinned first, then most recently active. The Chief of Staff
 * sorts like everyone else, as it does in Grok Bot; it's identified by its
 * avatar and name, not by being nailed to the top.
 */
export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActivityAt - a.lastActivityAt;
  });
}

/** A run of consecutive agent-to-agent lines with the same peer collapses into one row. */
export type ChatItem =
  | { type: 'message'; message: AgentMessage }
  | { type: 'peer-group'; peer: AgentRef; messages: AgentMessage[] }
  | { type: 'day'; ts: number };

const isPeerLine = (m: AgentMessage) => m.kind === 'sent_to_agent' || m.kind === 'from_agent';

/** Gap after which the chat prints a time divider, as Grok Bot does. */
const DIVIDER_GAP_MS = 45 * 60 * 1000;

export function buildChatItems(messages: AgentMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  let lastTs = 0;
  for (const message of messages) {
    if (items.length === 0 || message.ts - lastTs > DIVIDER_GAP_MS) {
      items.push({ type: 'day', ts: message.ts });
    }
    lastTs = message.ts;
    const previous = items[items.length - 1];
    if (isPeerLine(message) && message.peer) {
      if (previous?.type === 'peer-group' && previous.peer.id === message.peer.id) {
        previous.messages.push(message);
        continue;
      }
      items.push({ type: 'peer-group', peer: message.peer, messages: [message] });
      continue;
    }
    items.push({ type: 'message', message });
  }
  return items;
}

/** "Today 2:01 PM", "Yesterday 9:12 AM", "Mon, Nov 2 4:00 PM". */
export function formatDivider(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (ts >= startOfToday.getTime()) return `Today ${time}`;
  if (ts >= startOfToday.getTime() - dayMs) return `Yesterday ${time}`;
  const day = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${day} ${time}`;
}

/** The centred line for a collapsed run of agent-to-agent messages. */
export function peerGroupLabel(messages: AgentMessage[]): string {
  if (messages.length > 1) return `${messages.length} messages with`;
  return messages[0].kind === 'sent_to_agent' ? 'Messaged' : 'Message from';
}
