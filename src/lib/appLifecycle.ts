/**
 * App-level lifecycle analytics: window focus/blur, idle detection, quit.
 *
 * Wires into Tauri's window events and DOM activity events so PostHog has a
 * clean picture of when users are *actively* using the app vs. having it
 * sitting in the background.
 *
 * @module lib/appLifecycle
 */

import { exit } from '@tauri-apps/plugin-process';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { trackEvent } from './analytics';
import { endProjectSession } from './session';
import { logger } from './logger';

/** Fire `app_idle_detected` after this many ms of no user input. */
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Window we hold the close open for so the analytics IPC + Rust HTTP
 * request can leave the box. There's no flush handle from PostHog's
 * fire-and-forget send, so this is empirical.
 */
const QUIT_FLUSH_DELAY_MS = 200;

let installed = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let isIdle = false;
// Use document.hasFocus() — the app may have launched backgrounded, in which
// case the first blur would otherwise record focus_duration since module load.
let isFocused = typeof document !== 'undefined' ? document.hasFocus() : true;
let lastFocusedAt = Date.now();
let appQuitFired = false;
let quitInProgress = false;

/**
 * Install lifecycle listeners. Idempotent — calling more than once is a
 * no-op. Returns a cleanup function for tests/HMR.
 */
export function installAppLifecycleTracking(): () => void {
  if (installed) return () => {};
  installed = true;

  const onActivity = () => {
    if (isIdle) {
      isIdle = false;
      void trackEvent('app_idle_resumed');
    }
    resetIdleTimer();
  };

  const onFocus = () => {
    if (!isFocused) {
      isFocused = true;
      lastFocusedAt = Date.now();
      void trackEvent('app_window_focused');
      onActivity();
    }
  };

  const onBlur = () => {
    if (isFocused) {
      isFocused = false;
      void trackEvent('app_window_blurred', {
        focus_duration_ms: Date.now() - lastFocusedAt,
      });
    }
  };

  // DOM-level signals — covers in-app activity and tab switches.
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  window.addEventListener('mousemove', onActivity, { passive: true });
  window.addEventListener('keydown', onActivity);
  window.addEventListener('scroll', onActivity, { passive: true });
  window.addEventListener('touchstart', onActivity, { passive: true });

  // Tauri-level: OS-initiated close (cmd+Q, red traffic light, alt+f4).
  // We preventDefault, fire events, wait briefly for the IPC + HTTP send
  // to leave the box, then exit(0) — destroy() is blocked by ACL and
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
        fireAppQuit('os_close');
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

  resetIdleTimer();

  return () => {
    cleanupRan = true;
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('mousemove', onActivity);
    window.removeEventListener('keydown', onActivity);
    window.removeEventListener('scroll', onActivity);
    window.removeEventListener('touchstart', onActivity);
    if (unlistenClose) unlistenClose();
    if (idleTimer) clearTimeout(idleTimer);
    installed = false;
  };
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    isIdle = true;
    void trackEvent('app_idle_detected', { threshold_ms: IDLE_THRESHOLD_MS });
  }, IDLE_THRESHOLD_MS);
}

/**
 * Fire `app_quit` plus any pending project_session_ended exactly once.
 * The Tauri close-requested handler and the explicit quit-button paths
 * both call this — the `appQuitFired` guard makes a duplicate call
 * (e.g. user confirms quit, then OS sends close-requested) safe.
 */
function fireAppQuit(reason: 'os_close' | 'user_action'): void {
  if (appQuitFired) return;
  appQuitFired = true;

  // Flush any open project session so the duration lands.
  const ended = endProjectSession();
  if (ended) {
    void trackEvent('project_session_ended', {
      project_session_id: ended.session_id,
      duration_seconds: ended.duration_seconds,
      reason: 'app_quit',
    });
  }

  void trackEvent('app_quit', { reason });
}

/**
 * Programmatic quit. Fires app_quit, gives the analytics request a moment
 * to flush, then terminates the process.
 *
 * Use this instead of calling `exit(0)` directly from UI code so the
 * quit reason is recorded.
 */
export async function quitAppWithTracking(): Promise<void> {
  if (quitInProgress) return;
  quitInProgress = true;
  fireAppQuit('user_action');
  // Same flush window the OS-close path uses.
  await new Promise((resolve) => setTimeout(resolve, QUIT_FLUSH_DELAY_MS));
  await exit(0);
}
