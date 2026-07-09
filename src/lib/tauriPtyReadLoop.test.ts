/**
 * Regression test for the v0.13.2 frozen connect/install terminal bug.
 *
 * tauri-pty's internal read loop (`for(;;) { data = await invoke('read');
 * onData.fire(data) }`) fires listeners synchronously and treats ANY listener
 * throw as a fatal read error — the loop exits and the terminal never renders
 * another byte. Because Tauri's JSON IPC delivers the plugin's `Vec<u8>` as a
 * plain number array (NOT a Uint8Array, despite tauri-pty's `string` typing),
 * calling `TextDecoder.decode(data)` directly in a listener throws a
 * TypeError on the first chunk. That's exactly what OnboardingTerminal's
 * diagnostics tail did in v0.13.2: every onboarding/connect/install terminal
 * froze after the first output chunk ("Starting..." forever).
 *
 * These tests drive the REAL tauri-pty client over mocked IPC with
 * production-shaped payloads to pin both the failure mechanism and the fix.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
// The global test setup replaces 'tauri-pty' with a stub (vitest alias +
// vi.mock). This test exists precisely to exercise the REAL client's read
// loop, so import the actual distributed module by path and re-type it with
// the package's own declarations.
// @ts-expect-error — untyped direct dist import; typed via the cast below
import { spawn as spawnUntyped } from '../../node_modules/tauri-pty/dist/index.es.js';
import { createPtyChunkDecoder, toPtyBytes, type PtyChunk } from './terminalDiagnostics';

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const spawn: typeof import('tauri-pty').spawn = spawnUntyped;

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

/** Queue chunks the mocked `read` command hands out one per invoke. */
function mockPtyIpc(chunks: number[][]) {
  let next = 0;
  mockIPC((cmd) => {
    switch (cmd) {
      case 'plugin:pty|spawn':
        return 1;
      case 'plugin:pty|read':
        if (next < chunks.length) return chunks[next++];
        // No more scripted output — block like a real PTY with no data.
        return new Promise<never>(() => {});
      case 'plugin:pty|exitstatus':
        // Child still running.
        return new Promise<never>(() => {});
      default:
        return undefined;
    }
  });
}

/** Let the client's async read loop drain the scripted chunks. */
async function flushReadLoop() {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const CHUNKS = [utf8('\x1b[?25l\x1b[2K'), utf8('? Press Enter to open '), utf8('github.com…')];

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

describe('tauri-pty read loop vs onData listeners', () => {
  it('DOCUMENTS THE BUG: a listener that TextDecoder.decode()s the raw chunk kills the loop after chunk 1', async () => {
    // tauri-pty logs the listener throw as 'Reading error:' — silence it.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockPtyIpc(CHUNKS);

    const received: string[] = [];
    const decoder = new TextDecoder();
    const pty = spawn('gh', ['auth', 'login'], {});
    pty.onData((data) => {
      // The exact v0.13.2 pattern: decode(plain array) throws a TypeError.
      received.push(typeof data === 'string' ? data : decoder.decode(data));
    });

    await flushReadLoop();

    // The first chunk's throw killed the read loop: chunks 2 and 3 are
    // never delivered even though the mocked PTY has them ready.
    expect(received).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith('Reading error: ', expect.any(TypeError));
  });

  it('FIXED: normalizing chunks via toPtyBytes/createPtyChunkDecoder streams every chunk', async () => {
    mockPtyIpc(CHUNKS);

    const written: Array<string | Uint8Array> = [];
    let tail = '';
    const decodeChunk = createPtyChunkDecoder();
    const pty = spawn('gh', ['auth', 'login'], {});
    pty.onData((data: PtyChunk) => {
      // The fixed OnboardingTerminal pattern.
      const chunk = typeof data === 'string' ? data : toPtyBytes(data);
      written.push(chunk);
      tail += decodeChunk(data);
    });

    await flushReadLoop();

    expect(written).toHaveLength(CHUNKS.length);
    expect(tail).toBe('\x1b[?25l\x1b[2K? Press Enter to open github.com…');
  });
});
