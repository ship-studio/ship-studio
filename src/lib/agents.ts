/**
 * Agents — types mirroring `src-tauri/src/agents/` and the invoke wrappers.
 *
 * @module lib/agents
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';

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
  /** No OS notifications; unread and the Dock badge still count it. */
  muted: boolean;
  /** Omitted by the backend when there are none. */
  checkIns?: CheckIn[];
  status: AgentStatus;
  /** The agent's home folder; attachment paths are relative to it. */
  home: string;
}

/** How a routine repeats; mirrors `schedule::Repeat`. Days are 0 = Sunday. */
export type Repeat =
  | { kind: 'days'; days: number[]; hour: number; minute: number }
  | { kind: 'every'; minutes: number };

/** A check-in (one-time) or routine (repeats); mirrors `schedule::CheckIn`. */
export interface CheckIn {
  id: string;
  note: string;
  repeat?: Repeat;
  /** When it next fires, epoch ms. */
  nextAt: number;
  createdAt: number;
  paused: boolean;
}

/** On a `check_in` chat line: when it was due and whether it ran late. */
export interface CheckInMark {
  dueAt: number;
  late: boolean;
  repeats: boolean;
}

export interface SchedulePreview {
  nextAt: number;
  /** How it repeats; null for a one-time check-in. */
  repeat: Repeat | null;
}

export interface AgentsOverview {
  agents: Agent[];
  engineReady: boolean;
}

export type MessageKind =
  | 'user'
  | 'agent'
  | 'sent_to_agent'
  | 'from_agent'
  | 'approval'
  | 'error'
  | 'check_in';

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
  /** Files sent with a user message. */
  attachments?: Attachment[];
  checkIn?: CheckInMark;
  /** A reply cut off by Stop: what had streamed by then. */
  stopped?: boolean;
  /** Agents you @mentioned in this message, as they were named then. */
  mentions?: AgentRef[];
}

/** A file sent with a message, as kept in the agent's home. */
export interface Attachment {
  name: string;
  /** Relative to the agent's home: `attachments/<message id>/<name>`. */
  path: string;
  mime: string;
  size: number;
}

/** A file about to be sent: one on disk, or bytes the composer holds (a paste). */
export interface OutgoingAttachment {
  name: string;
  path?: string;
  /** Base64. */
  data?: string;
}

/** What the backend reports for a file before it is attached. */
export interface FileInfo {
  path: string;
  name: string;
  mime: string;
  size: number;
}

/** Must match `MAX_FILES` / `MAX_FILE_BYTES` in agents/attachments.rs. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const isImageMime = (mime: string) => /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(mime);

/** "840 KB", "3.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * A local file as an `<img>` source. Through the asset protocol in the app;
 * under the UI harness the fixtures are served over HTTP, so the path already
 * is a URL (feature-detected, as in `fidelityImageUrl`).
 */
export function localFileUrl(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

export const attachmentUrl = (home: string, attachment: Attachment) =>
  localFileUrl(`${home}/${attachment.path}`);

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
  muted?: boolean;
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
  /** A reply being written: `{ agentId, id, text }`, the text so far. */
  draft: 'agents://draft',
  /** A notification was clicked; payload is the agent id to open. */
  open: 'agents://open',
} as const;

export const getAgentsOverview = () => invoke<AgentsOverview>('agents_overview');
export const getAgentMessages = (agentId: string, limit?: number) =>
  invoke<AgentMessage[]>('agents_messages', { agentId, limit });
export const sendAgentMessage = (
  agentId: string,
  text: string,
  attachments: OutgoingAttachment[] = [],
  mentions: string[] = []
) =>
  invoke<AgentMessage>('agents_send', {
    agentId,
    text,
    attachments: attachments.length ? attachments : undefined,
    mentions: mentions.length ? mentions : undefined,
  });
export const inspectFiles = (paths: string[]) =>
  invoke<FileInfo[]>('agents_inspect_files', { paths });
export const openAttachment = (agentId: string, path: string) =>
  invoke<void>('agents_open_attachment', { agentId, path });
