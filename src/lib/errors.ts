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
  // Anything else that reaches here is a plain object with no `type` tag (a
  // rejected non-CommandError payload, a DOM/plugin error bag, …). `String()`
  // renders those as the literal "[object Object]", which defeats every call
  // site that dutifully routes through this helper — the real cause becomes
  // unrecoverable from telemetry (issue #790). Serialize instead, falling
  // back to String() for values JSON can't represent (undefined, symbols,
  // functions) or refuses to walk (circular refs, throwing getters).
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string') {
      return { type: 'Other', message: serialized };
    }
  } catch {
    // fall through to String()
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

/** Context that lets {@link humanizeGitError} name the branches involved. */
export interface GitErrorContext {
  /** The branch the action was on (e.g. the PR's source / the one being pushed). */
  branch?: string;
  /** The base/target branch, when relevant (PRs, merges). */
  base?: string;
}

/**
 * Wording (lowercased substrings) of the friendly messages the BACKEND already
 * authored for recognized git/GitHub failures — `CommandError::expected(...)`
 * strings in `src-tauri/src/commands/github.rs` (gh_network_error,
 * gh_tls_error, gh_server_error, gh_malformed_request_error, gh_config_error,
 * gh_crash_error, plus the gh timeout mapping) and
 * `src-tauri/src/commands/git/branches.rs` (vanished base ref). Expected
 * serializes identically to Other across IPC, so the tag is gone by the time
 * the frontend sees the error — the wording itself is the only signal. Keep
 * these in sync with the Rust strings byte-for-byte.
 *
 * Without this list, {@link humanizeGitError} returns these already-humanized
 * messages unchanged and {@link isRecognizedGitFailure}'s inequality test
 * misreads "unchanged" as "unrecognized", routing failures the backend
 * deliberately kept out of telemetry straight back into the error-toast
 * channels that auto-file bug reports (issue #687).
 */
const BACKEND_HUMANIZED_GIT_PHRASES = [
  // gh_network_error / the gh timeout → Expected mapping (issues #375, #686)
  "couldn't reach github",
  'check your internet connection',
  // gh_tls_error (issue #658)
  "secure connection couldn't be verified",
  // gh_server_error / gh_malformed_request_error (issues #627, #602)
  "github's api is temporarily unavailable",
  "github couldn't process the request",
  // gh_config_error (issue #631)
  "can't read its own settings",
  // gh_crash_error (issue #610)
  'the github cli (gh) crashed',
  "couldn't start because the system is low on memory",
  // create_branch's vanished base ref (issue #692)
  'no longer exists on github',
  // git_stage_and_commit's pre-commit hook refusal (issues #604/#766) — the
  // project's own husky/lint-staged/test chain rejecting the commit is the
  // project working as configured, not an app malfunction.
  'pre-commit checks blocked the commit',
  // create_branch's taken-name refusal (issue #791). Paired with the raw-git
  // case in humanizeGitError below: because that case reconstructs this exact
  // sentence, the inequality test alone can't see it.
  'already exists. pick a different name',
  // delete_branch's default-branch refusal (issue #792). GitHub's own
  // pre-receive rejection wording never reaches the frontend, and the
  // friendly replacement contains none of the network/auth/"rejected"
  // substrings humanizeGitError keys on.
  'default branch on github',
  // pr_create_refusal's unrelated-histories case (issue #838)
  'shares no history with',
  // push_to_github's existing-origin refusals (issue #779) — the project is
  // already wired to another repo, or gh created the repo but couldn't add
  // the remote. Both are user-side git state, not a malfunction.
  'already connected to a different github repository',
  "was created on github, but this project couldn't be connected",
  // gh_shadowed_binary_error: PATH resolved something that isn't the GitHub
  // CLI (issue #737)
  "isn't github's cli",
  // publish_branch / get_current_branch's detached-HEAD guard (issues
  // #317/#794) — a normal git state with a user-side fix.
  'detached head',
  // delete_branch's remote-delete timeout (issue #819's sibling): the other
  // push/create timeouts already say "check your internet connection", but
  // this one says "check your connection".
  "didn't respond in time",
  // close_pull_request's already-merged refusal (issue #798) — the PR list
  // the Close button was clicked from went stale, an anticipated race.
  "already merged, so there's nothing to close",
];

/** True when a message is one the backend already humanized (see
 *  {@link BACKEND_HUMANIZED_GIT_PHRASES}). */
function isBackendHumanizedGitMessage(message: string): boolean {
  const m = message.toLowerCase();
  return BACKEND_HUMANIZED_GIT_PHRASES.some((phrase) => m.includes(phrase));
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

  // The gh CLI can't read its own config file — a local file-permissions
  // problem (e.g. a prior sudo run left ~/.config/gh root-owned), not a
  // GitHub sign-in failure. Must be checked BEFORE the generic "permission
  // denied" auth branch below, which would send the user to "reconnect
  // GitHub" — advice that can't fix a file the OS won't let gh read
  // (issue #631).
  if (
    // The backend's own friendly wording for this state (gh_config_error,
    // issue #687) as well as gh's raw stderr.
    m.includes("can't read its own settings") ||
    ((m.includes('failed to read configuration') || m.includes('failed to load config')) &&
      m.includes('permission denied'))
  ) {
    return `The GitHub CLI (gh) can't read its own settings because of a file-permissions problem on this computer — this isn't a GitHub sign-in issue. Open a terminal and run \`sudo chown -R $(whoami) ~/.config/gh\`, then try again.`;
  }

  // GitHub wouldn't authenticate. GitHub's no-write-access rejection reads
  // "Permission to <owner>/<repo>.git denied to <user>." — the words are split
  // by the repo name, so it needs the two-part check (issue #321).
  if (
    m.includes('permission denied') ||
    (m.includes('permission to') && m.includes('denied to')) ||
    m.includes('write access to repository not granted') ||
    m.includes('could not read username') ||
    m.includes('authentication failed') ||
    m.includes('not authenticated') ||
    m.includes('bad credentials') ||
    m.includes('403')
  ) {
    return `GitHub didn't accept the connection. Your sign-in may have expired, or your account may not have write access to this repository. Reconnect GitHub (top right) or check your access, then try again.`;
  }

  // TLS certificate verification failed — a corporate proxy/antivirus doing
  // HTTPS inspection with an untrusted CA, or a broken certificate store.
  // Must be checked BEFORE the generic network branch: "check your internet
  // connection" can't fix a trust chain (issue #658, mirroring gh_tls_error
  // in src-tauri/src/commands/github.rs).
  if (
    m.includes('failed to verify certificate') ||
    m.includes('x509:') ||
    // The backend's own friendly wording for this state (gh_tls_error,
    // issue #687).
    m.includes("secure connection couldn't be verified")
  ) {
    return `GitHub's secure connection couldn't be verified. This usually means a corporate proxy, VPN, or antivirus is inspecting HTTPS traffic on this computer, or the system's certificate store is out of date. Install your proxy's certificate or update your system, then try again.`;
  }

  // Couldn't reach GitHub at all. 'dial tcp'/'connectex' cover Go's dial
  // errors from the gh CLI — the Windows connectex wording contains none of
  // the usual timeout/refused substrings (issue #375).
  if (
    m.includes('could not resolve host') ||
    m.includes('unable to access') ||
    m.includes('connection refused') ||
    m.includes('network is unreachable') ||
    m.includes('dial tcp') ||
    m.includes('connectex') ||
    m.includes('timed out') ||
    m.includes('timeout') ||
    // Go's net/http closing the connection mid-request. The bare `…: EOF`
    // variant needs the end-of-line anchor — a naked "eof" substring would
    // false-positive on ordinary words like "thereof" (issues #434/#642,
    // mirroring gh_network_error in src-tauri/src/commands/github.rs).
    m.includes('unexpected eof') ||
    /:\s*eof\s*$/m.test(m) ||
    // The backend's own friendly wording (gh_network_error / the gh timeout
    // mapping, issues #687/#686) — and gh's raw top-level DNS-failure output,
    // which also says "check your internet connection" (issue #473).
    m.includes("couldn't reach github") ||
    m.includes('check your internet connection')
  ) {
    return `Couldn't reach GitHub. Check your internet connection and try again.`;
  }

  // Branch protection blocks a direct push.
  if (m.includes('protected branch') || m.includes('branch protection') || m.includes('gh006')) {
    return `${base} is protected, so changes can't be pushed to it directly. Open a pull request instead.`;
  }

  // Creating a repo under a name the account already uses — a routine,
  // user-correctable collision the backend deliberately refuses with friendly
  // wording (issue #279; gh's raw phrasing is "Name already exists on this
  // account"). Recognizing it here keeps the create-repo toast off the
  // error/telemetry channel (issues #666/#667).
  if (m.includes('already exists on this account')) {
    const name = raw.match(/named "([^"]+)"/)?.[1];
    return `A repository named ${name ? `"${name}"` : 'that'} already exists on this GitHub account. Choose a different name.`;
  }

  // A PR is already open for this branch.
  if (m.includes('already exists') && m.includes('pull request')) {
    return `There's already an open pull request for ${branch}.`;
  }

  // Creating a branch under a name that's taken — "fatal: a branch named 'X'
  // already exists" (issue #791). create_branch classifies its own hit
  // Expected with this same wording (see BACKEND_HUMANIZED_GIT_PHRASES); this
  // covers git's raw phrasing on any path that misses that classification.
  if (m.includes('a branch named') && m.includes('already exists')) {
    const taken = raw.match(/a branch named '([^']+)' already exists/i)?.[1];
    return `A branch named ${taken ? `'${taken}'` : 'that'} already exists. Pick a different name, or switch to the existing branch.`;
  }

  // The branch name exists on several remotes and nowhere locally, so git's
  // DWIM checkout refuses to guess: "fatal: 'X' matched multiple (2) remote
  // tracking branches". switch_branch qualifies against origin when origin
  // has it (issue #729), so this is the residual case — the branch is on
  // other remotes but not origin.
  if (m.includes('matched multiple') && m.includes('remote tracking branches')) {
    return `${branch} exists on more than one remote and not on origin, so git can't tell which copy to check out. In a terminal, create a local branch from the remote you want (\`git checkout -b <name> <remote>/<name>\`), then switch to it here.`;
  }

  // A checkout would clobber unsaved work.
  if (m.includes('overwritten by checkout') || m.includes('commit your changes or stash')) {
    return `You have unsaved changes that would be lost. Save or discard them first, then try again.`;
  }

  // The branch lives in another worktree — git refuses to check it out twice.
  // Wording varies across git versions ("is already used by worktree at …",
  // "is already checked out at …") — cover both (issue #406).
  if (m.includes('already used by worktree') || m.includes('already checked out')) {
    return `${branch} is already checked out in another worktree, so it can't be switched to here. Open it from the worktrees list instead.`;
  }

  // The ref handed to `git merge` didn't resolve to a commit ("merge:
  // origin/x - not something we can merge") — the remote branch was deleted
  // or renamed, or the fetch that should have brought it down didn't complete
  // (issue #674).
  if (m.includes('not something we can merge')) {
    return `The branch to merge (${base}) couldn't be found — it may have been deleted or renamed on GitHub, or the latest fetch didn't complete. Refresh your branches and try again.`;
  }

  // Creating a branch from a base whose remote ref is gone: "fatal:
  // 'origin/Y' is not a commit and a branch 'X' cannot be created from it" —
  // the base branch was deleted or renamed on GitHub after the branch list
  // loaded (issue #692). The backend classifies this Expected with its own
  // friendly wording (see BACKEND_HUMANIZED_GIT_PHRASES); this matches git's
  // raw phrasing for any path that misses that classification.
  if (m.includes('is not a commit and a branch')) {
    const missing = raw.match(/'([^']+)' is not a commit/)?.[1];
    return `The branch this was based on${missing ? ` (${missing})` : ''} no longer exists on GitHub. Refresh your branches and try again.`;
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
}

