/**
 * Terminal output diagnostics.
 *
 * Pure helpers that turn the raw output tail of a failed PTY command into a
 * human-readable error message. Used by the onboarding wizard and the
 * dashboard agents panel to surface *why* an install/auth command failed
 * instead of a generic "Command failed" (see issue #164 — Windows installs
 * failed with zero diagnostics).
 *
 * @module lib/terminalDiagnostics
 */

import { stripAnsi } from './ansi';

/**
 * Raw PTY chunk shapes seen at runtime. tauri-pty's types claim `string`, but
 * the plugin's `read` command returns `Vec<u8>`, which Tauri's JSON IPC
 * delivers as a **plain number array** — not a Uint8Array. Passing that
 * array straight to `TextDecoder.decode()` throws a TypeError, and a throw
 * inside an onData listener propagates into tauri-pty's internal read loop
 * and kills it — the terminal freezes after the first chunk (the v0.13.2
 * frozen connect/install terminal regression).
 */
export type PtyChunk = string | Uint8Array | ArrayBuffer | number[];

/** Normalize any raw PTY chunk shape to Uint8Array (strings pass through). */
export function toPtyBytes(data: Exclude<PtyChunk, string>): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data);
}

/**
 * Create a streaming PTY chunk decoder. Returns a function that converts any
 * chunk shape to text, preserving multi-byte characters split across chunk
 * boundaries, and never throws — diagnostics must never be able to break the
 * output stream (a throw here is exactly what froze terminals in v0.13.2).
 */
export function createPtyChunkDecoder(): (data: PtyChunk) => string {
  const decoder = new TextDecoder();
  return (data: PtyChunk): string => {
    if (typeof data === 'string') return data;
    try {
      return decoder.decode(toPtyBytes(data), { stream: true });
    } catch {
      return '';
    }
  };
}

/** Lines that look like they describe the failure. */
const ERROR_LINE_PATTERN = /error|not recognized|not found|EACCES|EPERM|EEXIST|ENOENT|npm ERR!/i;

/**
 * npm's trailing pointer at its debug log (the sentence and the log-file path
 * line that follows it) — present on every failure and says nothing about the
 * cause, so never pick it as "the" error line.
 */
const NOISE_LINE_PATTERN = /complete log of this run|[\\/]_logs[\\/].*\.log\b/i;

/**
 * "npm/node isn't on PATH" — cmd.exe ("'npm' is not recognized as an internal
 * or external command"), PowerShell ("The term 'npm' is not recognized…"),
 * and Unix shells ("npm: command not found").
 */
const NODE_MISSING_PATTERN =
  /'(npm|node)(\.cmd|\.exe)?' is not recognized|\b(npm|node): (command )?not found/i;

/** Maximum length of an extracted error message shown in the UI / telemetry. */
const MAX_ERROR_LENGTH = 200;

/**
 * Split terminal output into the lines a user actually saw: strips ANSI
 * codes, collapses carriage-return redraws (spinners/progress bars rewrite
 * the same line — only the last non-empty segment survives), and drops blank
 * lines.
 */
function toVisibleLines(tail: string): string[] {
  return stripAnsi(tail)
    .split('\n')
    .map((line) => {
      const segments = line.split('\r').filter((segment) => segment.trim().length > 0);
      return (segments[segments.length - 1] ?? '').trim();
    })
    .filter((line) => line.length > 0);
}

/**
 * Extract the most useful error line from the tail of a failed command's
 * output. Prefers the last line that looks error-ish (error/not found/npm
 * ERR!/EEXIST…), falls back to the last non-empty line, and returns null for
 * an empty tail. Result is capped at {@link MAX_ERROR_LENGTH} characters.
 */
export function extractTerminalError(tail: string): string | null {
  const lines = toVisibleLines(tail);
  if (lines.length === 0) return null;

  // pnpm's build-script gate: the install "fails" because pnpm wants explicit
  // approval to run dependency postinstall scripts. Surfacing the raw notice
  // with no next step left users stuck (issue #469) — say what to actually do.
  if (lines.some((line) => line.includes('approve-builds'))) {
    return 'pnpm blocked dependency build scripts pending your approval. In the terminal, run `pnpm approve-builds`, approve the listed packages, then retry the install';
  }

  const errorLines = lines.filter(
    (line) => ERROR_LINE_PATTERN.test(line) && !NOISE_LINE_PATTERN.test(line)
  );
  const best = errorLines.length > 0 ? errorLines[errorLines.length - 1] : lines[lines.length - 1];
  return best.length > MAX_ERROR_LENGTH ? `${best.slice(0, MAX_ERROR_LENGTH - 1)}…` : best;
}

