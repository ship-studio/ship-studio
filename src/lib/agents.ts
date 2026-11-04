/**
 * Agents — types mirroring `src-tauri/src/agents/` and the invoke wrappers.
 *
 * @module lib/agents
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { FileDiff } from './git';

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
  /** "Always allow" rules; omitted when there are none. */
  permissions?: PermissionRule[];
  status: AgentStatus;
  /** The agent's home folder; attachment paths are relative to it. */
  home: string;
  /** The newest line in its chat is a failed turn; omitted otherwise. */
  failure?: Failure;
  /** The project it works in (a path from `list_projects`); omitted when unbound. */
  project?: string;
}

/** Mirrors `failure::Failure`: what kind of failure a turn ended in. */
export interface Failure {
  kind: 'usage_limit' | 'signed_out' | 'other';
  /** When the usage limit resets (epoch ms), only when Claude Code said so. */
  resetsAt?: number;
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
  | 'check_in'
  /** A quiet line: an automatically allowed call, an interruption, what the Chief did. */
  | 'note'
  /** Files a project-bound agent's turn changed (`changes`). */
  | 'changes';

/** What "Always allow" covers; mirrors `permissions::Scope`. */
export interface PermissionScope {
  kind: 'command_prefix' | 'command' | 'domain' | 'tool';
  value: string;
  /** The value in words: "npm test", "example.com", "Send an email · Gmail". */
  label: string;
}

export interface PermissionRule extends PermissionScope {
  id: string;
  createdAt: number;
}

/** What a rule lets through, before its value: "Commands starting with". A tool's label says it all. */
export const SCOPE_KIND_LABEL: Record<PermissionScope['kind'], string> = {
  command_prefix: 'Commands starting with',
  command: 'Exactly',
  domain: 'Web pages on',
  tool: '',
};

/** The tooltip on "Always allow": exactly what will stop asking. */
export function describeScope(scope: PermissionScope, agentName: string): string {
  const what =
    scope.kind === 'command_prefix'
      ? `Any command starting with “${scope.label}”`
      : scope.kind === 'command'
        ? `Exactly “${scope.label}”`
        : scope.kind === 'domain'
          ? `Opening pages on ${scope.label}`
          : `“${scope.label}”`;
  const chained = scope.kind.startsWith('command')
    ? ' Commands chained with &&, ; or | still ask.'
    : '';
  return `${what} runs for ${agentName} without asking.${chained} Revoke it in Edit agent → Permissions.`;
}

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
  /** What "Always allow" would cover; only on cards that may offer it. */
  always?: PermissionScope;
  /** Allowed by an "Always allow" rule rather than once. */
  alwaysAllowed?: boolean;
  /** What you told the agent when you declined. */
  note?: string;
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
  /** On an `error` line: what kind of failure. Absent on lines written before. */
  failure?: Failure;
  /** On a `changes` line: what the turn changed in the project. */
  changes?: ChangeSummary;
}

/** Mirrors `project::ChangedFile`: line counts are absent for a binary file. */
export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added?: number;
  removed?: number;
}

