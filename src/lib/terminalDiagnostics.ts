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
