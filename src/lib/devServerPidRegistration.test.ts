/**
 * The dev server's PTY must be registered for cleanup under the child's real
 * OS process id — never under tauri-pty's session handler.
 *
 * The handler is an AtomicU32 counter starting at 0, and `kill(2)` reads 0 as
 * "every process in the caller's own process group". Registering a handler
 * therefore made Ship Studio SIGKILL itself on the next teardown, with no
 * crash report and no exit hook to show for it. The Rust side proves
 * `process_id` returns a real pid; these cover the frontend half that asks
 * for it and decides whether to register the answer.
 */

import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackError: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(() => Promise.resolve('/Users/test/')) }));
vi.mock('./setup', () => ({ isWindows: () => false }));
vi.mock('./github', () => ({ detectPackageManager: vi.fn(() => Promise.resolve('npm')) }));
vi.mock('./code', () => ({
  readProjectFile: vi.fn(() => Promise.resolve(JSON.stringify({ scripts: { dev: 'next dev' } }))),
}));

/** The fake PTY, standing in for what `tauri-pty` hands back. */
let ptyExitListener: ((e: { exitCode: number }) => void) | undefined;
let resolveInit: (() => void) | undefined;

vi.mock('tauri-pty', () => ({
  spawn: vi.fn(() => {
    const pty: Record<string, unknown> = {
      // The session HANDLE — deliberately 0, the value that was fatal.
      pid: 0,
      _init: new Promise<void>((resolve) => {
        resolveInit = resolve;
      }),
      onExit: (cb: (e: { exitCode: number }) => void) => {
        ptyExitListener = cb;
        return { dispose: () => {} };
      },
      onData: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
    };
    return pty;
  }),
}));

/** Every `register_external_pty` call the module made. */
let registrations: { pid: number; ptyId: number }[] = [];
let unregistrations: number[] = [];
/** What `plugin:pty|process_id` answers with. */
let processIdAnswer: number | null = 4242;

function installIpc() {
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'plugin:pty|process_id':
        return processIdAnswer;
      case 'register_external_pty':
        registrations.push({ pid: a.pid as number, ptyId: a.ptyId as number });
        return null;
      case 'unregister_external_pty':
        unregistrations.push(a.ptyId as number);
        return null;
      case 'get_shell_path':
        return '/usr/bin:/bin';
      default:
        return null;
    }
  });
}

/** Let the chain of awaits inside the `_init` handler settle. */
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('dev server PTY registration', () => {
  beforeEach(() => {
    registrations = [];
    unregistrations = [];
    processIdAnswer = 4242;
    ptyExitListener = undefined;
    resolveInit = undefined;
    installIpc();
  });

  afterEach(() => {
    clearMocks();
    vi.resetModules();
  });

  it('registers the OS pid from the plugin, never the session handle', async () => {
    const { startDevServer } = await import('./project');
    await startDevServer('/tmp/project', 3000, 'main');

    resolveInit?.();
    await settle();

    expect(registrations).toHaveLength(1);
    expect(registrations[0].pid).toBe(4242);
    // The bug in one assertion: the fake PTY's handle is 0, and 0 is our own
    // process group.
    expect(registrations[0].pid).not.toBe(0);
  });

  it('registers nothing when the plugin has no pid for the handle', async () => {
    processIdAnswer = null;
    const { startDevServer } = await import('./project');
    await startDevServer('/tmp/project', 3000, 'main');

    resolveInit?.();
    await settle();

    // Better to lose cleanup for one dev server than to record a pid we
    // cannot vouch for and signal it later.
    expect(registrations).toHaveLength(0);
  });

  it('registers nothing when the child exits before its pid comes back', async () => {
    const { startDevServer } = await import('./project');
    await startDevServer('/tmp/project', 3000, 'main');

    // A dev server that dies instantly — a taken port, a broken install —
    // exits inside the async gap the pid lookup opens. `onExit` has already
    // unregistered by then, so registering now would put a dead pid back in
    // the registry for a later teardown to SIGKILL after the OS reuses it.
    ptyExitListener?.({ exitCode: 1 });
    resolveInit?.();
    await settle();

    expect(registrations).toHaveLength(0);
  });
});
