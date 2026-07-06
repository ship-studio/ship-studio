/**
 * TypeScript mirror of `src-tauri/src/errors.rs::CommandError`.
 *
 * Tauri commands that have been migrated to return `Result<T, CommandError>`
 * will reject with one of these tagged objects (rather than a free-form string).
 *
 * When you add a new variant in Rust, add it here too.
 */

export type CommandError =
  | { type: 'Timeout'; cmd: string; secs: number }
  | { type: 'Process'; cmd: string; exit_code: number; stderr: string }
  | { type: 'Validation'; field: string; reason: string }
  | { type: 'NotAuthenticated'; service: string }
  | { type: 'Io'; message: string }
  | { type: 'MergeConflict'; pr_number: number; stderr: string }
  | { type: 'Other'; message: string };

/**
 * Best-effort coercion of an unknown caught value into a `CommandError`. Used
 * by `useInvoke` and other call-sites that catch from `invoke()` — the runtime
 * value can be a `CommandError`, a plain string (legacy commands), or an
 * Error instance.
 */
export function asCommandError(value: unknown): CommandError {
  if (typeof value === 'object' && value !== null && 'type' in value) {
    return value as CommandError;
  }
  if (typeof value === 'string') {
    return { type: 'Other', message: value };
  }
  if (value instanceof Error) {
    return { type: 'Other', message: value.message };
  }
  return { type: 'Other', message: String(value) };
}

/** Render a `CommandError` to a user-facing string. */
export function formatCommandError(err: CommandError): string {
  switch (err.type) {
    case 'Timeout':
      return `\`${err.cmd}\` timed out after ${err.secs}s`;
    case 'Process':
      return `\`${err.cmd}\` exited with status ${err.exit_code}: ${err.stderr}`;
    case 'Validation':
      return `Validation failed for \`${err.field}\`: ${err.reason}`;
    case 'NotAuthenticated':
      return `Not authenticated with ${err.service}`;
    case 'Io':
      return `I/O error: ${err.message}`;
    case 'MergeConflict':
      return `Pull request #${err.pr_number} can't be merged cleanly: ${err.stderr}`;
    case 'Other':
      return err.message;
  }
}

/** True when a caught error is the tagged MergeConflict variant. */
export function isMergeConflictError(value: unknown): boolean {
  return asCommandError(value).type === 'MergeConflict';
}

/**
 * Exit-code → actionable-message mappings shared by the PTY-driven flows
 * (project creation, GitHub import) that run `git clone` / package installs.
 */
const PROCESS_EXIT_MESSAGES: Record<number, string> = {
  243: "npm couldn't access its cache directory (~/.npm). This usually happens when npm was previously run with sudo.\n\nTo fix, open a terminal and run:\nsudo chown -R $(whoami) ~/.npm",
  128: "Git authentication failed. Make sure you're signed into GitHub.",
};

/**
 * Map a caught error from a PTY-driven process (clone, install, …) to a
 * user-friendly message.
 *
 * Handles Error instances, plain strings, and CommandError objects from
 * `invoke()` rejections — the latter are plain objects (NOT `instanceof
 * Error`), so naive `String(err)` renders them as "[object Object]".
 * "Process exited with code N" messages are mapped to actionable advice;
 * callers can extend the exit-code map for flow-specific codes.
 */
export function friendlyProcessError(
  err: unknown,
  extraExitCodeMessages?: Record<number, string>
): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : formatCommandError(asCommandError(err));
  const codeMatch = msg.match(/Process exited with code (\d+)/);
  if (codeMatch) {
    const code = parseInt(codeMatch[1], 10);
    const mapped = extraExitCodeMessages?.[code] ?? PROCESS_EXIT_MESSAGES[code];
    if (mapped) return mapped;
  }
  // Strip the "Error: " prefix that comes from Error.toString()
  return msg.replace(/^Error:\s*/, '');
}
