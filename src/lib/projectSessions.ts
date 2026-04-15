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
