/**
 * Tests for runPtyToExit — the hardened spawn-and-wait helper used by the
 * import flow (issue #163). Covers the crash/hang classes it fixes:
 * listener-registration failure, the fast-exit race, and output-tail capture.
 */

import { describe, it, expect, vi } from 'vitest';
import { runPtyToExit } from './ptyRun';

type Handler = (event: { payload: unknown }) => void;

/** Fake `listen` that records handlers and lets tests emit events. */
function makeFakeListen() {
  const handlers = new Map<string, Handler>();
  const unlistened: string[] = [];
  const listenFn = vi.fn((event: string, handler: Handler) => {
    handlers.set(event, handler);
    return Promise.resolve(() => {
      unlistened.push(event);
    });
  });
  const emit = (event: string, payload: unknown) => {
    handlers.get(event)?.({ payload });
  };
  return { listenFn: listenFn as never, emit, unlistened };
}

const options = { cwd: '/tmp/x', command: 'gh', args: ['repo', 'clone'], rows: 10, cols: 80 };

describe('runPtyToExit', () => {
  it('resolves when the process exits with code 0', async () => {
    const { listenFn, emit, unlistened } = makeFakeListen();
    const spawn = vi.fn().mockResolvedValue(7);

    const run = runPtyToExit(options, { spawn, listenFn, windowLabel: 'main' });
    // Let spawn resolve and the wait begin.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    emit('pty-exit', { id: 7, code: 0 });

    await expect(run).resolves.toBeUndefined();
    expect(unlistened).toContain('pty-output');
    expect(unlistened).toContain('pty-exit');
  });

  it('rejects with exit code and output tail on failure', async () => {
    const { listenFn, emit } = makeFakeListen();
    const spawn = vi.fn().mockResolvedValue(3);

    const run = runPtyToExit(options, { spawn, listenFn, windowLabel: 'main' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    emit('pty-output', { id: 3, data: 'fatal: repository not found\r\n' });
    emit('pty-exit', { id: 3, code: 128 });

    await expect(run).rejects.toThrow(/exited with code 128[\s\S]*repository not found/);
  });

  it('ignores output and exit events from other PTY ids', async () => {
    const { listenFn, emit } = makeFakeListen();
    const spawn = vi.fn().mockResolvedValue(5);

    const run = runPtyToExit(options, { spawn, listenFn, windowLabel: 'main' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    emit('pty-output', { id: 9, data: 'noise from another terminal\r\n' });
    emit('pty-exit', { id: 9, code: 1 }); // must NOT settle the wait
    emit('pty-exit', { id: 5, code: 2 });

    await expect(run).rejects.toThrow(/exited with code 2(?![\s\S]*noise)/);
  });

  it('settles even when the exit event arrives before the spawn id is known (fast-exit race)', async () => {
    const { listenFn, emit } = makeFakeListen();
    let resolveSpawn: (id: number) => void = () => {};
    const spawn = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveSpawn = resolve;
        })
    );

    const run = runPtyToExit(options, { spawn, listenFn, windowLabel: 'main' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

    // The process fails instantly: exit is emitted before spawn resolves.
    emit('pty-output', { id: 11, data: 'spawn failed\r\n' });
    emit('pty-exit', { id: 11, code: -1 });
    resolveSpawn(11);

    await expect(run).rejects.toThrow(/exited with code -1[\s\S]*spawn failed/);
  });

  it('rejects instead of hanging when listener registration fails', async () => {
    const listenFn = vi.fn().mockRejectedValue(new Error('event system unavailable'));
    const spawn = vi.fn();

    await expect(
      runPtyToExit(options, { spawn, listenFn: listenFn as never, windowLabel: 'main' })
    ).rejects.toThrow('event system unavailable');
    // The process must never be spawned if we can't observe its exit.
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cleans up listeners when spawn itself fails', async () => {
    const { listenFn, unlistened } = makeFakeListen();
    const spawn = vi.fn().mockRejectedValue(new Error('spawn_pty failed: no such cwd'));

    await expect(runPtyToExit(options, { spawn, listenFn, windowLabel: 'main' })).rejects.toThrow(
      'spawn_pty failed'
    );
    expect(unlistened).toContain('pty-output');
    expect(unlistened).toContain('pty-exit');
  });
});
