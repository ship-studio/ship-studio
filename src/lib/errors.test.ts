import { describe, it, expect } from 'vitest';
import {
  asCommandError,
  formatCommandError,
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

describe('isMergeConflictError', () => {
  it('is true only for the MergeConflict variant', () => {
    expect(isMergeConflictError({ type: 'MergeConflict', pr_number: 1, stderr: '' })).toBe(true);
    expect(isMergeConflictError({ type: 'Timeout', cmd: 'git', secs: 1 })).toBe(false);
    expect(isMergeConflictError('plain string error')).toBe(false);
  });
});