/** Mirrors `project::ChangeSummary`, read from git when the turn ended. */
export interface ChangeSummary {
  project: string;
  /** Absent when HEAD was detached. */
  branch?: string;
  from: string;
  to: string;
  /** At most 50; `fileCount` counts them all. */
  files: ChangedFile[];
  fileCount: number;
  added: number;
  removed: number;
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
  /** A project path from `list_projects`. */
  project?: string;
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
  /** A project path from `list_projects`, or '' to unbind it. */
  project?: string;
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
/** Open an attachment in its default app, or with `reveal`, show it in Finder. */
export const openAttachment = (agentId: string, path: string, reveal = false) =>
  invoke<void>('agents_open_attachment', { agentId, path, reveal });

/** One row of a conversation's Files list; mirrors `files::SharedFile`. */
export interface SharedFile extends Attachment {
  messageId: string;
  ts: number;
  from: 'user' | 'agent';
}

/** Everything shared in a conversation, both ways, newest first. */
export const getAgentFiles = (agentId: string) => invoke<SharedFile[]>('agents_files', { agentId });

/**
 * A path from an agent's reply. Documents open in their default app; folders,
 * apps and scripts are only shown in Finder. Resolves to what was done.
 */
export const openLocalPath = (agentId: string, path: string, reveal = false) =>
  invoke<'open' | 'reveal'>('agents_open_path', { agentId, path, reveal });

/**
 * The local path a link in agent prose points at, or null for a web link.
 * `~/x`, `/x`, `file:///x` and a bare relative `report.md` (relative to the
 * agent's folder) all count; anything with a scheme other than file: doesn't.
 */
export function localPathFromHref(href: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null;
  if (/^file:/i.test(href)) href = href.replace(/^file:(\/\/)?/i, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/**
 * Where a path written out in prose starts: `~/` or one of the roots people
 * actually keep files under. Kept narrow on purpose: `/careers` in a reply is
 * a URL route, not a file, and "and/or" is not a path.
 */
const PATH_ROOT = /(?:~|\/(?:Users|Volumes|private|tmp|var|opt|Applications|Library))\//.source;
const PATH_BODY = /[^\s<>()[\]`'"]*[^\s<>()[\]`'".,;:!?]/.source;

/** A path anywhere in running text. */
export const PROSE_PATH = new RegExp(PATH_ROOT + PATH_BODY);

/** Inline code that is nothing but a path. */
const CODE_PATH = new RegExp(`^${PATH_ROOT}[^\\n<>\`"]+$`);
export const isCodePath = (text: string) => CODE_PATH.test(text.trim());

export type FilesFilter = 'all' | 'user' | 'agent';

export const filterFiles = (files: SharedFile[], filter: FilesFilter) =>
  filter === 'all' ? files : files.filter((f) => f.from === filter);

export const createAgent = (input: NewAgentInput) =>
  invoke<Omit<Agent, 'status' | 'home'>>('agents_create', { input });
export const updateAgent = (agentId: string, input: UpdateAgentInput) =>
  invoke<Omit<Agent, 'status' | 'home'>>('agents_update', { agentId, input });
export const getAgentInstructions = (agentId: string) =>
  invoke<string>('agents_instructions', { agentId });
/** One file of a change card, as this turn changed it. */
export const getChangeDiff = (agentId: string, messageId: string, path: string) =>
  invoke<FileDiff>('agents_change_diff', { agentId, messageId, path });
export const deleteAgent = (agentId: string) => invoke<void>('agents_delete', { agentId });
export const stopAgent = (agentId: string) => invoke<boolean>('agents_stop', { agentId });
export const answerApproval = (
  agentId: string,
  requestId: string,
  allow: boolean,
  always = false,
  note?: string
) =>
  invoke<void>('agents_answer_approval', {
    agentId,
    requestId,
    allow,
    always: always || undefined,
    note: note?.trim() || undefined,
  });
/** Stop the turn in progress so what's queued sends now. */
export const interruptAgent = (agentId: string) => invoke<boolean>('agents_interrupt', { agentId });
export const revokePermission = (agentId: string, ruleId: string) =>
  invoke<void>('agents_revoke_permission', { agentId, ruleId });
export const focusAgent = (agentId: string | null) => invoke<void>('agents_focus', { agentId });
export const markAgentUnread = (agentId: string) => invoke<void>('agents_mark_unread', { agentId });
export const getImportPrompt = () => invoke<string>('agents_import_prompt');

/** One agent a pasted reply would import (see `agents/paste.rs`). */
export interface PasteImportAgent {
  name: string;
  role: string;
  isMain: boolean;
  /** An agent with this name already exists and will be updated. */
  existing: boolean;
  instructionsChars: number;
  memoryLines: number;
}

/** What importing a pasted reply would do. Any problem blocks the import. */
export interface PasteImportPreview {
  source: string;
  blocks: number;
  agents: PasteImportAgent[];
  problems: string[];
}

export interface ImportSummary {
  created: string[];
  updated: string[];
  /** `[name, why]` */
  skipped: [string, string][];
}

export const getPasteImportPrompt = () => invoke<string>('agents_import_paste_prompt');
export const previewPasteImport = (text: string) =>
  invoke<PasteImportPreview>('agents_import_paste_preview', { text });
export const importPaste = (text: string) => invoke<ImportSummary>('agents_import_paste', { text });
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

/**
 * A hit's snippet cut to start a few words before its first match, so the
 * match survives a two-line clamp. The backend leads with more context than
 * a narrow sidebar can show.
 */
export function snippetAround(snippet: string, query: string, lead = 14): string {
  const runs = highlightRuns(snippet, query);
  const first = runs.findIndex((r) => r.match);
  if (first < 0) return snippet;
  const at = runs.slice(0, first).reduce((n, r) => n + r.text.length, 0);
  if (at <= lead + 1) return snippet;
  // Start at a word boundary inside the lead, so no word is cut in half.
  const space = snippet.indexOf(' ', at - lead);
  const start = space >= 0 && space < at ? space + 1 : at;
  return `…${snippet.slice(start).replace(/^…/, '')}`;
}

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
 * is created pinned (it's the one agent you're told to talk to, so it
 * shouldn't move under you), but it's an ordinary pin: unpin it and it sorts
 * by recency like everyone else.
 */
export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActivityAt - a.lastActivityAt;
  });
}

/**
 * A message of yours the agent hasn't read yet: sent after the turn in
 * progress began, so it is queued for the next one.
 */
export function isQueued(message: AgentMessage, agent: Agent): boolean {
  const { state, since } = agent.status;
  return message.kind === 'user' && state !== 'idle' && since != null && message.ts > since;
}

/** Waiting on you: mid-turn on a card, or paused with one still open. */
export function needsYou(agent: Agent): boolean {
  return agent.status.state === 'waiting' || (agent.pendingApprovals ?? 0) > 0;
}

/** Its last turn failed, and nothing has been said since. Not while it works again. */
export function failedTurn(agent: Agent): Failure | null {
  return agent.failure && agent.status.state === 'idle' ? agent.failure : null;
}

/** Needs you, or its last turn didn't finish: what the "next needing you" key visits. */
export const needsAttention = (agent: Agent) => needsYou(agent) || failedTurn(agent) !== null;

/** The text of a failure's first clause: "Didn't finish: Couldn't start Claude Code". */
export function failureLine(failure: Failure, preview: string | null): string {
  if (failure.kind === 'usage_limit') {
    return failure.resetsAt
      ? `Usage limit · resets ${formatClock(failure.resetsAt)}`
      : 'Usage limit reached';
  }
  if (failure.kind === 'signed_out') return 'Claude Code is signed out';
  const clause = (preview ?? '').split(/(?<=[.!?:])\s/)[0].replace(/[.:]$/, '');
  return clause ? `Didn’t finish: ${clause}` : 'Didn’t finish';
}

/**
 * An agent's state as another chat shows it, beside its name on a
 * delegation line. `failed` is only said when its newest line is known and is
 * an error; otherwise an idle agent is idle.
 */
export type PeerState =
  | { kind: 'working'; label: string }
  | { kind: 'waiting'; label: string }
  | { kind: 'failed'; label: string }
  | { kind: 'idle'; label: string };

export function peerState(agent: Agent, lastLine?: AgentMessage | null): PeerState {
  if (needsYou(agent)) return { kind: 'waiting', label: 'needs your OK' };
  if (agent.status.state === 'working') {
    const activity = agent.status.activity?.trim();
    return { kind: 'working', label: activity ? lowerFirst(activity) : 'working' };
  }
  if (failedTurn(agent) || lastLine?.kind === 'error')
    return { kind: 'failed', label: "didn't finish" };
  return { kind: 'idle', label: 'idle' };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The newest line that says how an agent's last turn went (not a note or card). */
export function lastOutcome(messages: AgentMessage[] | undefined): AgentMessage | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const kind = messages[i].kind;
    if (kind !== 'note' && kind !== 'changes') return messages[i];
  }
  return null;
}

/**
 * The brief this agent is working on: while a turn runs, the newest
 * agent-to-agent group that arrived before the turn began, if nothing of
 * yours came after it. Its first line's id, or null.
 */
export function drivingBriefId(items: ChatItem[], agent: Agent): string | null {
  const { state, since } = agent.status;
  if (state === 'idle' || since == null) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === 'day') continue;
    if (item.type === 'message') {
      if (item.message.ts > since || item.message.kind === 'note') continue;
      return null;
    }
    const last = item.messages[item.messages.length - 1];
    if (last.ts > since) continue;
    return last.kind === 'from_agent' ? item.messages[0].id : null;
  }
  return null;
}