/**
 * True when {@link humanizeGitError} recognized the failure as one of the
 * known, user-actionable git/GitHub conditions (nothing to review, conflicts,
 * out of date, auth, network, protected branch, repo-name collision, existing
 * PR, unsaved changes, worktree collision, unmergeable ref, missing ref, not
 * a repo).
 *
 * The backend classifies many of these as `CommandError::Expected`, but that
 * variant deliberately serializes identically to `Other` across IPC, so the
 * frontend can't read the tag — this is the client-side mirror. Callers use it
 * to route recognized conditions to info toasts / warn logs instead of the
 * error channels that auto-file bug reports (issue #538).
 */
export function isRecognizedGitFailure(value: unknown, ctx: GitErrorContext = {}): boolean {
  const raw = formatCommandError(asCommandError(value));
  // Messages the backend already humanized can come back from
  // humanizeGitError byte-identical (they ARE the friendly form — e.g.
  // gh_network_error's "Couldn't reach GitHub…" maps to the same string), so
  // the inequality test alone would misread them as unrecognized and route
  // an already-classified failure back into telemetry (issue #687).
  if (isBackendHumanizedGitMessage(raw)) {
    return true;
  }
  return humanizeGitError(value, ctx) !== raw;
}

/**
 * Phrases from `register_external_project`'s by-design refusals of a folder
 * pick (backend returns `CommandError::expected` for them, issue #416 — but
 * Expected serializes identically to Other across IPC, so the frontend
 * re-checks the guidance phrases). These are user-guidance states, not bugs:
 * callers log them at warn level and toast them as info (issues #518/#535).
 */
