import { describe, it, expect } from 'vitest';
import {
  asCommandError,
  describeProcessError,
  formatCommandError,
  friendlyProcessError,
  humanizeGitError,
  isAgentNotInstalledError,
  isExpectedProjectImportRefusal,
  isMergeConflictError,
  isProjectFolderGoneError,
  isRecognizedGitFailure,
  type CommandError,
} from './errors';

describe('asCommandError', () => {
  it('passes through an already-tagged CommandError', () => {
    const err: CommandError = { type: 'Timeout', cmd: 'git', secs: 5 };
    expect(asCommandError(err)).toBe(err);
  });

  it('wraps a plain string as Other', () => {
    expect(asCommandError('boom')).toEqual({ type: 'Other', message: 'boom' });
  });

  it('wraps an Error instance using its message', () => {
    expect(asCommandError(new Error('kaboom'))).toEqual({ type: 'Other', message: 'kaboom' });
  });

  it('coerces an arbitrary unknown via String()', () => {
    expect(asCommandError(42)).toEqual({ type: 'Other', message: '42' });
    expect(asCommandError(null)).toEqual({ type: 'Other', message: 'null' });
  });
});

describe('formatCommandError', () => {
  it('renders every variant to a user-facing string', () => {
    expect(formatCommandError({ type: 'Timeout', cmd: 'git', secs: 5 })).toBe(
      '`git` timed out after 5s'
    );
    expect(formatCommandError({ type: 'Process', cmd: 'git', exit_code: 1, stderr: 'bad' })).toBe(
      '`git` exited with status 1: bad'
    );
    expect(formatCommandError({ type: 'Validation', field: 'path', reason: 'empty' })).toBe(
      'Validation failed for `path`: empty'
    );
    expect(formatCommandError({ type: 'NotAuthenticated', service: 'GitHub' })).toBe(
      'Not authenticated with GitHub'
    );
    expect(formatCommandError({ type: 'Io', message: 'disk full' })).toBe('I/O error: disk full');
    expect(formatCommandError({ type: 'MergeConflict', pr_number: 7, stderr: 'conflict' })).toBe(
      "Pull request #7 can't be merged cleanly: conflict"
    );
    expect(formatCommandError({ type: 'Other', message: 'just a message' })).toBe('just a message');
  });
});