/**
 * True when the output indicates npm/node itself wasn't found on PATH — the
 * signature of an npm-based install attempted before Node.js is installed
 * (or before a fresh install is visible to the app).
 */
export function isNodeMissingError(tail: string): boolean {
  return NODE_MISSING_PATTERN.test(stripAnsi(tail));
}

/**
 * Common signatures of a network problem in CLI output: Node/libuv error
 * codes (ENOTFOUND, ETIMEDOUT, ECONNRESET, ECONNREFUSED, EAI_AGAIN,
 * getaddrinfo), curl phrasing ("Could not resolve host", "Failed to
 * connect"), the POSIX "network is unreachable", and npm's network error
 * class ("npm ERR! network").
 */
const NETWORK_ERROR_PATTERN =
  /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo|could not resolve host|failed to connect|network is unreachable|npm ERR!\s+network/i;

/**
 * True when the output tail looks like a network failure (offline, DNS,
 * refused/reset connections). Callers use this to show "check your internet
 * connection" guidance instead of a raw error line the user can't act on.
 */
export function isNetworkError(tail: string): boolean {
  return NETWORK_ERROR_PATTERN.test(stripAnsi(tail));
}

/**
 * Identity-capturing shapes of "the CLI believes it's signed in":
 * - "Logged in as julian@example.com" (claude / codex)
 * - "✓ Logged in to github.com account juliangalluzzo (keyring)" and
 *   "Logged in to github.com as juliangalluzzo" (gh, old and new phrasing)
 */
const LOGGED_IN_AS_PATTERNS = [
  /\blogged in as\s+['"]?([^\s'"]+)/i,
  /\blogged in to \S+ (?:account |as )['"]?([^\s()'"]+)/i,
];

/** "You are already logged in" and friends — no identity attached. */
const ALREADY_LOGGED_IN_PATTERN = /\balready logged in\b/i;

/**
 * Detect the "CLI says it's already signed in" signature in an auth command's
 * output tail. When an auth flow fails *while* the CLI insists it has a login
 * (e.g. a partial sign-out desynced the CLI from Ship Studio's status check —
 * issue #159), a generic "authentication not completed" message hides the real
 * situation; callers use this to name the identity the CLI reported instead.
 *
 * Returns `null` when nothing matches; otherwise `{ identity }` where
 * `identity` is the captured user/email if the output named one.
 */
export function detectAlreadyLoggedIn(tail: string): { identity: string | null } | null {
  const text = toVisibleLines(tail).join('\n');
  for (const pattern of LOGGED_IN_AS_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      // Emails contain dots, so the capture is greedy about punctuation —
      // trim a trailing sentence period/comma ("Logged in as a@b.com.").
      const identity = match[1].replace(/[.,;:!]+$/, '');
      return { identity: identity.length > 0 ? identity : null };
    }
  }
  return ALREADY_LOGGED_IN_PATTERN.test(text) ? { identity: null } : null;
}

/**
 * Describe a PTY exit code for a failure message.
 *
 * Normal exits stay the familiar "code N". Abnormal Windows terminations
 * arrive as full 32-bit statuses — a negative NTSTATUS or node's negative
 * libuv errno (e.g. -4058 = UV_ENOENT), historically wrapped to a huge u32
 * like 4294963238 by the PTY plugin — and interpolating those raw made the
 * failure toast look broken (issue #622). Both the negative (current backend)
 * and wrapped-u32 (older backend) shapes render as the status in hex, which
 * is how such codes are documented and searchable.
 */
export function describeExitStatus(exitCode: number | null): string {
  if (exitCode === null) return 'code null';
  // Plausible ordinary exit codes (0-255 everywhere; Windows tools also use
  // small positive codes like 3221225477's little siblings — anything beyond
  // 0xFFFF is not a code a CLI returns deliberately).
  if (exitCode >= 0 && exitCode <= 0xffff) return `code ${exitCode}`;
  // Reinterpret as an unsigned 32-bit status and render as hex.
  const u32 = exitCode < 0 ? exitCode + 0x1_0000_0000 : exitCode;
  return `status 0x${u32.toString(16).toUpperCase().padStart(8, '0')}`;
}
