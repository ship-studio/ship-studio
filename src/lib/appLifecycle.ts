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

let installed = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let isIdle = false;
let isFocused = true;
let lastFocusedAt = Date.now();
let appQuitFired = false;

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
  // Event payload is ignored; we just want to flush before the window dies.
  let unlistenClose: (() => void) | null = null;
  void getCurrentWindow()
    .onCloseRequested(() => {
      fireAppQuit('os_close');
    })
    .then((fn) => {
      unlistenClose = fn;
    })
    .catch((err) =>
      logger.warn('[appLifecycle] onCloseRequested listener failed', { error: String(err) })
    );

  resetIdleTimer();

  return () => {
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
  fireAppQuit('user_action');
  // Give the fire-and-forget HTTP requests on the Rust side a small window
  // to leave the box. They're async and we don't have a flush handle.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await exit(0);
}
