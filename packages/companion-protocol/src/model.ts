/**
 * The things the Mac and the phone talk about.
 *
 * The agent types are the desktop's own (`src/lib/agents.ts`, which mirrors
 * `src-tauri/src/agents/`), copied here so the Expo app needn't import a file
 * that pulls in Tauri. `desktop-conformance.ts` fails `tsc` if the two copies
 * ever differ; Rust is held to them by the generated fixtures (see docs/mobile.md,
 * "Keeping the types honest").
 *
 * Everything below the agent types is new to the companion.
 */

// ============================================================================
// Agents: identical to src/lib/agents.ts
// ============================================================================

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
  color: string;
  isMain: boolean;
  pinned: boolean;
  hidden: boolean;
  sessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
  preview: string | null;
  unread: number;
  pendingApprovals: number;
  /** What its turns run on; mirrors `engine::Engine`. */
  engine: AgentEngine;
  /** One of its engine's models; null is that engine's default. */
  model: string | null;
  /** What its routines run on; omitted when automatic. */
  routineModel?: string;
  muted: boolean;
  checkIns?: CheckIn[];
  permissions?: PermissionRule[];
  status: AgentStatus;
  /** The agent's home on the Mac. Only meaningful as a base for `Attachment.path`. */
  home: string;
  failure?: Failure;
  project?: string;
  capabilities?: Capabilities;
  /** Secrets it has in the Keychain (names only); omitted when none. */
  secrets?: AgentSecret[];
}

export interface Failure {
  kind: 'usage_limit' | 'signed_out' | 'other';
  resetsAt?: number;
}

export type Repeat =
  | { kind: 'days'; days: number[]; hour: number; minute: number }
  | { kind: 'every'; minutes: number };

export interface CheckIn {
  id: string;
  note: string;
  repeat?: Repeat;
  nextAt: number;
  createdAt: number;
  paused: boolean;
  /** Its last runs, oldest first; omitted before the first. */
  runs?: CheckInRun[];
  /** A failed run waiting to be tried again. */
  retry?: CheckInRetry;
}

/** One scheduled run and what came of it; mirrors `runs::Run`. */
export interface CheckInRun {
  at: number;
  outcome: 'running' | 'ran' | 'retrying' | 'failed' | 'unknown';
  /** 1 for the run itself, 2 for its first retry. */
  attempt: number;
  /** Why it failed, as the chat said it. */
  detail?: string;
  retryAt?: number;
  /** Connectors Claude Code said need signing in again. */
  signIn?: string[];
  /** Run now, from the popover. */
  manual?: boolean;
}

/** Mirrors `runs::Retry`. */
export interface CheckInRetry {
  at: number;
  attempts: number;
  firstFailedAt: number;
  dueAt: number;
}

export interface CheckInMark {
  dueAt: number;
  late: boolean;
  repeats: boolean;
  manual?: boolean;
}

export interface SchedulePreview {
  nextAt: number;
  repeat: Repeat | null;
}

export type AgentEngine = 'claude' | 'codex';

export interface ModelChoice {
  value: string;
  label: string;
}

/** Mirrors `engine::EngineInfo`: an engine an agent can run on, as found on this Mac. */
export interface EngineInfo {
  id: AgentEngine;
  label: string;
  installed: boolean;
  signedIn: boolean;
  /** The engine's own models, without Default. */
  models: ModelChoice[];
}

export interface AgentsOverview {
  agents: Agent[];
  /** Claude Code is installed (the default engine). */
  engineReady: boolean;
  engines: EngineInfo[];
}

export type MessageKind =
  | 'user'
  | 'agent'
  | 'sent_to_agent'
  | 'from_agent'
  | 'approval'
  | 'error'
  | 'check_in'
  | 'note'
  | 'changes'
  | 'session';

export interface SessionMark {
  project: string;
  event: 'started' | 'sent' | 'reply' | 'screenshot';
  sessionId?: string;
  tab?: number;
  cli?: string;
}

export interface Capabilities {
  seenAt: number;
  lines: { what: string; detail: string }[];
}

export interface PermissionScope {
  kind: 'command_prefix' | 'command' | 'domain' | 'tool';
  value: string;
  label: string;
}

export interface PermissionRule extends PermissionScope {
  id: string;
  createdAt: number;
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
  always?: PermissionScope;
  alwaysAllowed?: boolean;
  note?: string;
  /** A secure input card: what the agent asked for. */
  secret?: SecretRequest;
  /** A question a project session is waiting on, answered with keys sent to it. */
  prompt?: SessionPrompt;
  /** The option picked on a `prompt` card. */
  choice?: string;
}

