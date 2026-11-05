/**
 * Every request the phone can make, with its params and result.
 *
 * Each `agents.*` method is the Tauri command of the same name
 * (`agents.answerApproval` → `agents_answer_approval`) and takes the same
 * arguments, so the server is a thin router onto `src-tauri/src/commands/agents.rs`.
 * Where a method differs from its command, the comment says how and why.
 */

import type { Cursor } from './frames';
import type {
  AgentMessage,
  AgentSecret,
  AgentsOverview,
  CheckIn,
  Device,
  FileDiff,
  ImportSummary,
  MacStatus,
  MemoryChange,
  MemoryView,
  PasteImportPreview,
  ProjectSummary,
  PushEnvironment,
  PushStatus,
  SchedulePreview,
  SearchHit,
  SessionScreen,
  SharedFile,
  StoredAgent,
  NewAgentInput,
  UpdateAgentInput,
  UsageSummary,
} from './model';

/** A file uploaded with `PUT /v1/blobs`, referenced by id. Replaces a desktop path. */
export interface BlobRef {
  blobId: string;
  name: string;
  mime: string;
  size: number;
}

export interface Methods {
  // ---- The Mac and this device ------------------------------------------
  'system.status': { params: Record<string, never>; result: MacStatus };
  /** This device's own record. Other devices are managed on the Mac only. */
  'devices.self': { params: Record<string, never>; result: Device };
  /** "Forget this Mac" from the phone: revokes this device's token. */
  'devices.unpairSelf': { params: Record<string, never>; result: null };
  /**
   * Hand the Mac this phone's APNs (or FCM) token, or `null` to stop. The Mac
   * registers it with Ship Studio's content-free push relay when its owner
   * has push on, and says where that leaves this phone (docs/push-relay.md).
   * Call on every connect: an unchanged token costs nothing.
   */
  'devices.setPush': {
    params: { token: string | null; environment?: PushEnvironment };
    result: { status: PushStatus };
  };

  // ---- Agents ------------------------------------------------------------
  'agents.overview': { params: Record<string, never>; result: AgentsOverview };
  /**
   * `agents_messages`, plus `before` for scrollback (a message id: the page
   * ending just before it). `asOf` is the event cursor at the moment of the
   * read; see "Events, cursors and resync" in docs/mobile.md for why the
   * merge needs it.
   */
  'agents.messages': {
    params: { agentId: string; limit?: number; before?: string };
    result: { messages: AgentMessage[]; asOf: Cursor; more: boolean };
  };
  /**
   * `agents_send`. Attachments are uploaded first and passed by blob id.
   * `clientId` is required: a send retried after a reconnect with the same
   * `clientId` returns the original message instead of sending twice.
   * Text gets Remote Access's refusal rules (no control characters, no
   * leading `!`, `/` commands from the allowlist only, 20k characters).
   * The message it returns, and its `agents.message` event, carry the same
   * `clientId`, so the phone swaps its optimistic bubble by id.
   */
  'agents.send': {
    params: {
      agentId: string;
      text: string;
      clientId: string;
      attachments?: { blobId: string }[];
      mentions?: string[];
    };
    result: AgentMessage;
  };
  'agents.stop': { params: { agentId: string }; result: boolean };
  'agents.interrupt': { params: { agentId: string }; result: boolean };
  /** `choice`: on a session's question (`approval.prompt`), the option picked, by index. */
  'agents.answerApproval': {
    params: {
      agentId: string;
      requestId: string;
      allow: boolean;
      always?: boolean;
      note?: string;
      choice?: number;
    };
    result: null;
  };
  /**
   * `agents_save_secret`: a secure input card's values, one per field, into
   * the Mac's Keychain. Only over the Tailscale route (TLS end to end); the
   * audit line names the secret, never a value, and a malformed request is
   * refused without echoing what it carried.
   */
  'agents.saveSecret': {
    params: { agentId: string; requestId: string; values: string[] };
    result: AgentSecret;
  };
  /** `agents_memory`: the agent's `## Memory` entries. */
  'agents.memory': { params: { agentId: string }; result: MemoryView };
  /** `agents_memory_change`: add, edit or delete one entry. */
  'agents.memoryChange': {
    params: { agentId: string; change: MemoryChange };
    result: MemoryView;
  };
  /** `agents_memory_suggest`: "Remember this", the message as one line to edit. */
  'agents.memorySuggest': { params: { text: string }; result: string };
  'agents.revokePermission': { params: { agentId: string; ruleId: string }; result: null };
  /**
   * `agents_focus`, scoped to this device instead of a window. Sent when a
   * chat is on screen with the app in the foreground, and `null` on leaving
   * it. The server also clears it when the connection drops.
   */
  'agents.focus': { params: { agentId: string | null }; result: null };
  'agents.markUnread': { params: { agentId: string }; result: null };
  'agents.create': { params: { input: NewAgentInput }; result: StoredAgent };
  /**
   * From the phone, only the row's toggles (`pinned`, `muted`, `hidden`)
   * and `instructions` (at most 20,000 characters); any other field is
   * refused with `bad_params`. The name, role, model and project stay the desk's.
   */
  'agents.update': { params: { agentId: string; input: UpdateAgentInput }; result: StoredAgent };
  /** The phone asks for confirmation first; the server asks nothing further. */
  'agents.delete': { params: { agentId: string }; result: null };
  'agents.instructions': { params: { agentId: string }; result: string };
  'agents.usage': { params: { agentId: string }; result: UsageSummary };
  'agents.files': { params: { agentId: string }; result: SharedFile[] };
  'agents.changeDiff': {
    params: { agentId: string; messageId: string; path: string };
    result: FileDiff;
  };
  /**
   * The phone's stand-in for `agents_open_path` (which opens Finder on the
   * Mac): a path written in an agent's reply, made downloadable. Only paths
   * `files::shareable` accepts for that agent; folders and apps are refused.
   */
  'agents.fetchPath': { params: { agentId: string; path: string }; result: BlobRef };
  'agents.search': { params: { query: string }; result: SearchHit[] };