describe('friendlyProcessError', () => {
  it('formats a CommandError object instead of "[object Object]"', () => {
    const err: CommandError = { type: 'Process', cmd: 'git', exit_code: 1, stderr: 'fatal: nope' };
    expect(friendlyProcessError(err)).toBe('`git` exited with status 1: fatal: nope');
    expect(friendlyProcessError({ type: 'Io', message: 'disk full' })).toBe('I/O error: disk full');
    expect(friendlyProcessError({ type: 'Io', message: 'disk full' })).not.toContain(
      '[object Object]'
    );
  });

  it('maps "Process exited with code 243" to the npm cache advice', () => {
    const result = friendlyProcessError(new Error('Process exited with code 243\n\nnpm ERR!'));
    expect(result).toContain('~/.npm');
    expect(result).toContain('sudo chown');
  });

  it('maps "Process exited with code 128" to git auth advice', () => {
    expect(friendlyProcessError('Process exited with code 128')).toBe(
      "Git authentication failed. Make sure you're signed into GitHub."
    );
  });

  it('passes an Error instance message through unchanged', () => {
    expect(friendlyProcessError(new Error('clone failed'))).toBe('clone failed');
  });

  it("maps Windows' \"'bun' is not recognized\" to install guidance", () => {
    // Raw cmd.exe text when the lockfile's package manager isn't installed
    // (issues #454/#455).
    const raw =
      "Process exited with code 1\n\n'bun' is not recognized as an internal or external command,\noperable program or batch file.";
    const result = friendlyProcessError(raw);
    expect(result).toContain('`bun`');
    expect(result).toMatch(/isn't installed/);
  });

  it('maps POSIX "command not found" to install guidance', () => {
    const result = friendlyProcessError('sh: pnpm: command not found');
    expect(result).toContain('`pnpm`');
    expect(result).toMatch(/isn't installed/);
  });

  it('matches negative exit codes via extra mappings', () => {
    // Spawn failures emit -1 — the old /\d+/ regex silently skipped them
    // (issues #463/#464).
    const extra = { [-1]: 'The process never started.' };
    expect(friendlyProcessError('Process exited with code -1', extra)).toBe(
      'The process never started.'
    );
  });

  it('strips the "Error: " prefix from stringified errors', () => {
    expect(friendlyProcessError('Error: clone failed')).toBe('clone failed');
  });

  it('maps git-over-SSH publickey failures to SSH/HTTPS guidance (issue #531)', () => {
    // gh wraps git and exits 1, so only the text identifies the failure.
    const raw =
      "Process exited with code 1\n\nCloning into 'laisy-full'...\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\nPlease make sure you have the correct access rights\nand the repository exists.\nfailed to run git: exit status 128";
    const info = describeProcessError(raw);
    expect(info.expected).toBe(true);
    expect(info.message).toMatch(/SSH/);
    expect(info.message).toContain('gh config set git_protocol https');
    expect(info.message).not.toContain('Cloning into');
  });

  it('maps npm E401 registry auth failures to `npm login` guidance (issue #505)', () => {
    const raw =
      'Process exited with code 1\n\nnpm warn deprecated something\nnpm error code E401\nnpm error Incorrect or missing password.\nnpm error To correct this please try logging in again with:\nnpm error   npm login';
    const info = describeProcessError(raw);
    expect(info.expected).toBe(true);
    expect(info.message).toContain('npm login');
    expect(info.message).not.toContain('npm warn');
    // Legacy "npm ERR!" prefix matches too.
    expect(describeProcessError('npm ERR! code E401').expected).toBe(true);
  });

  it('maps HTTPS credential-prompt failures to gh auth guidance (issue #637)', () => {
    const raw =
      "Process exited with code 1\n\nCloning into 'ogeh-ai-website'...\nfatal: could not read Password for 'https://user@github.com': Device not configured\nfailed to run git: exit status 128";
    const info = describeProcessError(raw);
    expect(info.expected).toBe(true);
    expect(info.message).toContain('gh auth login');
    expect(info.message).not.toContain('Cloning into');
    // The Username variant (and GIT_TERMINAL_PROMPT=0's wording) match too.
    expect(
      describeProcessError(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
      ).expected
    ).toBe(true);
  });

  it('maps GitHub API 5xx responses to a friendly retry message (issue #620)', () => {
    const raw =
      'Process exited with code 1\n\nHTTP 504: We couldn’t respond to your request in time. Sorry about that. Please try resubmitting your request and contact us if the problem persists. (https://api.github.com/graphql)';
    const info = describeProcessError(raw);
    expect(info.expected).toBe(true);
    expect(info.message).toMatch(/temporarily unavailable/i);
    // The terse variant classifies too.
    expect(
      describeProcessError('HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)')
        .expected
    ).toBe(true);
    expect(describeProcessError('HTTP 502: Bad Gateway (https://api.github.com)').expected).toBe(
      true
    );
  });

  it('maps pnpm approve-builds gates to actionable guidance (issues #670/#671)', () => {
    // Exact shape from issue #671: install succeeded, pnpm exits 1 pending
    // build-script approval.
    const fromImport =
      'Process exited with code 1\n\n✓ Lockfile passes supply-chain policies (539 entries in 10.6s)\nPackages: +423\n[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.1\nRun "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.';
    const info = describeProcessError(fromImport);
    expect(info.expected).toBe(true);
    expect(info.message).toContain('pnpm approve-builds');
    expect(info.message).not.toContain('ERR_PNPM_IGNORED_BUILDS');
    // Exact shape from issue #670 (install retry, lockfile up to date).
    const fromRetry =
      'Process exited with code 1\n\nLockfile is up to date, resolution step is skipped\nAlready up to date\n[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.1\nRun "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.';
    const retryInfo = describeProcessError(fromRetry);
    expect(retryInfo.expected).toBe(true);
    expect(retryInfo.message).toContain('pnpm approve-builds');
    // Either wording alone is enough — the error code line and the prompt
    // line can arrive separately depending on how output is truncated.
    expect(
      describeProcessError('[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.1')
        .expected
    ).toBe(true);
    expect(
      describeProcessError(
        'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.'
      ).expected
    ).toBe(true);
  });

  it('classifies recognized shapes as expected and unknown ones as not', () => {
    expect(describeProcessError('sh: pnpm: command not found').expected).toBe(true);
    expect(describeProcessError('Process exited with code 128').expected).toBe(true);
    expect(describeProcessError(new Error('segfault in importer')).expected).toBe(false);
  });

  it('supports caller-provided extra exit-code mappings', () => {
    const extra = { 69: 'Accept the Xcode license first.' };
    expect(friendlyProcessError(new Error('Process exited with code 69'), extra)).toBe(
      'Accept the Xcode license first.'
    );
    // Without the extra map, unknown codes fall through to the raw message
    expect(friendlyProcessError(new Error('Process exited with code 69'))).toBe(
      'Process exited with code 69'
    );
    // Shared mappings still apply when an extra map is provided
    expect(friendlyProcessError('Process exited with code 128', extra)).toBe(
      "Git authentication failed. Make sure you're signed into GitHub."
    );
  });
});

describe('isMergeConflictError', () => {
  it('is true only for the MergeConflict variant', () => {
    expect(isMergeConflictError({ type: 'MergeConflict', pr_number: 1, stderr: '' })).toBe(true);
    expect(isMergeConflictError({ type: 'Timeout', cmd: 'git', secs: 1 })).toBe(false);
    expect(isMergeConflictError('plain string error')).toBe(false);
  });
});

describe('humanizeGitError', () => {
  // Substring heuristics regress invisibly — lock each recognized failure
  // class to a representative raw git/gh message.
  const cases: Array<{ raw: string; expect: RegExp }> = [
    {
      raw: 'GraphQL: No commits between develop and feat/empty (createPullRequest)',
      expect: /nothing to review yet/i,
    },
    {
      raw: 'CONFLICT (content): Merge conflict in src/App.tsx\nAutomatic merge failed',
      expect: /can't be merged .* automatically/i,
    },
    {
      raw: '! [rejected]  main -> main (non-fast-forward)\nerror: failed to push',
      expect: /newer changes on GitHub/i,
    },
    {
      raw: 'remote: Permission denied (publickey).\nfatal: Could not read from remote repository',
      expect: /didn't accept the connection/i,
    },
    {
      // GitHub's no-write-access rejection splits "permission"/"denied" with
      // the repo name — must still classify as an auth failure (issue #321).
      raw: 'ERROR: Permission to acme/site.git denied to somebody.\nfatal: Could not read from remote repository.',
      expect: /didn't accept the connection/i,
    },
    {
      // HTTPS no-write-access rejection: "Write access to repository not
      // granted." + 403 — must classify as auth, not network (issue #343).
      raw: "remote: Write access to repository not granted.\nfatal: unable to access 'https://github.com/acme/site.git/': The requested URL returned error: 403",
      expect: /didn't accept the connection/i,
    },
    {
      raw: 'fatal: unable to access https://github.com/a/b: Could not resolve host: github.com',
      expect: /couldn't reach GitHub/i,
    },
    {
      // Windows Go dial error from the gh CLI — contains none of the usual
      // timeout/refused/resolve substrings (issue #375).
      raw: 'Post "https://api.github.com/graphql": dial tcp 20.207.73.85:443: connectex: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.',
      expect: /couldn't reach GitHub/i,
    },
    {
      raw: 'remote: error: GH006: Protected branch update failed for refs/heads/main',
      expect: /protected, so changes can't be pushed/i,
    },
    {
      raw: 'GraphQL: A pull request already exists for julian:feat/x. (createPullRequest)',
      expect: /already an open pull request/i,
    },
    {
      raw: 'error: Your local changes to the following files would be overwritten by checkout',
      expect: /unsaved changes that would be lost/i,
    },
    {
      // Branch held by another worktree (e.g. an agent CLI's own
      // .claude/worktrees) — must not surface as a raw fatal (issue #406).
      raw: "fatal: 'worktree-kasus-trainer' is already used by worktree at '/Users/x/proj/.claude/worktrees/kasus-trainer'",
      expect: /already checked out in another worktree/i,
    },
    {
      // Newer git wording for the same refusal.
      raw: "fatal: 'feat/x' is already checked out at '/Users/x/proj/.claude/worktrees/feat-x'",
      expect: /already checked out in another worktree/i,
    },
    {
      // gh failing before any subcommand because its own config file is
      // unreadable — a local file-permissions problem, NOT a sign-in failure;
      // must not fall into the generic "permission denied" auth branch
      // (issue #631).
      raw: 'warning: failed to load config: open /Users/x/.config/gh/config.yml: permission denied\nfailed to create root command: failed to read configuration: open /Users/x/.config/gh/config.yml: permission denied',
      expect: /can't read its own settings.*chown/is,
    },
    {
      // Go's bare net/http "EOF" — connection closed before any response byte
      // (issue #642; the "unexpected EOF" variant was #434).
      raw: 'Post "https://api.github.com/graphql": EOF',
      expect: /couldn't reach GitHub/i,
    },
    {
      raw: 'Post "https://api.github.com/graphql": unexpected EOF',
      expect: /couldn't reach GitHub/i,
    },
    {
      // TLS interception by a corporate proxy/AV — must get trust-store
      // guidance, not "check your internet connection" (issue #658).
      raw: 'Post "https://api.github.com/graphql": tls: failed to verify certificate: x509: certificate signed by unknown authority',
      expect: /secure connection couldn't be verified/i,
    },
    {
      raw: "error: pathspec 'feat/gone' did not match any file(s) known to git",
      expect: /no longer exists/i,
    },
    {
      raw: 'fatal: not a git repository (or any of the parent directories): .git',
      expect: /isn't set up with git yet/i,
    },
    {
      // Create-repo name collision — the backend's #279 friendly refusal.
      // Must be recognized so GitHubButton's toast stays off the error /
      // telemetry channel (issues #666/#667).
      raw: 'A repository named "acme/site" already exists on this account. Choose a different name.',
      expect: /repository named "acme\/site" already exists on this GitHub account/i,
    },
    {
      // gh's raw wording for the same collision, in case the backend
      // classification is bypassed.
      raw: 'GraphQL: Name already exists on this account (createRepository)',
      expect: /already exists on this GitHub account/i,
    },
    {
      // The ref handed to `git merge` didn't resolve — remote branch deleted
      // or fetch incomplete (issue #674).
      raw: 'Failed to merge: merge: origin/chore/remove-footer-logomark-block - not something we can merge',
      expect: /couldn't be found.*deleted or renamed/i,
    },
    {
      // `git checkout -b X origin/Y` when the base's remote ref is gone —
      // must name the missing base, not surface a raw fatal (issue #692).
      raw: "fatal: 'origin/feat/base' is not a commit and a branch 'feat/new' cannot be created from it",
      expect: /\(origin\/feat\/base\) no longer exists on GitHub.*refresh your branches/i,
    },
    {
      // gh's own top-level DNS-failure output — it swallows the Go error and
      // prints only this guidance (issue #473).
      raw: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com',
      expect: /couldn't reach GitHub/i,
    },
  ];

  it.each(cases)('humanizes: $raw', ({ raw, expect: pattern }) => {
    expect(humanizeGitError(raw)).toMatch(pattern);
  });

  it('names the branches from context', () => {
    const msg = humanizeGitError('GraphQL: No commits between develop and feat/empty', {
      branch: 'feat/empty',
      base: 'develop',
    });
    expect(msg).toContain('feat/empty');
    expect(msg).toContain('develop');
  });

  it('falls back to the formatted raw message when nothing matches', () => {
    expect(humanizeGitError('some completely novel git failure')).toBe(
      'some completely novel git failure'
    );
  });

  it('isRecognizedGitFailure mirrors whether humanizeGitError classified the error', () => {
    // Recognized, by-design refusals (backend marks these Expected, but the
    // tag can't cross IPC — issue #538).
    expect(isRecognizedGitFailure('GraphQL: No commits between develop and feat/empty')).toBe(true);
    expect(
      isRecognizedGitFailure('GraphQL: A pull request already exists for julian:feat/x.')
    ).toBe(true);
    expect(isRecognizedGitFailure('remote: Permission denied (publickey).')).toBe(true);
    // Repo-name collision (issues #666/#667) and unresolvable merge ref
    // (issue #674) are recognized too.
    expect(
      isRecognizedGitFailure(
        'A repository named "acme/site" already exists on this account. Choose a different name.'
      )
    ).toBe(true);
    expect(
      isRecognizedGitFailure('Failed to merge: merge: origin/gone - not something we can merge')
    ).toBe(true);
    expect(
      isRecognizedGitFailure({ type: 'Process', cmd: 'gh', exit_code: 1, stderr: 'dial tcp: nope' })
    ).toBe(true);
    // Unrecognized failures fall through — those stay on the error channels.
    expect(isRecognizedGitFailure('some completely novel git failure')).toBe(false);
    expect(isRecognizedGitFailure(new Error('segfault in gh'))).toBe(false);
  });

  // The backend's own Expected friendly strings (github.rs / branches.rs)
  // arrive tagged as Other over IPC and pass through humanizeGitError
  // unchanged (they're already the friendly form) — they must still count as
  // recognized so they never re-enter the error/telemetry channels
  // (issue #687). Keep these literals byte-identical to the Rust strings.
  it('recognizes backend-authored friendly Expected messages (issue #687)', () => {
    const backendMessages = [
      // gh_network_error
      "Couldn't reach GitHub. Check your internet connection and try again.",
      // the gh timeout mapping (issue #686)
      'GitHub took too long to respond. Check your internet connection and try again.',
      // gh_tls_error
      "GitHub's secure connection couldn't be verified. This usually means a corporate proxy, VPN, or antivirus is inspecting HTTPS traffic on this computer (its certificate isn't trusted yet), or the system's certificate store is out of date. Install your proxy's certificate or update your system, then try again.",
      // gh_server_error
      "GitHub's API is temporarily unavailable (a GitHub server error). Try again in a moment.",
      // gh_malformed_request_error
      "GitHub couldn't process the request (a temporary GitHub API error). Try again in a moment.",
      // gh_config_error
      "The GitHub CLI (gh) can't read its own settings because of a file-permissions problem on this computer — this isn't a GitHub sign-in issue. Open a terminal and run `sudo chown -R $(whoami) ~/.config/gh`, then try again.",
      // gh_crash_error (both variants)
      'The GitHub CLI (gh) crashed unexpectedly. Try again — if it keeps happening, reinstalling the GitHub CLI may help.',
      "The GitHub CLI (gh) couldn't start because the system is low on memory. Close some other apps (on Windows, increasing the paging file size can also help) and try again.",
      // create_branch's vanished base ref (issue #692)
      'The branch this was based on no longer exists on GitHub. Refresh your branches and try again.',
    ];
    for (const message of backendMessages) {
      expect(isRecognizedGitFailure(message), message).toBe(true);
      // The humanized form must stay friendly — either the backend's own
      // wording passed through or an equivalent frontend humanization, never
      // a regression to raw stderr.
      expect(humanizeGitError(message)).not.toBe('');
    }
  });

  it('accepts CommandError objects, not just strings', () => {
    const err: CommandError = {
      type: 'Timeout',
      cmd: 'git push',
      secs: 30,
    } as unknown as CommandError;
    // Timeout formats to a "timed out" message → the network case.
    expect(humanizeGitError(err)).toMatch(/couldn't reach GitHub/i);
  });
});

describe('isExpectedProjectImportRefusal', () => {
  // The backend's by-design refusals of a folder pick (issue #416) — each of
  // these is user guidance, not a bug, and must classify as expected so the
  // import flow logs at warn and toasts as info (issues #518/#535).
  const expectedMessages = [
    'This folder is inside a git repository rooted at /x. Please select that folder instead.',
    'This looks like a monorepo. Please select the specific project folder you want to work on.',
    "This folder doesn't appear to be a project (no package.json, index.html, or .git found).",
    'This project is already inside your projects folder. It will appear automatically.',
    'This folder is already registered.',
    "That's your home directory — pick the project folder itself.",
  ];

  it.each(expectedMessages)('classifies as expected: %s', (message) => {
    expect(isExpectedProjectImportRefusal(message)).toBe(true);
  });

  it('does not classify genuine failures as expected', () => {
    expect(isExpectedProjectImportRefusal('EACCES: permission denied, open config.json')).toBe(
      false
    );
    expect(isExpectedProjectImportRefusal('I/O error: disk full')).toBe(false);
  });
});

describe('isAgentNotInstalledError', () => {
  it("matches the backend's `<Agent> binary not found` Expected message", () => {
    expect(isAgentNotInstalledError('Codex binary not found')).toBe(true);
    expect(isAgentNotInstalledError('OpenCode binary not found')).toBe(true);
    expect(isAgentNotInstalledError({ type: 'Other', message: 'Claude binary not found' })).toBe(
      true
    );
  });

  it('does not match other failures', () => {
    expect(isAgentNotInstalledError('Failed to add MCP server: connection refused')).toBe(false);
    expect(isAgentNotInstalledError(new Error('spawn ENOENT'))).toBe(false);
  });
});

describe('isProjectFolderGoneError', () => {
  it("matches canonicalize_tagged's folder-gone message (#365/#629)", () => {
    expect(
      isProjectFolderGoneError({
        type: 'Other',
        message:
          "The folder '/Users/me/ShipStudio/demo' no longer exists — it may have been moved, renamed, or deleted outside Ship Studio",
      })
    ).toBe(true);
  });

  it("matches validate_project_path's invalid-path rejection", () => {
    expect(
      isProjectFolderGoneError('Invalid path in validate_project_path: /Users/me/ShipStudio/demo')
    ).toBe(true);
  });

  it('does not match a branch-gone message or unrelated failures', () => {
    // humanizeGitError's missing-ref wording also says "no longer exists" —
    // the helper must key on the backend's fuller folder-gone phrase.
    expect(
      isProjectFolderGoneError('feature/x no longer exists. It may have been deleted or renamed.')
    ).toBe(false);
    expect(isProjectFolderGoneError(new Error('connection refused'))).toBe(false);
  });
});
