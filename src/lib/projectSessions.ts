/**
 * Tauri wrappers for the backend project session lifecycle commands.
 *
 * The backend (`src-tauri/src/commands/projects/sessions.rs`) is the
 * authority on which projects have a live session and where. The frontend
 * `SessionRegistry` mirrors this state for UI rendering — both are kept in
 * sync by calling these wrappers from `handleSelectProject` /
 * `handleBackToProjects` / etc.
 *
 * Backend invariant: `registerProjectSession` rejects with a
 * `Validation` `CommandError` if the project already has a session under
 * a different window label.
 *
 * @module lib/projectSessions
 */

import { invoke } from '@tauri-apps/api/core';
import { logger } from './logger';
import { asCommandError, formatCommandError } from './errors';

/** Mirror of the backend `SessionStatus` enum. */
export type BackendSessionStatus = 'active' | 'suspended';

/** Mirror of `ProjectSessionInfo` returned by the backend. */
export interface ProjectSessionInfo {
  projectPath: string;
  owningWindowLabel: string;
  status: BackendSessionStatus;
  activatedAt: number;
  lastActivityAt: number;
  ptyCount: number;
}

/** Mirror of `SessionMemoryReport` returned by the backend. */
export interface SessionMemoryReport {
  projectPath: string;
  totalBytes: number;
  perPid: Array<{ pid: number; bytes: number }>;
}

/**
 * Register a new active session for a project under the given window.
 *
 * Throws (via Tauri `Validation` error) if the project already has a session
 * owned by a different window. Same-window calls are idempotent and simply
 * bump `last_activity_at` on the backend.
 */
export async function registerProjectSession(
  projectPath: string,
  windowLabel: string
): Promise<void> {
  return invoke('register_project_session', { projectPath, windowLabel });
}

/**
 * Suspend a session: kill its PTYs and mark the registry entry suspended.
 * Returns the number of PTYs killed.
 */
export async function suspendProjectSession(projectPath: string): Promise<number> {
  return invoke<number>('suspend_project_session', { projectPath });
}

/**
 * Fully remove a session from the registry. Kills PTYs first.
 * Distinct from `unpinProject` — callers may want to close a session while
 * leaving the pin in place (so it can be cold-started later).
 * PTY cleanup is handled separately by the existing cleanup flow
 * (stopServer → kill_window_pty → kill_port).
 */
export async function unregisterProjectSession(projectPath: string): Promise<void> {
  return invoke<void>('unregister_project_session', { projectPath });
}

/**
 * Full teardown for an explicitly closed project ("Close project (stops dev
 * server)" in the rail).
 *
 * The frontend's own PTY teardown (`closeAllTerminalsForProject`) can only
 * reach *mounted* `Terminal` components through `terminalRefsMap`. A project
 * closed from the dashboard — or any project whose workspace isn't rendered —
 * has no mounted terminals, so that call is a silent no-op and its agent PTYs
 * keep running after the row is gone. Sweeping the backend PTY registry for
 * the project first makes the close authoritative regardless of what the UI
 * currently has mounted; it targets only PTYs registered under this project
 * path, so it can't touch another session's processes.
 *
 * Suspend failures are non-fatal: unregistering is what actually removes the
 * session, so it always runs.
 *
 * @returns the number of PTYs the backend reaped (0 when the sweep failed).
 */
export async function closeProjectSession(projectPath: string): Promise<number> {
  let killed = 0;
  try {
    killed = await suspendProjectSession(projectPath);
  } catch (err) {
    logger.warn('[closeProjectSession] PTY sweep failed', {
      projectPath,
      error: formatCommandError(asCommandError(err)),
    });
  }
  await unregisterProjectSession(projectPath);
  return killed;
}

/**
 * Bump `last_activity_at` on the backend. Cheap, safe to call frequently
 * (focus events, terminal input, etc.). Drives LRU eviction in Phase 5.
 */
export async function touchProjectSession(projectPath: string): Promise<void> {
  return invoke('touch_project_session', { projectPath });
}

/** Snapshot of all currently registered sessions (active + suspended). */
export async function listProjectSessions(): Promise<ProjectSessionInfo[]> {
  return invoke<ProjectSessionInfo[]>('list_project_sessions');
}

/** Look up a single session by path, or `null` if not registered. */
export async function getProjectSessionInfo(
  projectPath: string
): Promise<ProjectSessionInfo | null> {
  return invoke<ProjectSessionInfo | null>('get_project_session_info', {
    projectPath,
  });
}

/**
 * Count of active (non-suspended) sessions. Used by the rail UI to enforce
 * the soft cap before allowing a new session to spawn.
 */
export async function getActiveSessionCount(): Promise<number> {
  return invoke<number>('get_active_session_count');
}

/** Memory usage breakdown for a project session, in bytes. */
export async function getSessionMemory(projectPath: string): Promise<SessionMemoryReport> {
  return invoke<SessionMemoryReport>('get_session_memory', { projectPath });
}
