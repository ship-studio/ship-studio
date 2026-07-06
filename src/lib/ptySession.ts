/**
 * Frontend client for backend-owned PTY sessions.
 *
 * The Rust registry in `src-tauri/src/commands/pty_session.rs` is the
 * authority for every agent/terminal tab's PTY. A React component calls
 * `openPtySession` on first spawn, then `attachPtySession` on every mount
 * (including cross-project switches) to get the buffered tail and
 * subscribe to live data/exit events. Unmount just calls the returned
 * `unsubscribe` — it does **not** kill the PTY. Kill is explicit via
 * `killPtySession` from the close-tab handler.
 *
 * Events routed through Tauri's event bus — this file is the single place
 * that knows the event names, so components never listen by string.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { logger } from './logger';
import { asCommandError, formatCommandError } from './errors';

export interface OpenPtySessionArgs {
  /** Stable id for this PTY session. Usually the tab's `sessionId` UUID
   *  so re-opens are idempotent and attach-by-id works across remounts. */
  sessionId: string;
  command: string;
  args: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  cols: number;
  rows: number;
  projectPath?: string | null;
  tabSessionId?: string | null;
}

export interface OpenPtySessionResult {
  sessionId: string;
  pid: number;
}

export interface AttachPtySessionResult {
  /** Buffered output (raw bytes). xterm should `write()` this to restore
   *  the visible scrollback. */
  buffer: Uint8Array;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  /** Cumulative byte offset at snapshot time (total bytes the PTY ever
   *  produced). Live data events with `offset < endOffset` are already
   *  contained in `buffer` and must be dropped — see `createAttachGate`. */
  endOffset: number;
}

export interface PtySessionListItem {
  sessionId: string;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  projectPath: string | null;
  tabSessionId: string | null;
  createdAtMs: number;
}

interface DataEventPayload {
  sessionId: string;
  data: number[];
  /** Cumulative byte offset of this chunk's first byte (total bytes the
   *  PTY produced before it). Compare against an attach snapshot's
   *  `endOffset` to drop chunks the snapshot already covers. */
  offset: number;
}

interface ExitEventPayload {
  sessionId: string;
  exitCode: number;
}

/** Open (or reuse, if still alive) a PTY session on the backend. */
export async function openPtySession(args: OpenPtySessionArgs): Promise<OpenPtySessionResult> {
  return invoke<OpenPtySessionResult>('pty_session_open', {
    sessionId: args.sessionId,
    command: args.command,
    args: args.args,
    cwd: args.cwd ?? null,
    env: args.env ?? {},
    cols: args.cols,
    rows: args.rows,
    projectPath: args.projectPath ?? null,
    tabSessionId: args.tabSessionId ?? null,
  });
}

/** Write bytes to a session's PTY. Rejects on failure — awaiting callers
 *  see the error. Fire-and-forget input paths (keystrokes) should use
 *  {@link writePtySessionLogged} instead so failures don't vanish. */
export async function writePtySession(sessionId: string, data: string): Promise<void> {
  const encoder = new TextEncoder();
  const bytes = Array.from(encoder.encode(data));
  await invoke('pty_session_write', { sessionId, data: bytes });
}

/** Fire-and-forget variant of {@link writePtySession} for input paths where
 *  nothing awaits the write (keystrokes, injected prompts). A rejected
 *  write means the input was silently dropped (#167) — log it so there's a
 *  trace. Deliberately no toast: one per lost keystroke would spam. */
export function writePtySessionLogged(sessionId: string, data: string): void {
  writePtySession(sessionId, data).catch((err: unknown) => {
    logger.warn('[ptySession] write failed — input dropped', {
      sessionId,
      length: data.length,
      error: formatCommandError(asCommandError(err)),
    });
  });
}

/** Resize the PTY backing a session. */
export async function resizePtySession(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  await invoke('pty_session_resize', { sessionId, cols, rows });
}

/** Kill a session's PTY and drop its registry entry. Idempotent. */
export async function killPtySession(sessionId: string): Promise<void> {
  await invoke('pty_session_kill', { sessionId });
}

