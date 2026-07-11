/**
 * runPtyToExit — spawn a PTY-backed process and wait for it to exit,
 * surfacing the tail of its output when it fails.
 *
 * Hardened against two failure modes the old inline implementation had
 * (issue #163 import-crash forensics):
 *
 * 1. **Unhandled listener-registration rejection**: `listen()` promises were
 *    fired-and-forgotten with no `.catch`, so a registration failure became
 *    an unhandled rejection and the wait hung forever. Registration is now
 *    awaited; failures reject the returned promise.
 * 2. **Fast-exit race**: listeners were registered *after* the process was
 *    spawned, so a fast-failing process could emit `pty-exit` before anyone
 *    was listening — hanging the import with no error. Listeners are now
 *    registered before spawning, and events are buffered per PTY id until the
 *    id is known.
 *
 * @module lib/ptyRun
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { spawnPty } from './project';
import { getWindowLabel } from './window';

/** Options forwarded to the backend `spawn_pty` command. */
export interface PtyRunOptions {
  cwd: string;
  command: string;
  args: string[];
  rows: number;
  cols: number;
}

/** Minimal shape of `listen` used here (injectable for tests). */
type ListenLike = <T>(
  event: string,
  handler: (event: { payload: T }) => void
) => Promise<UnlistenFn>;

/** Injectable seams for tests. Production callers omit this. */
export interface PtyRunDeps {
  spawn?: (options: PtyRunOptions, windowLabel: string) => Promise<number>;
  listenFn?: ListenLike;
  windowLabel?: string;
}

/** Rolling window of output lines kept per PTY for failure messages. */
const MAX_OUTPUT_LINES = 30;

/**
 * Spawn a PTY process and resolve when it exits with code 0 (or null —
 * terminated without a code, matching prior behavior). Rejects with the exit
 * code and the last {@link MAX_OUTPUT_LINES} lines of output on failure.
 */
export async function runPtyToExit(options: PtyRunOptions, deps: PtyRunDeps = {}): Promise<void> {
  const spawn = deps.spawn ?? spawnPty;
  const listenFn = deps.listenFn ?? (listen as ListenLike);
  const windowLabel = deps.windowLabel ?? getWindowLabel();

  // Events are buffered per PTY id because the target id isn't known until
  // spawn resolves — but the process may emit before that.
  const outputById = new Map<number, string[]>();
  const exitById = new Map<number, number | null>();
  let targetId: number | null = null;
  let settled = false;
  let settle: { resolve: () => void; reject: (err: Error) => void } | null = null;

  const maybeSettle = () => {
    if (settled || targetId === null || !settle) return;
    if (!exitById.has(targetId)) return;
    settled = true;
    const code = exitById.get(targetId) ?? null;
    if (code === 0 || code === null) {
      settle.resolve();
    } else {
      const output = (outputById.get(targetId) ?? []).join('\n').trim();
      const msg = output
        ? `Process exited with code ${code}\n\n${output}`
        : `Process exited with code ${code}`;
      settle.reject(new Error(msg));
    }
  };

  let unlistenOutput: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;
  try {
    // Register listeners BEFORE spawning so a fast-failing process can't
    // emit its exit event into the void.
    unlistenOutput = await listenFn<{ id: number; data: string }>('pty-output', (event) => {
      const lines = event.payload.data.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length === 0) return;
      const buffer = outputById.get(event.payload.id) ?? [];
      for (const line of lines) {
        buffer.push(line);
        if (buffer.length > MAX_OUTPUT_LINES) buffer.shift();
      }
      outputById.set(event.payload.id, buffer);
    });
    unlistenExit = await listenFn<{ id: number; code: number | null }>('pty-exit', (event) => {
      exitById.set(event.payload.id, event.payload.code);
      maybeSettle();
    });

    targetId = await spawn(options, windowLabel);

    await new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
      // The exit event may already have been buffered (fast-failing process).
      maybeSettle();
    });
  } finally {
    unlistenOutput?.();
    unlistenExit?.();
  }
}
