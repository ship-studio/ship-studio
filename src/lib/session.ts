/**
 * Session tracking for analytics.
 *
 * Two session scopes:
 * - **App session** — lives for the entire app process. ID generated at
 *   module load. Used as PostHog's `$session_id` so all events from one
 *   launch group together.
 * - **Project session** — starts when a user opens a project, ends when
 *   they close it or switch to another. Used to compute session length
 *   and per-project engagement.
 *
 * Sessions are stored in memory only — no persistence. Quitting the app
 * ends both implicitly.
 *
 * @module lib/session
 */

const APP_SESSION_ID = crypto.randomUUID();

let projectSessionId: string | null = null;
let projectSessionStart: number | null = null;

/** Stable for the lifetime of this app process. */
export function getAppSessionId(): string {
  return APP_SESSION_ID;
}

/** Current project session ID, or null if no project is open. */
export function getProjectSessionId(): string | null {
  return projectSessionId;
}

/**
 * Start a fresh project session. If one is already active it is silently
 * ended (caller is responsible for firing `project_session_ended` first
 * if they want the previous session's metadata).
 */
export function startProjectSession(): void {
  projectSessionId = crypto.randomUUID();
  projectSessionStart = Date.now();
}

/**
 * End the current project session. Returns metadata for the caller to
 * include in the `project_session_ended` event, or null if no session
 * was active.
 */
export function endProjectSession(): { session_id: string; duration_seconds: number } | null {
  if (!projectSessionId || projectSessionStart === null) return null;
  const duration_seconds = Math.round((Date.now() - projectSessionStart) / 1000);
  const session_id = projectSessionId;
  projectSessionId = null;
  projectSessionStart = null;
  return { session_id, duration_seconds };
}
