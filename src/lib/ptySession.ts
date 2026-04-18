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
  /** Buffered output (raw bytes). xterm should `write()` this before
   *  subscribing to live data so the replay + live feed don't overlap. */
  buffer: Uint8Array;
  pid: number;
  alive: boolean;
  exitCode: number | null;
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

/** Write bytes to a session's PTY. */
export async function writePtySession(sessionId: string, data: string): Promise<void> {
  const encoder = new TextEncoder();
  const bytes = Array.from(encoder.encode(data));
  await invoke('pty_session_write', { sessionId, data: bytes });
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
 *  recent output before subscribing to the live data stream. */
export async function attachPtySession(sessionId: string): Promise<AttachPtySessionResult> {
  const raw = await invoke<{
    buffer: number[];
    pid: number;
    alive: boolean;
    exitCode: number | null;
  }>('pty_session_attach', { sessionId });
  return {
    buffer: new Uint8Array(raw.buffer),
    pid: raw.pid,
    alive: raw.alive,
    exitCode: raw.exitCode,
  };
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
 * `write(Uint8Array)`.
 */
export async function onPtySessionData(
  sessionId: string,
  handler: (bytes: Uint8Array) => void
): Promise<UnlistenFn> {
  return listen<DataEventPayload>('pty-session-data', (event) => {
    if (event.payload.sessionId !== sessionId) return;
    handler(new Uint8Array(event.payload.data));
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