/** One answer a session's question offers, as the session shows it. */
export interface PromptOption {
  label: string;
  keys: string[];
  role: 'allow' | 'deny' | 'other';
}

/**
 * A question a project session can't answer itself (folder trust, a
 * permission prompt, a menu). The same card sits in every chat in `chats`;
 * answering it in one answers it in all.
 */
export interface SessionPrompt {
  kind: 'trust' | 'permission' | 'choice';
  project: string;
  sessionId: string;
  tab: number;
  question: string;
  options: PromptOption[];
  owner: AgentRef;
  chats: string[];
}

// Secrets: identical to src/lib/agentSecrets.ts. A value is never part of
// any of these; only names, purposes and variable names travel.

export type SecretKind = 'password' | 'api_key' | 'token' | 'other';

export interface SecretField {
  label: string;
  env: string;
}

export interface SecretRequest {
  name: string;
  purpose: string;
  kind: SecretKind;
  fields: SecretField[];
  reference: string;
}

export interface AgentSecret extends SecretRequest {
  id: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface AgentMessage {
  id: string;
  agentId: string;
  ts: number;
  kind: MessageKind;
  text: string;
  peer?: AgentRef;
  approval?: Approval;
  attachments?: Attachment[];
  checkIn?: CheckInMark;
  stopped?: boolean;
  mentions?: AgentRef[];
  failure?: Failure;
  changes?: ChangeSummary;
  session?: SessionMark;
  /**
   * On a user message sent from a phone: the `clientId` its `agents.send`
   * carried, so the phone's optimistic bubble is replaced by id, not by text.
   * Absent on everything else; older clients ignore it.
   */
  clientId?: string;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added?: number;
  removed?: number;
}

export interface ChangeSummary {
  project: string;
  branch?: string;
  from: string;
  to: string;
  files: ChangedFile[];
  fileCount: number;
  added: number;
  removed: number;
}

export interface Attachment {
  name: string;
  /** Relative to the agent's home: `attachments/<message id>/<name>`. */
  path: string;
  mime: string;
  size: number;
}

export interface SharedFile extends Attachment {
  messageId: string;
  ts: number;
  from: 'user' | 'agent';
}

export interface NewAgentInput {
  name: string;
  shape?: number;
  color?: string;
  role?: string;
  instructions?: string;
  engine?: AgentEngine;
  model?: string;
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
  engine?: AgentEngine;
  model?: string;
  routineModel?: string;
  project?: string;
}

/** What `agents.create` / `agents.update` return: the stored agent, no live state. */
export type StoredAgent = Omit<Agent, 'status' | 'home'>;

export interface SearchHit {
  agentId: string;
  agentName: string;
  agentColor: string;
  messageId: string;
  ts: number;
  kind: MessageKind;
  peerName?: string;
  snippet: string;
}

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  pricedTurns: number;
  durationMs: number;
}

export interface UsageSummary {
  week: UsageTotals;
  allTime: UsageTotals;
}

export interface PasteImportAgent {
  name: string;
  role: string;
  isMain: boolean;
  existing: boolean;
  instructionsChars: number;
  memoryLines: number;
  routines: PasteImportRoutine[];
  color: string | null;
  instructions: string;
  memory: string[];
}

export interface PasteImportRoutine {
  when: string;
  what: string;
  schedule?: string;
  refused?: string;
}

export interface ImportRoutineOutcome {
  agent: string;
  when: string;
  what: string;
  detail: string;
}

export interface PasteImportPreview {
  source: string;
  blocks: number;
  agents: PasteImportAgent[];
  problems: string[];
}

export interface ImportSummary {
  created: string[];
  updated: string[];
  skipped: [string, string][];
  routinesSet: ImportRoutineOutcome[];
  routinesRefused: ImportRoutineOutcome[];
}

// Memory: identical to src/lib/agents.ts (`memory::Entry`, `memory::Change`).

export interface MemoryEntry {
  text: string;
  /** The `###` heading it sits under. */
  group?: string;
}

export interface MemoryView {
  entries: MemoryEntry[];
  /** The exact lines a delete removed, for Undo. */
  removed?: string;
}

export type MemoryChange =
  | {
      op: 'add';
      text: string;
      group?: string;
      after?: string;
      before?: string;
      raw?: string;
    }
  | { op: 'edit'; index: number; original: string; text: string }
  | { op: 'delete'; index: number; original: string };