export const createAgent = (input: NewAgentInput) =>
  invoke<Omit<Agent, 'status' | 'home'>>('agents_create', { input });
export const updateAgent = (agentId: string, input: UpdateAgentInput) =>
  invoke<Omit<Agent, 'status' | 'home'>>('agents_update', { agentId, input });
export const getAgentInstructions = (agentId: string) =>
  invoke<string>('agents_instructions', { agentId });
export const deleteAgent = (agentId: string) => invoke<void>('agents_delete', { agentId });
export const stopAgent = (agentId: string) => invoke<boolean>('agents_stop', { agentId });
export const answerApproval = (agentId: string, requestId: string, allow: boolean) =>
  invoke<void>('agents_answer_approval', { agentId, requestId, allow });
export const focusAgent = (agentId: string | null) => invoke<void>('agents_focus', { agentId });
export const markAgentUnread = (agentId: string) => invoke<void>('agents_mark_unread', { agentId });
export const getImportPrompt = () => invoke<string>('agents_import_prompt');
export const previewSchedule = (when: string) =>
  invoke<SchedulePreview>('agents_schedule_preview', { when });
export const createCheckIn = (agentId: string, when: string, note: string) =>
  invoke<CheckIn>('agents_schedule_create', { agentId, when, note });
export const cancelCheckIn = (agentId: string, id: string) =>
  invoke<void>('agents_schedule_cancel', { agentId, id });
export const pauseCheckIn = (agentId: string, id: string, paused: boolean) =>
  invoke<void>('agents_schedule_pause', { agentId, id, paused });

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "9:00 AM" in the user's locale, the same way `formatWhen` writes times. */
const clockText = (hour: number, minute: number) =>
  new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

/** "Every weekday at 9:00 AM", "Every 2 hours" — `schedule::describe`'s words, locale times. */
export function describeRepeat(repeat: Repeat): string {
  if (repeat.kind === 'every') {
    const { minutes } = repeat;
    if (minutes % 60 !== 0) return `Every ${minutes} minutes`;
    return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  }
  const days = [...repeat.days].sort((a, b) => a - b).join(',');
  const named =
    days === '0,1,2,3,4,5,6'
      ? 'day'
      : days === '1,2,3,4,5'
        ? 'weekday'
        : days === '0,6'
          ? 'weekend day'
          : repeat.days
              .map((d) => DAY_NAMES[d % 7])
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1');
  return `Every ${named} at ${clockText(repeat.hour, repeat.minute)}`;
}