const EXPECTED_IMPORT_REFUSAL_PHRASES = [
  'Please select that folder instead',
  'Please select the specific project folder',
  "doesn't appear to be a project",
  'already inside your projects folder',
  'already registered',
  'your home directory',
];

/** True when an import-local-folder failure message is one of the backend's
 *  by-design refusals (see {@link EXPECTED_IMPORT_REFUSAL_PHRASES}). */
export function isExpectedProjectImportRefusal(message: string): boolean {
  return EXPECTED_IMPORT_REFUSAL_PHRASES.some((phrase) => message.includes(phrase));
}

/**
 * True when a caught error means the selected agent's CLI isn't installed —
 * the backend's `find_agent_binary` returns `CommandError::expected("<Agent>
 * binary not found")` for exactly this (issue #250), but Expected can't cross
 * the IPC boundary, so match the message shape. A missing CLI is a
 * user-environment state, not a bug: log it at warn level (issue #594).
 */
export function isAgentNotInstalledError(value: unknown): boolean {
  return /binary not found/i.test(formatCommandError(asCommandError(value)));
}

/**
 * True when a caught backend error means a project's root folder is gone —
 * deleted, renamed, or moved outside Ship Studio while its session stayed
 * open. The backend classifies this `CommandError::expected` (see
 * `canonicalize_tagged` in `src-tauri/src/utils.rs`, issues #365/#372), but
 * Expected serializes identically to Other across IPC, so callers re-check
 * the message shape. Permanent for that path — retrying can never succeed,
 * so callers should stop polling / suppress repeat surfacing (issue #629).
 */