/**
 * The newest line where this agent handed work to each peer: the one that
 * shows how that work is going. Lines that only brought work in carry none.
 */
export function newestPeerGroups(items: ChatItem[]): Set<string> {
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type !== 'peer-group' || seen.has(item.peer.id)) continue;
    if (!item.messages.some((m) => m.kind === 'sent_to_agent')) continue;
    seen.add(item.peer.id);
    ids.add(item.messages[0].id);
  }
  return ids;
}

/** "acme" from "/Users/me/ShipStudio/acme/". */
export const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path;

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
 * What a failed turn's one next step is. The backend tags new lines; older
 * ones are matched on Claude Code's own wordings and on the app's classified
 * message (commands/ai.rs), never on a bare "sign in", which turns up in
 * ordinary prose.
 */
export function errorRemedy(message: Pick<AgentMessage, 'text' | 'failure'>): 'sign-in' | null {
  if (message.failure) return message.failure.kind === 'signed_out' ? 'sign-in' : null;
  const lower = message.text.toLowerCase();
  return /isn't signed in anymore|please run \/login|oauth token has expired|invalid api key|not logged in|session expired/.test(
    lower
  )
    ? 'sign-in'
    : null;
}

/** The last thing you sent before `index`, words and files, to send again. */
export function lastUserMessage(messages: AgentMessage[], index: number): AgentMessage | null {
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind !== 'user') continue;
    return m.text.trim() || m.attachments?.length ? m : null;
  }
  return null;
}

