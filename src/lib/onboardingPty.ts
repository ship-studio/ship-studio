/**
 * Minimal PTY client for onboarding/connect/install terminals.
 *
 * Replaces the npm `tauri-pty` client for OnboardingTerminal because that
 * client structurally swallows failures (the root of the "Starting..."
 * forever bug class):
 *   - `spawn()` returns synchronously; a backend spawn error (binary missing,
 *     PTY open failure) rejects an internal promise nobody can observe.
 *   - its read loop treats ANY listener throw or read error as fatal and
 *     exits silently — output freezes with no signal to the UI.
 *   - if the `exitstatus` invoke rejects, `onExit` never fires — the modal
 *     hangs open with no way to auto-advance.
 *
 * This client talks to the same vendored Rust plugin (`plugin:pty|*`) with
 * inverted guarantees: spawn REJECTS on failure, listener throws can never
 * kill the read loop, transient read errors are retried, and exactly one
 * exit event always fires unless the caller itself killed the session.
 *
 * @module lib/onboardingPty
 */

import { invoke } from '@tauri-apps/api/core';
import { logger } from './logger';
import type { PtyChunk } from './terminalDiagnostics';

/** Options for {@link spawnOnboardingPty}. */
export interface OnboardingPtyOptions {
  cwd: string;
  cols: number;
  rows: number;
  /** Full replacement environment (the plugin does not merge with the app's). */
  env: Record<string, string>;
}

/** A disposable event subscription (parity with tauri-pty/xterm). */
export interface Disposable {
  dispose(): void;
}

/** Handle to a live onboarding PTY session. */
export interface OnboardingPty {
  /** Raw output chunks. Listener errors are logged, never fatal. */
  onData(listener: (data: PtyChunk) => void): Disposable;
  /**
   * Process exit. Fires exactly once — with the real exit code when the
   * backend reports one, or `1` if the session died in a way the backend
   * couldn't report (so callers can never hang waiting). Does not fire when
   * the caller itself called {@link kill}.
   */
  onExit(listener: (event: { exitCode: number | null }) => void): Disposable;
  /**
   * Output-stream failure after retries (rare). The process may still be
   * running; callers should tell the user instead of freezing silently.
   */
  onStreamError(listener: (message: string) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** Consecutive read failures tolerated (with backoff) before giving up. */
const MAX_READ_RETRIES = 3;
/** Delay between read retries. */
const READ_RETRY_DELAY_MS = 100;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function addListener<T>(listeners: Set<T>, listener: T): Disposable {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

/**
 * Spawn a command in a backend PTY. Rejects with the backend's error when the
 * spawn fails (e.g. "Failed to start `gh`: No such file or directory") — the
 * caller can show a real message instead of a terminal that never speaks.
 */
export async function spawnOnboardingPty(
  file: string,
  args: string[],
  options: OnboardingPtyOptions
): Promise<OnboardingPty> {
  // Throws on backend failure — this await is the entire point.
  const pid = await invoke<number>('plugin:pty|spawn', {
    file,
    args,
    termName: 'Terminal',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
    encoding: null,
    handleFlowControl: null,
    flowControlPause: null,
    flowControlResume: null,
  });

  const dataListeners = new Set<(data: PtyChunk) => void>();
  const exitListeners = new Set<(event: { exitCode: number | null }) => void>();
  const streamErrorListeners = new Set<(message: string) => void>();
  let killed = false;
  let exitFired = false;

  const fireExit = (exitCode: number | null) => {
    if (exitFired || killed) return;
    exitFired = true;
    for (const listener of exitListeners) {
      try {
        listener({ exitCode });
      } catch (err) {
        logger.warn('[onboardingPty] onExit listener threw', { error: String(err) });
      }
    }
  };

  const readLoop = async () => {
    let consecutiveErrors = 0;
    for (;;) {
      if (killed || exitFired) return;
      let data: PtyChunk | null | undefined;
      try {
        data = await invoke<PtyChunk>('plugin:pty|read', { pid });
      } catch (err) {
        const message = String(err);
        // Backend signals EOF when the child exits or the session is gone.
        if (message.includes('EOF')) return;
        consecutiveErrors += 1;
        if (consecutiveErrors <= MAX_READ_RETRIES) {
          await delay(READ_RETRY_DELAY_MS * consecutiveErrors);
          continue;
        }
        logger.error('[onboardingPty] read loop failed after retries', { pid, error: message });
        for (const listener of streamErrorListeners) {
          try {
            listener(message);
          } catch {
            // Listener errors must never propagate.
          }
        }
        return;
      }
      consecutiveErrors = 0;
      // A null/undefined chunk means a broken bridge (or a test mock) — treat
      // as end-of-stream rather than spinning on empty reads.
      if (data == null) return;
      for (const listener of dataListeners) {
        try {
          listener(data);
        } catch (err) {
          // A listener throw must NEVER kill the read loop (the v0.13.2
          // frozen-terminal bug was exactly this, inside tauri-pty).
          logger.warn('[onboardingPty] onData listener threw', { error: String(err) });
        }
      }
    }
  };

  const waitLoop = async () => {
    try {
      const exitCode = await invoke<number>('plugin:pty|exitstatus', { pid });
      fireExit(exitCode);
    } catch (err) {
      // The backend couldn't report an exit status (session torn down in a
      // race, IPC failure). Callers must still get an exit event — a hung
      // "Cancel"-only modal is worse than a generic failure code.
      if (!killed) {
        logger.warn('[onboardingPty] exitstatus failed — reporting generic failure', {
          pid,
          error: String(err),
        });
      }
      fireExit(1);
    }
  };

  void readLoop();
  void waitLoop();

  return {
    onData: (listener) => addListener(dataListeners, listener),
    onExit: (listener) => addListener(exitListeners, listener),
    onStreamError: (listener) => addListener(streamErrorListeners, listener),
    write: (data: string) => {
      invoke('plugin:pty|write', { pid, data }).catch((err: unknown) => {
        logger.warn('[onboardingPty] write failed', { pid, error: String(err) });
      });
    },
    resize: (cols: number, rows: number) => {
      invoke('plugin:pty|resize', { pid, cols, rows }).catch((err: unknown) => {
        logger.warn('[onboardingPty] resize failed', { pid, error: String(err) });
      });
    },
    kill: () => {
      killed = true;
      invoke('plugin:pty|kill', { pid }).catch(() => {
        // Session already gone — that's the goal.
      });
    },
  };
}
