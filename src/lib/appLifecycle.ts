/**
 * App-level lifecycle: making sure the open project session is closed out
 * when the app quits.
 *
 * This module used to emit window focus/blur, idle and quit events as well.
 * Those told us when the window was in front, not which features people use,
 * so they were removed. What remains is the one thing quitting has to do for
 * analytics: flush `project_session_ended` so the session's duration lands.
 *
 * @module lib/appLifecycle
 */

import { exit } from '@tauri-apps/plugin-process';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { trackEvent } from './analytics';
import { endProjectSession } from './session';
import { logger } from './logger';

/**
 * Window we hold the close open for so the analytics IPC + Rust HTTP
 * request can leave the box. There's no flush handle from PostHog's
 * fire-and-forget send, so this is empirical.
 */
const QUIT_FLUSH_DELAY_MS = 200;

let installed = false;
let sessionFlushed = false;
let quitInProgress = false;

/**
 * Install the quit handler. Idempotent — calling more than once is a
 * no-op. Returns a cleanup function for tests/HMR.
 */
export function installAppLifecycleTracking(): () => void {
  if (installed) return () => {};
  installed = true;

  // Tauri-level: OS-initiated close (cmd+Q, red traffic light, alt+f4).
  // We preventDefault, flush the session, wait briefly for the IPC + HTTP
  // send to leave the box, then exit(0) — destroy() is blocked by ACL and
  // we want to terminate the whole process anyway.
  let unlistenClose: (() => void) | null = null;
  // Cleanup may run before the listener-registration promise resolves
  // (StrictMode mount→unmount→remount). Track a cancellation flag so a
  // late-resolving promise unregisters itself rather than leaking the
  // listener past the cleanup boundary.
  let cleanupRan = false;
  void getCurrentWindow()
    .onCloseRequested((event) => {
      if (quitInProgress) return;
      quitInProgress = true;
      event.preventDefault();
      void (async () => {
        flushProjectSession();
        await new Promise((resolve) => setTimeout(resolve, QUIT_FLUSH_DELAY_MS));
        try {
          await exit(0);
        } catch (err) {
          logger.warn('[appLifecycle] exit failed', { error: String(err) });
        }
      })();
    })
    .then((fn) => {
      if (cleanupRan) {
        // Provider already torn down; immediately unregister.
        fn();
        return;
      }
      unlistenClose = fn;
    })
    .catch((err) =>
      logger.warn('[appLifecycle] onCloseRequested listener failed', { error: String(err) })
    );

  return () => {
    cleanupRan = true;
    if (unlistenClose) unlistenClose();
    installed = false;
  };
}

/**
 * Fire any pending `project_session_ended` exactly once. The Tauri
 * close-requested handler and the explicit quit-button paths both call this
 * — the guard makes a duplicate call (user confirms quit, then the OS sends
 * close-requested) safe.
 */
function flushProjectSession(): void {
  if (sessionFlushed) return;
  sessionFlushed = true;

  const ended = endProjectSession();
  if (ended) {
    void trackEvent('project_session_ended', {
      project_session_id: ended.session_id,
      duration_seconds: ended.duration_seconds,
      reason: 'app_quit',
    });
  }
}

/**
 * Programmatic quit. Flushes the project session, gives the analytics
 * request a moment to leave, then terminates the process.
 *
 * Use this instead of calling `exit(0)` directly from UI code so the
 * session duration is recorded.
 */
export async function quitAppWithTracking(): Promise<void> {
  if (quitInProgress) return;
  quitInProgress = true;
  flushProjectSession();
  // Same flush window the OS-close path uses.
  await new Promise((resolve) => setTimeout(resolve, QUIT_FLUSH_DELAY_MS));
  await exit(0);
}
