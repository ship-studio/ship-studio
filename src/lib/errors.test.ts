import { describe, it, expect } from 'vitest';
import {
  asCommandError,
  formatCommandError,
  friendlyProcessError,
  humanizeGitError,
  isMergeConflictError,
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

  it('strips the "Error: " prefix from stringified errors', () => {
    expect(friendlyProcessError('Error: clone failed')).toBe('clone failed');
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
      raw: 'fatal: unable to access https://github.com/a/b: Could not resolve host: github.com',
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
      raw: "error: pathspec 'feat/gone' did not match any file(s) known to git",
      expect: /no longer exists/i,
    },
    {
      raw: 'fatal: not a git repository (or any of the parent directories): .git',
      expect: /isn't set up with git yet/i,
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