/** Fetch the session's buffered tail + liveness. Called on mount to replay
 *  recent output. Subscribe to the live data stream BEFORE calling this and
 *  gate the events with `createAttachGate(...)` + the returned `endOffset`
 *  so no chunk emitted around the snapshot is lost or double-written. */
export async function attachPtySession(sessionId: string): Promise<AttachPtySessionResult> {
  const raw = await invoke<{
    buffer: number[];
    pid: number;
    alive: boolean;
    exitCode: number | null;
    endOffset: number;
  }>('pty_session_attach', { sessionId });
  return {
    buffer: new Uint8Array(raw.buffer),
    pid: raw.pid,
    alive: raw.alive,
    exitCode: raw.exitCode,
    endOffset: raw.endOffset,
  };
}

/** Notify the backend that the frontend has detached from this session. */
export async function detachPtySession(sessionId: string): Promise<void> {
  await invoke('pty_session_detach', { sessionId });
}

/** Enumerate known sessions, optionally filtered by project path. */
export async function listPtySessions(projectPath?: string | null): Promise<PtySessionListItem[]> {
  return invoke<PtySessionListItem[]>('pty_session_list', {
    projectPath: projectPath ?? null,
  });
}

/**
 * Subscribe to live data chunks for a specific session. Returns an async
 * unlisten fn. The callback receives raw bytes — hand them to xterm's
 * `write(Uint8Array)` — plus the chunk's cumulative start offset for
 * de-duplication against an attach snapshot (see `createAttachGate`).
 */
export async function onPtySessionData(
  sessionId: string,
  handler: (bytes: Uint8Array, offset: number) => void
): Promise<UnlistenFn> {
  return listen<DataEventPayload>('pty-session-data', (event) => {
    if (event.payload.sessionId !== sessionId) return;
    handler(new Uint8Array(event.payload.data), event.payload.offset);
  });
}

/**
 * Subscribe to the exit event for a specific session. Callback receives
 * the exit code as reported by `child.wait()` (0 = clean, >0 = error,
 * -1 = unknown/terminated).
 */
export async function onPtySessionExit(
  sessionId: string,
  handler: (exitCode: number) => void
): Promise<UnlistenFn> {
  return listen<ExitEventPayload>('pty-session-exit', (event) => {
    if (event.payload.sessionId !== sessionId) return;
    handler(event.payload.exitCode);
  });
}

/**
 * De-duplication gate for the subscribe-first attach protocol.
 *
 * Tauri drops events that fire while no listener is registered, so a
 * component must subscribe to `onPtySessionData` BEFORE calling
 * `attachPtySession` — otherwise a chunk emitted between the snapshot and
 * the subscription is lost forever (a single-paint TUI then looks dead:
 * issue #156). Subscribing first inverts the problem into duplication:
 * chunks that arrive before/around the snapshot may already be inside the
 * snapshot buffer. This gate resolves it exactly, using the backend's
 * cumulative byte offsets:
 *
 * - `push(offset, bytes)` — feed every live event through. Before the
 *   snapshot end is known, chunks are queued. Afterwards, a chunk is
 *   delivered iff `offset >= endOffset` (the backend guarantees a chunk
 *   never straddles the snapshot boundary).
 * - `open(endOffset)` — call after writing the snapshot. Flushes the queue
 *   in arrival order, dropping chunks the snapshot already covers.
 */
export interface AttachGate {
  push(offset: number, bytes: Uint8Array): void;
  open(endOffset: number): void;
}

export function createAttachGate(deliver: (bytes: Uint8Array) => void): AttachGate {
  let snapshotEnd: number | null = null;
  const pending: Array<{ offset: number; bytes: Uint8Array }> = [];
  return {
    push(offset: number, bytes: Uint8Array): void {
      if (snapshotEnd === null) {
        pending.push({ offset, bytes });
        return;
      }
      if (offset >= snapshotEnd) deliver(bytes);
    },
    open(endOffset: number): void {
      if (snapshotEnd !== null) return; // already open — ignore
      snapshotEnd = endOffset;
      for (const chunk of pending) {
        if (chunk.offset >= endOffset) deliver(chunk.bytes);
      }
      pending.length = 0;
    },
  };
}