  'agents.schedule.preview': { params: { when: string }; result: SchedulePreview };
  'agents.schedule.create': {
    params: { agentId: string; when: string; note: string };
    result: CheckIn;
  };
  'agents.schedule.update': {
    params: { agentId: string; id: string; when: string; note: string };
    result: CheckIn;
  };
  'agents.schedule.pause': {
    params: { agentId: string; id: string; paused: boolean };
    result: null;
  };
  'agents.schedule.cancel': { params: { agentId: string; id: string }; result: null };
  'agents.schedule.runNow': { params: { agentId: string; id: string }; result: null };

  'agents.import.pastePrompt': { params: Record<string, never>; result: string };
  'agents.import.pastePreview': { params: { text: string }; result: PasteImportPreview };
  'agents.import.paste': { params: { text: string }; result: ImportSummary };

  // ---- Projects and their sessions (Remote Access's handlers) -------------
  'projects.list': { params: Record<string, never>; result: ProjectSummary[] };
  'sessions.read': { params: { sessionId: string }; result: SessionScreen };
  /**
   * Type into an agent tab: the same handler and refusals as Remote Access's
   * `message_agent` (agent tabs only, never shells). Returns once delivered;
   * progress arrives as `projects.changed` events.
   */
  'sessions.send': {
    params: { project: string; sessionId?: string; text: string; clientId: string };
    result: { sessionId: string };
  };
  /** Answer a menu: `press_key`'s rules (a digit only while a question shows). */
  'sessions.key': { params: { sessionId: string; key: string }; result: null };
  /** Remote Access's `start_agent`: a new agent tab that opens on `prompt`. Idempotent by `clientId`. */
  'sessions.start': {
    params: { project: string; prompt: string; clientId: string };
    result: { sessionId: string };
  };
  /** The project's live preview, captured for this phone alone as a private blob. */
  'preview.screenshot': {
    params: { project: string; device: 'desktop' | 'phone' };
    result: BlobRef;
  };
}

export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M]['params'];
export type Result<M extends MethodName> = Methods[M]['result'];

/** Methods that only read. Not written to the audit log, as in Remote Access. */
export const READ_ONLY_METHODS = [
  'system.status',
  'devices.self',
  'agents.overview',
  'agents.messages',
  'agents.instructions',
  'agents.memory',
  'agents.memorySuggest',
  'agents.usage',
  'agents.files',
  'agents.changeDiff',
  'agents.search',
  'agents.schedule.preview',
  'agents.import.pastePrompt',
  'agents.import.pastePreview',
  'projects.list',
  'sessions.read',
] as const satisfies readonly MethodName[];
