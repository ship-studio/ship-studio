/**
 * Tests for the git worktree Tauri wrappers (src/lib/worktrees.ts):
 * snake_case → camelCase mapping, argument passthrough, and the
 * managed-path helper.
 */

import { mockIPC } from '@tauri-apps/api/mocks';
import { describe, it, expect } from 'vitest';
import {
  listWorktrees,
  addWorktree,
  removeWorktree,
  pruneWorktrees,
  isManagedWorktreePath,
  worktreeDisplayName,
} from './worktrees';

describe('listWorktrees', () => {
  it('maps snake_case backend fields to camelCase', async () => {
    mockIPC((cmd, args) => {
      expect(cmd).toBe('list_worktrees');
      expect(args).toEqual({ projectPath: '/p/app' });
      return [
        {
          path: '/p/app',
          head: '1234567',
          branch: 'main',
          is_main: true,
          is_current: true,
          locked: null,
          prunable: null,
          last_commit_date: 1750000000000,
        },
        {
          path: '/p/.worktrees/app/feature-x',
          head: 'abcdef0',
          branch: null,
          is_main: false,
          is_current: false,
          locked: 'on my laptop',
          prunable: 'gitdir file points to non-existent location',
          last_commit_date: null,
        },
      ];
    });

    const result = await listWorktrees('/p/app');
    expect(result).toEqual([
      {
        path: '/p/app',
        head: '1234567',
        branch: 'main',
        isMain: true,
        isCurrent: true,
        locked: null,
        prunable: null,
        lastCommitDate: 1750000000000,
      },
      {
        path: '/p/.worktrees/app/feature-x',
        head: 'abcdef0',
        branch: null,
        isMain: false,
        isCurrent: false,
        locked: 'on my laptop',
        prunable: 'gitdir file points to non-existent location',
        lastCommitDate: null,
      },
    ]);
  });
});

describe('addWorktree', () => {
  it('passes options through and defaults baseRef to null', async () => {
    mockIPC((cmd, args) => {
      expect(cmd).toBe('add_worktree');
      expect(args).toEqual({
        projectPath: '/p/app',
        branch: 'feature-x',
        createBranch: true,
        baseRef: null,
        copyEnv: true,
      });
      return { path: '/p/.worktrees/app/feature-x', port: 3001 };
    });

    const result = await addWorktree('/p/app', {
      branch: 'feature-x',
      createBranch: true,
      copyEnv: true,
    });
    expect(result).toEqual({ path: '/p/.worktrees/app/feature-x', port: 3001 });
  });

  it('forwards an explicit baseRef', async () => {
    mockIPC((_cmd, args) => {
      expect((args as { baseRef: string }).baseRef).toBe('main');
      return { path: '/p/.worktrees/app/fix', port: null };
    });
    const result = await addWorktree('/p/app', {
      branch: 'fix',
      createBranch: true,
      baseRef: 'main',
      copyEnv: false,
    });
    expect(result.port).toBeNull();
  });
});

describe('removeWorktree / pruneWorktrees', () => {
  it('sends force flag (default false)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, ...(args as Record<string, unknown>) });
      return undefined;
    });

    await removeWorktree('/p/app', '/p/.worktrees/app/feature-x');
    await removeWorktree('/p/app', '/p/.worktrees/app/feature-x', true);
    await pruneWorktrees('/p/app');

    expect(calls).toEqual([
      {
        cmd: 'remove_worktree',
        projectPath: '/p/app',
        worktreePath: '/p/.worktrees/app/feature-x',
        force: false,
      },
      {
        cmd: 'remove_worktree',
        projectPath: '/p/app',
        worktreePath: '/p/.worktrees/app/feature-x',
        force: true,
      },
      { cmd: 'prune_worktrees', projectPath: '/p/app' },
    ]);
  });
});

describe('worktreeDisplayName', () => {
  it('renders "<project> / <branch>" for managed worktree paths', () => {
    expect(worktreeDisplayName('/Users/me/ShipStudio/.worktrees/myapp/feature-x')).toBe(
      'myapp / feature-x'
    );
    expect(worktreeDisplayName('C:\\Users\\me\\ShipStudio\\.worktrees\\myapp\\fix')).toBe(
      'myapp / fix'
    );
  });

  it('returns null for regular project paths', () => {
    expect(worktreeDisplayName('/Users/me/ShipStudio/myapp')).toBeNull();
    expect(worktreeDisplayName('/Users/me/code/feature-x')).toBeNull();
  });
});

describe('isManagedWorktreePath', () => {
  it('detects paths under a .worktrees container on both separators', () => {
    expect(isManagedWorktreePath('/Users/me/ShipStudio/.worktrees/app/feature-x')).toBe(true);
    expect(isManagedWorktreePath('C:\\Users\\me\\ShipStudio\\.worktrees\\app\\fix')).toBe(true);
    expect(isManagedWorktreePath('/Users/me/ShipStudio/app')).toBe(false);
  });
});