/** Mirrors `crate::types::FileDiff` (src/lib/git.ts). */
export interface FileDiff {
  filePath: string;
  isNewFile: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  content: string;
  additions: number;
  deletions: number;
}

/** Must match `MAX_FILES` / `MAX_FILE_BYTES` in agents/attachments.rs. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// ============================================================================
// Projects and sessions: structured forms of Remote Access's project tools
// ============================================================================

/** Read off a session's screen by `remote_access/agent_state.rs`. */
export type SessionState = 'working' | 'needs_decision' | 'finished' | 'exited';

/** A numbered-menu prompt on a session's screen, as `agent_state` parsed it. */
export interface SessionQuestion {
  question: string;
  /** What the agent wants to do, when the screen shows it (the command). */
  action?: string;
  /** In screen order; `key` is what `sessions.key` presses to choose it. */
  options: { key: string; label: string; highlighted: boolean }[];
}

export interface SessionSummary {
  /** The backend PTY session id. */
  sessionId: string;
  /** Its number among the project's tabs ("Claude Code 1"). */
  tab: number;
  /** Agent CLI id (`claude`, `codex`, `opencode`); absent for a plain terminal. */
  cli?: string;
  state: SessionState;
  /** The spinner line, while working ("Stewing… (4s)"). */
  activity?: string;
  question?: SessionQuestion;
  lastOutputAt: number;
}

export interface ProjectSummary {
  path: string;
  name: string;
  branch?: string;
  /** Uncommitted changes, as `git status` counts them. */
  dirtyFiles: number;
  /** Agent tabs first; anything waiting on the user first among those. */
  sessions: SessionSummary[];
}

export interface SessionScreen {
  session: SessionSummary;
  /** The rendered screen and scrollback (vt100), plain text. */
  screen: string;
  /** The agent's latest reply, without the input box and spinner lines. */
  reply?: string;
}

// ============================================================================
// The Mac, the connection, and paired devices
// ============================================================================

/** Three-valued on purpose: "we couldn't tell" is never shown as yes or no. */
export type Known = 'yes' | 'no' | 'unknown';

export interface MacStatus {
  /** The Mac's name, as the user sees it in System Settings. */
  name: string;
  appVersion: string;
  /** Mirrors `remote_access::power`: what keeps it awake, and its battery. */
  power: {
    keepAwake: boolean;
    lidClosedMode: Known;
    onBattery: Known;
    batteryPercent?: number;
  };
  claude: {
    installed: boolean;
    /** From the same check onboarding uses (`claude_auth_truth`), cached 60 s. */
    signedIn: Known;
    version?: string;
  };
  /** Every way this Mac can be reached right now (the phone learns new ones from this). */
  routes: Route[];
}

export type RouteKind = 'tailscale' | 'lan';

export interface Route {
  kind: RouteKind;
  /** `https://mac.tailnet.ts.net:47443` or `https://192.168.1.20:47444`. */
  url: string;
  /** LAN only: SHA-256 of the Mac's certificate public key (SPKI), base64url. */
  pin?: string;
}

export type DevicePlatform = 'ios' | 'android';

export interface Device {
  id: string;
  name: string;
  platform: DevicePlatform;
  model?: string;
  appVersion: string;
  /** How it was built: the official app, or one built on this Mac (a fork). */
  build: 'official' | 'self';
  pairedAt: number;
  lastSeenAt?: number;
  lastRoute?: RouteKind;
  /** Has a live connection now. */
  connected: boolean;
  /** Free-Apple-ID builds stop opening at this time; reinstall before. Epoch ms. */
  expiresAt?: number;
}

/** Which APNs a token belongs to. TestFlight and the App Store are production. */
export type PushEnvironment = 'production' | 'development';

/**
 * Whether this phone will get pushes, as the Mac sees it (`devices.setPush`).
 * - `on`: the relay has it; pushes arrive while the app isn't in front.
 * - `pending`: saved, but the relay wasn't reachable yet; retried on the next alert.
 * - `off`: push is off on the Mac.
 * - `unavailable`: the Mac's build has no push service.
 * - `self_build`: a self-built app gets no push entitlement from Apple.
 */
export type PushStatus = 'on' | 'pending' | 'off' | 'unavailable' | 'self_build';

/** A notification the Mac decided this device should show (see `Notifier`). */
export interface Alert {
  agentId: string;
  /** The message it's about, so tapping opens the chat there. */
  messageId?: string;
  title: string;
  body: string;
  kind: 'reply' | 'approval' | 'error' | 'check_in';
}
