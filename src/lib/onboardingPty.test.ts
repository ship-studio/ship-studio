/**
 * Tests for the onboarding PTY client's failure-mode guarantees — each one
 * inverts a silent-failure behavior of the npm tauri-pty client it replaced:
 * spawn rejects loudly, listener throws can't kill the stream, transient read
 * errors retry, and an exit event always fires (unless the caller killed).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { spawnOnboardingPty } from './onboardingPty';

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

const OPTS = { cwd: '/home/user', cols: 80, rows: 24, env: { PATH: '/usr/bin' } };

/** Let the client's async loops drain. */
async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface PtyIpcScript {
  /** Values (or thrown errors) the read command yields, in order. */
  reads: Array<number[] | Error>;
  /** What exitstatus resolves to; an Error rejects. Default: never settles. */
  exit?: number | Error;
}

function mockPtyIpc(script: PtyIpcScript) {
  let next = 0;
  mockIPC((cmd) => {
    switch (cmd) {
      case 'plugin:pty|spawn':
        return 7;
      case 'plugin:pty|read': {
        if (next < script.reads.length) {
          const step = script.reads[next++];
          if (step instanceof Error) throw step;
          return step;
        }
        return new Promise<never>(() => {});
      }
      case 'plugin:pty|exitstatus':
        if (script.exit === undefined) return new Promise<never>(() => {});
        if (script.exit instanceof Error) throw script.exit;
        return script.exit;
      default:
        return undefined;
    }
  });
}

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

describe('spawnOnboardingPty', () => {
  it('rejects when the backend spawn fails (tauri-pty swallowed this)', async () => {
    mockIPC((cmd) => {
      if (cmd === 'plugin:pty|spawn') throw new Error('Failed to start `gh`: No such file');
      return undefined;
    });
    await expect(spawnOnboardingPty('gh', [], OPTS)).rejects.toThrow('Failed to start `gh`');
  });

  it('keeps streaming when an onData listener throws', async () => {
    mockPtyIpc({ reads: [utf8('one'), utf8('two'), utf8('three')] });
    const pty = await spawnOnboardingPty('gh', [], OPTS);
    const seen: unknown[] = [];
    pty.onData((data) => {
      seen.push(data);
      throw new Error('listener bug');
    });
    await flush();
    expect(seen).toHaveLength(3);
  });

  it('retries transient read errors instead of dying', async () => {
    mockPtyIpc({ reads: [utf8('a'), new Error('transient glitch'), utf8('b')] });
    const pty = await spawnOnboardingPty('gh', [], OPTS);
    const seen: unknown[] = [];
    pty.onData((data) => seen.push(data));
    await flush(60);
    expect(seen).toHaveLength(2);
  });

  it('stops on EOF without reporting a stream error', async () => {
    mockPtyIpc({ reads: [utf8('bye'), new Error('EOF')] });
    const pty = await spawnOnboardingPty('gh', [], OPTS);
    const streamErrors: string[] = [];
    pty.onStreamError((message) => streamErrors.push(message));
    await flush();
    expect(streamErrors).toHaveLength(0);
  });

  it('reports a stream error after persistent read failures', async () => {
    mockPtyIpc({
      reads: [new Error('boom'), new Error('boom'), new Error('boom'), new Error('boom')],
    });
    const pty = await spawnOnboardingPty('gh', [], OPTS);
    const streamErrors: string[] = [];
    pty.onStreamError((message) => streamErrors.push(message));
    // Retry backoff totals ~600ms before the error is declared persistent.
    await flush(200);
    expect(streamErrors).toHaveLength(1);
  });

  it('fires onExit with the real exit code', async () => {
    mockPtyIpc({ reads: [new Error('EOF')], exit: 3 });
    const pty = await spawnOnboardingPty('gh', [], OPTS);
    const exits: Array<number | null> = [];
    pty.onExit(({ exitCode }) => exits.push(exitCode));
    await flush();
    expect(exits).toEqual([3]);
  });

  it('still fires onExit (as failure) when exitstatus rejects — tauri-pty hung forever here', async () => {
    mockPtyIpc({ reads: [new Error('EOF')], exit: new Error('Unavaliable pid') });
    const pty = await spawnOnboardingPty('gh', [], OPTS);
    const exits: Array<number | null> = [];
    pty.onExit(({ exitCode }) => exits.push(exitCode));
    await flush();
    expect(exits).toEqual([1]);
  });

  it('does not fire onExit after the caller killed the session', async () => {
    mockPtyIpc({ reads: [], exit: new Error('Unavaliable pid') });
    const pty = await spawnOnboardingPty('gh', [], OPTS);
    const exits: Array<number | null> = [];
    pty.onExit(({ exitCode }) => exits.push(exitCode));
    pty.kill();
    await flush();
    expect(exits).toHaveLength(0);
  });

  it('treats a null chunk (broken bridge / bare mock) as end-of-stream instead of spinning', async () => {
    let readCalls = 0;
    mockIPC((cmd) => {
      if (cmd === 'plugin:pty|spawn') return 7;
      if (cmd === 'plugin:pty|read') {
        readCalls += 1;
        return undefined;
      }
      return undefined;
    });
    const pty = await spawnOnboardingPty('gh', [], OPTS);
    pty.onData(() => {});
    await flush();
    expect(readCalls).toBe(1);
  });
});