/** A message's files as `agents_send` takes them: copied again from the agent's home. */
export const resendable = (agent: Agent, message: AgentMessage): OutgoingAttachment[] =>
  (message.attachments ?? []).map((a) => ({ name: a.name, path: `${agent.home}/${a.path}` }));

/** A check-in's note is capped (`MAX_NOTE_CHARS` in schedule.rs). */
const RETRY_NOTE_MAX = 560;

/** What a "Retry at <reset>" check-in tells the agent when it fires. */
export function retryNote(text: string): string {
  const ask = text.trim();
  const head = 'Claude Code’s usage limit has reset. Carry on with what I asked';
  if (!ask) return `${head}.`;
  const room = RETRY_NOTE_MAX - head.length - 4;
  return `${head}: “${ask.length > room ? `${ask.slice(0, room - 1)}…` : ask}”`;
}

/** `agents_schedule_create`'s `when` for a moment: whole minutes from now, rounded up. */
export const whenAt = (ts: number, now = Date.now()) =>
  `in ${Math.max(1, Math.ceil((ts - now) / 60_000))} minutes`;

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
  /** Cards to answer, or the failed turn's line (newest in its chat) to act on. */
  needsYou: { agent: Agent; approvals: AgentMessage[]; failure: AgentMessage | null }[];
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
    needsYou: shown.filter(needsAttention).map((agent) => {
      const lines = messages[agent.id] ?? [];
      const last = lines[lines.length - 1];
      return {
        agent,
        approvals: lines.filter((m) => m.approval?.status === 'pending'),
        failure: failedTurn(agent) && last?.kind === 'error' ? last : null,
      };
    }),
    scheduled,
    replies,
  };
}

/** The Team row's second line: "2 working · 1 needs you · 1 failed", or quiet. */
export function teamSubtitle(agents: Agent[]): string {
  const shown = agents.filter((a) => !a.hidden);
  const waiting = shown.filter(needsYou).length;
  const working = shown.filter((a) => a.status.state === 'working' && !needsYou(a)).length;
  // A usage limit isn't counted: it heals on its own, and its row says so.
  const failed = shown.filter((a) => {
    const failure = failedTurn(a);
    return failure !== null && failure.kind !== 'usage_limit';
  }).length;
  const parts = [
    working > 0 ? `${working} working` : '',
    waiting > 0 ? `${waiting} ${waiting === 1 ? 'needs' : 'need'} you` : '',
    failed > 0 ? `${failed} failed` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nothing in flight';
}
