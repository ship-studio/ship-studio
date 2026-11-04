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
}

export interface UpdateAgentInput {
  name?: string;
  shape?: number;
  color?: string;
  role?: string;
  instructions?: string;
  pinned?: boolean;
  hidden?: boolean;
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