export function isProjectFolderGoneError(value: unknown): boolean {
  const message = formatCommandError(asCommandError(value));
  return (
    message.includes('no longer exists — it may have been moved') ||
    message.includes('Invalid path in validate_project_path')
  );
}

/**
 * True when a caught backend error is the spawn-time resource-pressure
 * refusal — `spawn_resource_pressure_error` in
 * `src-tauri/src/external_command.rs` ("Couldn't start `<cmd>` — your system
 * is temporarily low on process resources or open files…"), raised when the
 * OS can't fork/exec because the machine is out of PIDs or file descriptors.
 *
 * The backend classifies it `CommandError::expected`, but Expected serializes
 * identically to Other across IPC, so callers re-check the wording. It's a
 * transient machine state, not a bug: route it to warn logs / info toasts
 * instead of the channels that auto-file bug reports.
 */
export function isResourcePressureError(value: unknown): boolean {
  const message = formatCommandError(asCommandError(value)).toLowerCase();
  return (
    message.includes('temporarily low on process resources') ||
    message.includes('close some apps or terminal tabs')
  );
}

/**
 * Exit-code → actionable-message mappings shared by the PTY-driven flows
 * (project creation, GitHub import) that run `git clone` / package installs.
 */
const PROCESS_EXIT_MESSAGES: Record<number, string> = {
  243: "npm couldn't access its cache directory (~/.npm). This usually happens when npm was previously run with sudo.\n\nTo fix, open a terminal and run:\nsudo chown -R $(whoami) ~/.npm",
  128: "Git authentication failed. Make sure you're signed into GitHub.",
};

