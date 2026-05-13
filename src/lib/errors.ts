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
