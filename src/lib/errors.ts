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

<<<<<<< HEAD
/** Context that lets {@link humanizeGitError} name the branches involved. */
export interface GitErrorContext {
  /** The branch the action was on (e.g. the PR's source / the one being pushed). */
  branch?: string;
  /** The base/target branch, when relevant (PRs, merges). */
  base?: string;
}

/**
 * Turn a raw git/GitHub error into a plain-language message a non-git-expert can
 * act on. Recognizes the common failures (empty branch, merge conflict, out of
 * date, auth, network, protected branch, existing PR, unsaved changes) and falls
 * back to the formatted raw message when nothing matches.
 */
export function humanizeGitError(value: unknown, ctx: GitErrorContext = {}): string {
  const raw = formatCommandError(asCommandError(value));
  const m = raw.toLowerCase();
  const branch = ctx.branch ?? 'This branch';
  const base = ctx.base ?? 'the base branch';

  // Nothing to open a PR for — the branch matches the base.
  if (m.includes('no commits between')) {
    return `There's nothing to review yet. ${branch} has no changes compared to ${base}. Make some changes on it first, then submit for review.`;
  }

  // The same lines changed on both sides.
  if (m.includes('conflict') || m.includes('automatic merge failed')) {
    return `${branch} can't be merged into ${base} automatically because some of the same lines changed in both. You'll need to resolve the conflicts before it can merge.`;
  }

  // Local copy is behind the remote.
  if (
    m.includes('non-fast-forward') ||
    m.includes('rejected') ||
    m.includes('fetch first') ||
    m.includes('tip of your current branch is behind') ||
    m.includes('remote contains work')
  ) {
    return `There are newer changes on GitHub than you have locally. Pull the latest changes first, then try again.`;
  }

  // GitHub wouldn't authenticate.
  if (
    m.includes('permission denied') ||
    m.includes('could not read username') ||
    m.includes('authentication failed') ||
    m.includes('not authenticated') ||
    m.includes('bad credentials') ||
    m.includes('403')
  ) {
    return `GitHub didn't accept the connection. Your sign-in may have expired. Reconnect GitHub (top right) and try again.`;
  }

  // Couldn't reach GitHub at all.
  if (
    m.includes('could not resolve host') ||
    m.includes('unable to access') ||
    m.includes('connection refused') ||
    m.includes('network is unreachable') ||
    m.includes('timed out') ||
    m.includes('timeout')
  ) {
    return `Couldn't reach GitHub. Check your internet connection and try again.`;
  }

  // Branch protection blocks a direct push.
  if (m.includes('protected branch') || m.includes('branch protection') || m.includes('gh006')) {
    return `${base} is protected, so changes can't be pushed to it directly. Open a pull request instead.`;
  }

  // A PR is already open for this branch.
  if (m.includes('already exists') && m.includes('pull request')) {
    return `There's already an open pull request for ${branch}.`;
  }

  // A checkout would clobber unsaved work.
  if (m.includes('overwritten by checkout') || m.includes('commit your changes or stash')) {
    return `You have unsaved changes that would be lost. Save or discard them first, then try again.`;
  }

  // The ref is gone — git couldn't find the branch, so it treated it as a path.
  if (
    m.includes('did not match') ||
    m.includes('pathspec') ||
    m.includes('unknown revision or path')
  ) {
    return `${branch} no longer exists. It may have been deleted or renamed outside Ship Studio.`;
  }

  // Not a git repo yet.
  if (m.includes('not a git repository')) {
    return `This project isn't set up with git yet.`;
  }

  return raw;
=======
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
>>>>>>> origin/main
}