/** Result of {@link describeProcessError}. */
export interface ProcessErrorInfo {
  /** User-facing, actionable message. */
  message: string;
  /**
   * True when the failure is a recognized user-environment state (stale
   * credentials, missing tool, auth setup) rather than an app bug. Callers
   * should log these at warn level — `logger.error` auto-files bug reports,
   * and these aren't bugs.
   */
  expected: boolean;
}

/**
 * Map a caught error from a PTY-driven process (clone, install, …) to a
 * user-friendly message plus an expected/unexpected classification.
 *
 * Handles Error instances, plain strings, and CommandError objects from
 * `invoke()` rejections — the latter are plain objects (NOT `instanceof
 * Error`), so naive `String(err)` renders them as "[object Object]".
 * "Process exited with code N" messages are mapped to actionable advice;
 * callers can extend the exit-code map for flow-specific codes.
 */
export function describeProcessError(
  err: unknown,
  extraExitCodeMessages?: Record<number, string>
): ProcessErrorInfo {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : formatCommandError(asCommandError(err));
  const lower = msg.toLowerCase();
  // Git-over-SSH auth failure. `gh repo clone` wraps git and exits with its
  // own code 1, so the exit-code-128 mapping below never matches — the raw
  // shell dump ("Permission denied (publickey)…") reached the user instead
  // (issue #531). The wording mirrors humanizeGitError's auth branch but
  // points at the SSH-specific fixes.
  if (
    lower.includes('permission denied (publickey)') ||
    lower.includes('host key verification failed') ||
    lower.includes('could not read from remote repository')
  ) {
    return {
      expected: true,
      message:
        "GitHub couldn't authenticate this computer over SSH, so the repository couldn't be reached. Either set up an SSH key for your GitHub account (github.com/settings/keys), or switch to HTTPS by running `gh config set git_protocol https` in a terminal, then try again.",
    };
  }
  // Git-over-HTTPS credential failure: no usable credential helper, so git
  // fell back to an interactive username/password prompt — which a GUI-spawned
  // process can't answer ("Device not configured" / "terminal prompts
  // disabled"). The HTTPS counterpart of the SSH branch above: a
  // user-credential-setup state, not an app bug (issue #637).
  if (
    lower.includes('could not read username for') ||
    lower.includes('could not read password for')
  ) {
    return {
      expected: true,
      message:
        "GitHub couldn't authenticate this computer over HTTPS — git needed to ask for a password, and there's no saved credential to use. Open a terminal and run `gh auth login`, then `gh auth setup-git`, and try again.",
    };
  }
  // Windows path-length limit during clone checkout: the download itself
  // succeeded, but git couldn't write files whose paths exceed Windows'
  // 260-character default ("error: unable to create file <path>: Filename too
  // long", then "fatal: unable to checkout working tree" / "Clone succeeded,
  // but checkout failed."). A machine-configuration state with a one-line
  // fix, not an app bug — without this branch the raw clone dump reached the
  // user (issue #701).
  if (
    lower.includes('filename too long') ||
    lower.includes('unable to checkout working tree') ||
    lower.includes('clone succeeded, but checkout failed')
  ) {
    return {
      expected: true,
      message:
        "The repository was downloaded, but some of its files have names or paths longer than Windows allows by default, so git couldn't write them. Open a terminal and run `git config --global core.longpaths true` (and enable Windows long-path support — LongPathsEnabled — if it still fails), then delete the incomplete project folder and try again.",
    };
  }
  // GitHub's own API returning a transient 5xx (e.g. "HTTP 504: We couldn't
  // respond to your request in time…" from api.github.com/graphql during
  // `gh repo clone`). gh exits with the generic code 1, so only the wording
  // identifies it — a GitHub-side blip with a built-in retry suggestion, not
  // an app bug (issue #620). HTTP 499 ("Client Closed Request", nginx's code
  // for a request GitHub's edge abandoned before responding) is the same
  // class of transient, GitHub-side blip despite not being a 5xx — it fell
  // through the `5\d\d` regex and reached telemetry unclassified (issue #806).
  if (
    /http (?:499|5\d\d)/.test(lower) ||
    lower.includes('respond to your request in time') ||
    lower.includes('gateway timeout') ||
    lower.includes('service unavailable') ||
    lower.includes('bad gateway')
  ) {
    return {
      expected: true,
      message:
        "GitHub's API is temporarily unavailable — this happens during brief GitHub outages. Wait a moment and try again.",
    };
  }
  // npm registry auth failure (E401). npm exits with the generic code 1, so
  // the exit-code table can't catch it — match the error text instead
  // (issue #505).
  if (
    /npm (?:error|err!) code e401/.test(lower) ||
    lower.includes('incorrect or missing password') ||
    lower.includes('this command requires you to be logged in') ||
    lower.includes('unable to authenticate, your authentication token seems to be invalid')
  ) {
    return {
      expected: true,
      message:
        "npm couldn't sign in to the package registry — your saved npm login or token is expired or incorrect. Open a terminal and run `npm login` (or refresh the token in your .npmrc if this project uses a private registry), then try again.",
    };
  }
  // npm refusing a peer-dependency conflict declared by the project itself
  // ("npm error code ERESOLVE" / "unable to resolve dependency tree"). npm
  // exits with the generic code 1, so only the wording identifies it — a
  // property of the target repo's own package.json, not an app bug, and the
  // raw multi-line dump gave the user nothing to act on (issues #781/#788).
  if (lower.includes('eresolve') || lower.includes('unable to resolve dependency tree')) {
    return {
      expected: true,
      message:
        "This project's dependencies have a version conflict npm won't resolve on its own (see the peer dependency mismatch in the output). Update the conflicting package to a version they agree on, or re-run the install with `--legacy-peer-deps` if that's safe for this project.",
    };
  }
  // Corrupted pnpm store: the content-addressable cache has dangling links,
  // so installs die with "ENOENT: no such file or directory, open
  // '…/pnpm/store/v11/links/…'". A local-cache state that `pnpm store prune`
  // repairs, not an app or project bug (issue #681). Checked before the
  // generic exit-code mapping — only the ENOENT text identifies it.
  if (lower.includes('enoent') && (lower.includes('pnpm/store') || lower.includes('pnpm\\store'))) {
    return {
      expected: true,
      message:
        "pnpm's local package cache looks corrupted. Open a terminal and run `pnpm store prune`, then retry the install.",
    };
  }
  // pnpm's build-script approval gate: the install itself succeeded, but
  // pnpm (10+) exits 1 refusing to run dependency build scripts until the
  // user approves them — "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts:
  // esbuild@0.28.1" / "Run \"pnpm approve-builds\" to pick which dependencies
  // should be allowed to run scripts." Routine pnpm safety behavior, not an
  // app or project bug — mirror the guidance extractTerminalError
  // (terminalDiagnostics.ts) already gives the other install surfaces
  // (issues #670/#671, precedent #469).
  if (lower.includes('err_pnpm_ignored_builds') || lower.includes('approve-builds')) {
    return {
      expected: true,
      message:
        'pnpm blocked dependency build scripts pending your approval. In a terminal, run `pnpm approve-builds` in the project folder, approve the listed packages, then retry the install.',
    };
  }
  // Git exits 128 for many fatal, non-auth reasons, but the exit-code table
  // below maps every 128 to "Git authentication failed" — actively wrong for
  // the project-creation clone, whose templates are public repos fetched
  // anonymously with no GitHub sign-in involved at all. The reported cases
  // were a NAS / mapped network drive: git couldn't create or write the
  // destination, or its dubious-ownership check tripped on a share reporting
  // foreign owner metadata (issue #841). Named causes first, so the blanket
  // mapping only ever sees what none of these explain.
  if (lower.includes('detected dubious ownership')) {
    return {
      expected: true,
      message:
        "Git refused to use this folder because the operating system reports it as owned by a different user — common on NAS, network, and external drives. Open a terminal and run `git config --global --add safe.directory '<the project folder>'`, or move your projects folder to a local disk, then try again.",
    };
  }
  if (
    lower.includes('could not create work tree dir') ||
    lower.includes('could not create leading directories') ||
    lower.includes('unable to create directory') ||
    lower.includes('unable to write new index file') ||
    lower.includes('read-only file system') ||
    lower.includes('input/output error')
  ) {
    return {
      expected: true,
      message:
        "Git couldn't write to your projects folder. That usually means it's on a NAS, network, or external drive that dropped out or won't accept the write — this isn't a GitHub sign-in problem. Check the drive is connected and writable, or move your projects folder to a local disk, then try again.",
    };
  }
  if (lower.includes('no space left on device')) {
    return {
      expected: true,
      message:
        'The drive your projects folder is on has run out of space. Free some up, then try again.',
    };
  }
  // The tool itself is missing: Windows' cmd.exe says "'bun' is not
  // recognized…", POSIX shells say "bun: command not found". Both surface a
  // raw shell dump with no next step (issues #454/#455) — name the tool and
  // say what to do.
  const missingTool =
    msg.match(/'([^']+)' is not recognized as an internal or external command/) ??
    msg.match(/(?:^|\n|:\s)([\w.-]+): command not found/);
  if (missingTool) {
    const tool = missingTool[1];
    return {
      expected: true,
      message: `This project needs \`${tool}\`, which isn't installed on this computer (or isn't on your PATH). Install ${tool} and try again — or, for package managers, delete its lockfile to fall back to npm.`,
    };
  }
  // Negative codes (spawn failure / killed by signal) must match too —
  // \d+ alone silently skipped them (issues #463/#464).
  const codeMatch = msg.match(/Process exited with code (-?\d+)/);
  if (codeMatch) {
    const code = parseInt(codeMatch[1], 10);
    const mapped = extraExitCodeMessages?.[code] ?? PROCESS_EXIT_MESSAGES[code];
    if (mapped) return { expected: true, message: mapped };
  }
  // Strip the "Error: " prefix that comes from Error.toString()
  return { expected: false, message: msg.replace(/^Error:\s*/, '') };
}

/**
 * Message-only convenience over {@link describeProcessError} for call sites
 * that don't need the expected/unexpected classification.
 */
export function friendlyProcessError(
  err: unknown,
  extraExitCodeMessages?: Record<number, string>
): string {
  return describeProcessError(err, extraExitCodeMessages).message;
}

/**
 * User-facing message for a failed GitHub accounts load (username + orgs).
 *
 * A blown time budget means a slow network, not stale credentials — "sign
 * out and back in" can't fix it (issue #686). Matches both the raw Timeout
 * wording ("`gh api user` timed out after 15s") and the backend's Expected
 * mapping ("GitHub took too long to respond").
 */
export function describeAccountsLoadError(err: unknown): string {
  const message = formatCommandError(asCommandError(err));
  const isTimeout = /timed out|took too long/i.test(message);
  return (
    `Couldn't load your GitHub accounts: ${message}. ` +
    (isTimeout
      ? 'Check your internet connection and try again.'
      : 'Try signing out and back into GitHub.')
  );
}
