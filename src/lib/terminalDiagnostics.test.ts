import { describe, it, expect } from 'vitest';
import {
  createPtyChunkDecoder,
  detectAlreadyLoggedIn,
  extractTerminalError,
  isNetworkError,
  isNodeMissingError,
  toPtyBytes,
} from './terminalDiagnostics';

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

describe('toPtyBytes', () => {
  it('passes Uint8Array through unchanged', () => {
    const input = new Uint8Array([104, 105]);
    expect(toPtyBytes(input)).toBe(input);
  });

  it('wraps a plain number array (the real Tauri IPC shape for Vec<u8>)', () => {
    const result = toPtyBytes([104, 105]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([104, 105]);
  });

  it('wraps an ArrayBuffer', () => {
    const result = toPtyBytes(new Uint8Array([104, 105]).buffer);
    expect(Array.from(result)).toEqual([104, 105]);
  });
});

describe('createPtyChunkDecoder', () => {
  it('decodes plain number arrays without throwing (v0.13.2 frozen-terminal regression)', () => {
    const decode = createPtyChunkDecoder();
    // TextDecoder.decode() throws a TypeError on plain arrays — the old code
    // did exactly that inside onData, killing tauri-pty's read loop.
    expect(decode(utf8('Checking for `sudo` access...'))).toBe('Checking for `sudo` access...');
  });

  it('passes strings through', () => {
    const decode = createPtyChunkDecoder();
    expect(decode('hello')).toBe('hello');
  });

  it('preserves multi-byte characters split across chunk boundaries', () => {
    const decode = createPtyChunkDecoder();
    const encoded = utf8('✓ done');
    // '✓' is 3 bytes — split it mid-character across two chunks.
    expect(decode(encoded.slice(0, 2)) + decode(encoded.slice(2))).toBe('✓ done');
  });

  it('never throws, even on garbage input', () => {
    const decode = createPtyChunkDecoder();
    expect(() => decode({} as never)).not.toThrow();
    expect(decode({} as never)).toBe('');
  });
});

describe('extractTerminalError', () => {
  it('returns null for an empty tail', () => {
    expect(extractTerminalError('')).toBeNull();
  });

  it('returns null for whitespace/ANSI-only output', () => {
    expect(extractTerminalError('  \r\n\x1b[2K\r\n   ')).toBeNull();
  });

  it("extracts the Windows 'npm is not recognized' line", () => {
    const tail =
      "'npm' is not recognized as an internal or external command,\r\n" +
      'operable program or batch file.\r\n';
    expect(extractTerminalError(tail)).toBe(
      "'npm' is not recognized as an internal or external command,"
    );
  });

  it('extracts the meaningful npm ERR! line, not the debug-log pointer', () => {
    const tail = [
      'npm ERR! code EEXIST',
      'npm ERR! path C:\\Users\\me\\AppData\\Roaming\\npm\\vercel',
      'npm ERR! EEXIST: file already exists, unlink C:\\Users\\me\\AppData\\Roaming\\npm\\vercel',
      'npm ERR! A complete log of this run can be found in:',
      'npm ERR!     C:\\Users\\me\\AppData\\Local\\npm-cache\\_logs\\2026-07-02.log',
    ].join('\r\n');
    expect(extractTerminalError(tail)).toBe(
      'npm ERR! EEXIST: file already exists, unlink C:\\Users\\me\\AppData\\Roaming\\npm\\vercel'
    );
  });

  it('strips ANSI codes from the extracted line', () => {
    const tail = 'installing...\n\x1b[31mnpm ERR!\x1b[0m code EACCES\n';
    expect(extractTerminalError(tail)).toBe('npm ERR! code EACCES');
  });

  it('collapses carriage-return progress redraws to the final segment', () => {
    const tail = 'Downloading 10%\rDownloading 55%\rDownloading 100%\nerror: failed to fetch\n';
    expect(extractTerminalError(tail)).toBe('error: failed to fetch');
  });

  it('falls back to the last non-empty line when nothing looks like an error', () => {
    const tail = 'step one done\nstep two done\nexiting with status 7\n';
    expect(extractTerminalError(tail)).toBe('exiting with status 7');
  });

  it('prefers the last error-ish line over later non-error lines', () => {
    const tail = 'error: could not connect to registry\ncleaning up temp files\n';
    expect(extractTerminalError(tail)).toBe('error: could not connect to registry');
  });

  it('caps very long lines at 200 characters', () => {
    const longLine = `npm ERR! ${'x'.repeat(400)}`;
    const result = extractTerminalError(longLine);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(200);
    expect(result?.endsWith('…')).toBe(true);
  });
});

describe('isNodeMissingError', () => {
  it('detects the cmd.exe not-recognized message for npm', () => {
    expect(
      isNodeMissingError(
        "'npm' is not recognized as an internal or external command,\r\noperable program or batch file."
      )
    ).toBe(true);
  });

  it('detects the PowerShell not-recognized message', () => {
    expect(
      isNodeMissingError(
        "npm : The term 'npm' is not recognized as the name of a cmdlet, function, script file, or operable program."
      )
    ).toBe(true);
  });

  it('detects the Unix command-not-found message for node', () => {
    expect(isNodeMissingError('/bin/bash: node: command not found')).toBe(true);
  });

  it('sees through ANSI-colored output', () => {
    expect(isNodeMissingError("\x1b[91m'node' is not recognized\x1b[0m")).toBe(true);
  });

  it('does not fire on unrelated failures', () => {
    expect(isNodeMissingError('npm ERR! code EACCES')).toBe(false);
    expect(isNodeMissingError("gh: command 'foo' not found")).toBe(false);
    expect(isNodeMissingError('')).toBe(false);
  });
});

describe('isNetworkError', () => {
  it('detects Node/libuv error codes', () => {
    expect(isNetworkError('Error: getaddrinfo ENOTFOUND registry.npmjs.org')).toBe(true);
    expect(isNetworkError('FetchError: request failed, reason: connect ETIMEDOUT')).toBe(true);
    expect(isNetworkError('read ECONNRESET')).toBe(true);
    expect(isNetworkError('connect ECONNREFUSED 104.16.0.35:443')).toBe(true);
    expect(isNetworkError('getaddrinfo EAI_AGAIN claude.ai')).toBe(true);
  });

  it('detects curl network failures', () => {
    expect(isNetworkError('curl: (6) Could not resolve host: raw.githubusercontent.com')).toBe(
      true
    );
    expect(isNetworkError('curl: (7) Failed to connect to claude.ai port 443')).toBe(true);
  });

  it('detects the POSIX unreachable-network message', () => {
    expect(isNetworkError('connect: network is unreachable')).toBe(true);
  });

  it('detects the npm network error class', () => {
    expect(
      isNetworkError('npm ERR! network This is a problem related to network connectivity.')
    ).toBe(true);
  });

  it('sees through ANSI-colored output', () => {
    expect(isNetworkError('\x1b[31mcurl: (6) Could not resolve host: claude.ai\x1b[0m')).toBe(true);
  });

  it('does not fire on non-network failures', () => {
    expect(isNetworkError('npm ERR! code EEXIST')).toBe(false);
    expect(isNetworkError('Error: EACCES: permission denied')).toBe(false);
    expect(isNetworkError('sudo: a password is required')).toBe(false);
    expect(isNetworkError('')).toBe(false);
  });
});

describe('detectAlreadyLoggedIn', () => {
  it('captures the identity from "Logged in as <email>" (claude/codex style)', () => {
    expect(detectAlreadyLoggedIn('Logged in as julian@example.com\n')).toEqual({
      identity: 'julian@example.com',
    });
  });

  it('captures the identity from the gh "account" phrasing', () => {
    expect(
      detectAlreadyLoggedIn('✓ Logged in to github.com account juliangalluzzo (keyring)\n')
    ).toEqual({ identity: 'juliangalluzzo' });
  });

  it('captures the identity from the older gh "as" phrasing', () => {
    expect(detectAlreadyLoggedIn('Logged in to github.com as juliangalluzzo\n')).toEqual({
      identity: 'juliangalluzzo',
    });
  });

  it('detects "already logged in" without a named identity', () => {
    expect(detectAlreadyLoggedIn('You are already logged in.\n')).toEqual({ identity: null });
  });

  it('prefers the named identity when both signatures appear', () => {
    expect(detectAlreadyLoggedIn('Already logged in as a@b.com. Nothing to do.\n')).toEqual({
      identity: 'a@b.com',
    });
  });

  it('sees through ANSI-colored output', () => {
    expect(detectAlreadyLoggedIn('\x1b[32mLogged in as\x1b[0m a@b.com\n')).toEqual({
      identity: 'a@b.com',
    });
  });

  it('does not fire on "not logged in" or unrelated output', () => {
    expect(detectAlreadyLoggedIn('You are not logged in. Run /login to sign in.\n')).toBeNull();
    expect(detectAlreadyLoggedIn('error: OAuth token exchange failed\n')).toBeNull();
    expect(detectAlreadyLoggedIn('')).toBeNull();
  });
});