/** "Today 9:00 AM", "Tomorrow 9:00 AM", "Thu, Nov 5 9:00 AM". */
export function formatWhen(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const start = today.getTime();
  if (ts >= start && ts < start + dayMs) return `Today ${time}`;
  if (ts >= start + dayMs && ts < start + 2 * dayMs) return `Tomorrow ${time}`;
  const day = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${day} ${time}`;
}

/**
 * The schedule composer takes one line, "when: what" — "every weekday 9am:
 * brief me on Acme". The split is the first colon followed by a space, so
 * clock times ("9:30") stay whole. No such colon yet: it's all "when".
 */
export function splitScheduleInput(text: string): { when: string; note: string } {
  const match = /^(.*?):\s+([\s\S]*)$/.exec(text);
  if (!match) return { when: text.trim().replace(/:$/, ''), note: '' };
  return { when: match[1].trim(), note: match[2].trim() };
}

/** A row's secondary line: when it next runs, and how it repeats. */
export function describeCheckInTime(c: CheckIn, now = Date.now()): string {
  if (!c.repeat) return formatWhen(c.nextAt, now);
  const repeat = describeRepeat(c.repeat);
  if (c.paused) return `Paused · ${repeat}`;
  const next = formatWhen(c.nextAt, now).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase());
  return `${repeat} · next ${next}`;
}

/** Soonest first; paused ones last. */
export function sortCheckIns(checkIns: CheckIn[]): CheckIn[] {
  return [...checkIns].sort((a, b) =>
    a.paused !== b.paused ? (a.paused ? 1 : -1) : a.nextAt - b.nextAt
  );
}

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

/** Waiting on you: mid-turn on a card, or paused with one still open. */
export function needsYou(agent: Agent): boolean {
  return agent.status.state === 'waiting' || (agent.pendingApprovals ?? 0) > 0;
}

/** A run of consecutive agent-to-agent lines with the same peer collapses into one row. */
export type ChatItem =
  | { type: 'message'; message: AgentMessage }
  | { type: 'peer-group'; peer: AgentRef; messages: AgentMessage[] }
  | { type: 'day'; ts: number };

const isPeerLine = (m: AgentMessage) => m.kind === 'sent_to_agent' || m.kind === 'from_agent';

/**
 * A time divider marks a new sitting, not a pause: a new day, or three hours
 * of quiet. Any more often and they become noise between every few lines.
 */
const DIVIDER_GAP_MS = 3 * 60 * 60 * 1000;

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export function buildChatItems(messages: AgentMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  let lastTs = 0;
  for (const message of messages) {
    if (
      items.length === 0 ||
      message.ts - lastTs > DIVIDER_GAP_MS ||
      !sameDay(message.ts, lastTs)
    ) {
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

/** Selected text as a Markdown quote, ready for the composer. */
export function quoteText(text: string): string {
  const lines = text
    .trim()
    .replace(/\n{3,}/g, '\n\n')
    .split('\n');
  return lines.map((line) => (line ? `> ${line}` : '>')).join('\n') + '\n\n';
}

/** What's sent: each quoted passage as a blockquote, then what was typed. */
export function withQuotes(quotes: string[], text: string): string {
  return (quotes.map(quoteText).join('') + text).trim();
}

/** A user message split into its quoted passages and its own words. */
export interface BubblePart {
  kind: 'quote' | 'text';
  text: string;
}

/**
 * Only `>` blockquotes are read out of a user's message; everything else
 * stays the literal text they typed.
 */
export function splitQuotes(text: string): BubblePart[] {
  const parts: BubblePart[] = [];
  let lines: string[] = [];
  let kind: BubblePart['kind'] = 'text';
  const flush = () => {
    const body = lines.join('\n').replace(/^\n+|\n+$/g, '');
    if (body.trim()) parts.push({ kind, text: body });
    lines = [];
  };
  for (const line of text.split('\n')) {
    const quoted = /^>\s?/.test(line);
    const next = quoted ? 'quote' : 'text';
    if (next !== kind) {
      flush();
      kind = next;
    }
    lines.push(quoted ? line.replace(/^>\s?/, '') : line);
  }
  flush();
  return parts;
}

/** "9:24 AM": a message's time, on hover. */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Tuesday, November 4, 2026 at 9:24:13 AM": the exact time, in its tooltip. */
export function formatExactTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' });
}

/**
 * What a failed turn's one next step is. Sign-in is matched on Claude Code's
 * own wordings and on the app's classified message (commands/ai.rs), never
 * on a bare "sign in", which turns up in ordinary prose.
 */
export function errorRemedy(text: string): 'sign-in' | null {
  const lower = text.toLowerCase();
  return /isn't signed in anymore|please run \/login|oauth token has expired|invalid api key|not logged in|session expired/.test(
    lower
  )
    ? 'sign-in'
    : null;
}

/** The words of the last thing you sent before `index`, to send again. */
export function lastUserText(messages: AgentMessage[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].kind === 'user') return messages[i].text.trim() || null;
  }
  return null;
}

/** The longest a name being typed after @ can run before it's just text. */
const MENTION_MAX = 40;

/**
 * The @mention being typed at the caret, if any: an @ at the start or after
 * whitespace, with no line break between it and the caret. Names have
 * spaces ("Acme Site"), so the query may too.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.length > MENTION_MAX || /[\n@]/.test(query) || /^\s/.test(query)) return null;
  return { start: at, query };
}

/** Agents whose name matches what's typed after @: name starts first, then any word. */
export function mentionCandidates(agents: Agent[], query: string): Agent[] {
  const q = query.toLowerCase();
  const starts = (a: Agent) => a.name.toLowerCase().startsWith(q);
  const words = (a: Agent) =>
    a.name
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.startsWith(q));
  return [...agents.filter(starts), ...agents.filter((a) => !starts(a) && words(a))];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An "@Name" for each agent, standing alone (not the start of a longer word). */
function mentionPattern(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const alternatives = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  return new RegExp(`(?<=^|\\s)@(${alternatives})(?![\\w])`, 'gi');
}

/** The agents a message @mentions, in the order they first appear. */
export function mentionedAgents(text: string, agents: Agent[]): Agent[] {
  const pattern = mentionPattern(agents.map((a) => a.name));
  if (!pattern) return [];
  const found: Agent[] = [];
  for (const match of text.matchAll(pattern)) {
    const agent = agents.find((a) => a.name.toLowerCase() === match[1].toLowerCase());
    if (agent && !found.includes(agent)) found.push(agent);
  }
  return found;
}

/** Text split around the @mentions a message recorded, for tinting them. */
export function mentionRuns(
  text: string,
  mentions: AgentRef[] = []
): { text: string; mention?: AgentRef }[] {
  const pattern = mentionPattern(mentions.map((m) => m.name));
  if (!pattern) return [{ text }];
  const runs: { text: string; mention?: AgentRef }[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) runs.push({ text: text.slice(last, index) });
    const mention = mentions.find((m) => m.name.toLowerCase() === match[1].toLowerCase());
    runs.push({ text: match[0], mention });
    last = index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/** The Team overview's place in the selection, beside agent ids. */
export const TEAM_ID = '__team';

/** A reply's first line as plain words, for a one-line row. */
export function replyPreview(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^(```|\||---)/.test(l)) ?? '';
  return line
    .replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`|~~)/g, '');
}

/** What the Team view lists; everything is read from the store, nothing inferred. */
export interface TeamSummary {
  working: Agent[];
  needsYou: { agent: Agent; approvals: AgentMessage[] }[];
  scheduled: { agent: Agent; checkIn: CheckIn }[];
  replies: { agent: Agent; message: AgentMessage }[];
}

export const TEAM_SCHEDULED_MAX = 5;
export const TEAM_REPLIES_MAX = 6;

/**
 * The overview from the agents and whatever chat lines are loaded for them.
 * Hidden agents are left out, as they are from the badge. Paused routines
 * aren't "next", so they're left out too.
 */
export function summarizeTeam(
  agents: Agent[],
  messages: Record<string, AgentMessage[] | undefined>
): TeamSummary {
  const shown = sortAgents(agents.filter((a) => !a.hidden));
  const scheduled = shown
    .flatMap((agent) =>
      (agent.checkIns ?? []).filter((c) => !c.paused).map((checkIn) => ({ agent, checkIn }))
    )
    .sort((a, b) => a.checkIn.nextAt - b.checkIn.nextAt)
    .slice(0, TEAM_SCHEDULED_MAX);
  const replies = shown
    .flatMap((agent) =>
      (messages[agent.id] ?? [])
        .filter((m) => m.kind === 'agent' && m.text.trim())
        .map((message) => ({ agent, message }))
    )
    .sort((a, b) => b.message.ts - a.message.ts)
    .slice(0, TEAM_REPLIES_MAX);
  return {
    working: shown.filter((a) => a.status.state === 'working' && !needsYou(a)),
    needsYou: shown.filter(needsYou).map((agent) => ({
      agent,
      approvals: (messages[agent.id] ?? []).filter((m) => m.approval?.status === 'pending'),
    })),
    scheduled,
    replies,
  };
}

/** The Team row's second line: "2 working · 1 needs you", or quiet. */
export function teamSubtitle(agents: Agent[]): string {
  const shown = agents.filter((a) => !a.hidden);
  const waiting = shown.filter(needsYou).length;
  const working = shown.filter((a) => a.status.state === 'working' && !needsYou(a)).length;
  const parts = [
    working > 0 ? `${working} working` : '',
    waiting > 0 ? `${waiting} ${waiting === 1 ? 'needs' : 'need'} you` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nothing in flight';
}
