/**
 * Tests for git operations wrapper (src/lib/git.ts).
 *
 * These tests verify that each wrapper:
 * - Calls invoke() with the correct command name and arg shape
 * - Returns the resolved value unchanged
 * - Propagates errors to the caller
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChangedFile, FileDiff } from './git';
import { getChangedFiles, getFileDiff, gitPull, commitChanges } from './git';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('lib/git', () => {
  let core: typeof import('@tauri-apps/api/core');

  beforeEach(async () => {
    vi.clearAllMocks();
    core = await import('@tauri-apps/api/core');
  });

  // ============ getChangedFiles ============

  describe('getChangedFiles', () => {
    it('invokes "get_changed_files" with projectPath and returns the file list', async () => {
      const files: ChangedFile[] = [
        { path: 'src/index.ts', status: 'modified' },
        { path: 'README.md', status: 'added' },
      ];
      vi.mocked(core.invoke).mockResolvedValue(files);

      const result = await getChangedFiles('/abs/project');

      expect(core.invoke).toHaveBeenCalledTimes(1);
      expect(core.invoke).toHaveBeenCalledWith('get_changed_files', {
        projectPath: '/abs/project',
      });
      expect(result).toEqual(files);
    });

    it('returns an empty array when backend returns empty', async () => {
      vi.mocked(core.invoke).mockResolvedValue([]);

      const result = await getChangedFiles('/abs/project');

      expect(result).toEqual([]);
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('git status failed'));

      await expect(getChangedFiles('/abs/project')).rejects.toThrow('git status failed');
    });
  });

  // ============ getFileDiff ============

  describe('getFileDiff', () => {
    it('invokes "get_file_diff" with projectPath and filePath and returns the diff', async () => {
      const diff: FileDiff = {
        filePath: 'src/foo.ts',
        isNewFile: false,
        isDeleted: false,
        isBinary: false,
        content: '@@ -1 +1 @@\n-old\n+new',
        additions: 1,
        deletions: 1,
      };
      vi.mocked(core.invoke).mockResolvedValue(diff);

      const result = await getFileDiff('/abs/project', 'src/foo.ts');

      expect(core.invoke).toHaveBeenCalledTimes(1);
      expect(core.invoke).toHaveBeenCalledWith('get_file_diff', {
        projectPath: '/abs/project',
        filePath: 'src/foo.ts',
      });
      expect(result).toEqual(diff);
    });

    it('preserves the full FileDiff shape, including boolean flags', async () => {
      const diff: FileDiff = {
        filePath: 'image.png',
        isNewFile: true,
        isDeleted: false,
        isBinary: true,
        content: '',
        additions: 0,
        deletions: 0,
      };
      vi.mocked(core.invoke).mockResolvedValue(diff);

      const result = await getFileDiff('/abs/project', 'image.png');

      expect(result.isBinary).toBe(true);
      expect(result.isNewFile).toBe(true);
      expect(result.isDeleted).toBe(false);
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('file not found'));

      await expect(getFileDiff('/abs/project', 'missing.ts')).rejects.toThrow('file not found');
    });
  });

  // ============ gitPull ============

  describe('gitPull', () => {
    it('invokes "git_pull" with projectPath and resolves to undefined', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      const result = await gitPull('/abs/project');

      expect(core.invoke).toHaveBeenCalledTimes(1);
      expect(core.invoke).toHaveBeenCalledWith('git_pull', {
        projectPath: '/abs/project',
      });
      expect(result).toBeUndefined();
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('pull rejected: merge conflict'));

      await expect(gitPull('/abs/project')).rejects.toThrow('pull rejected: merge conflict');
    });
  });

  // ============ commitChanges ============

  describe('commitChanges', () => {
    it('invokes "commit_changes" with projectPath + message and returns true when commit was made', async () => {
      vi.mocked(core.invoke).mockResolvedValue(true);

      const result = await commitChanges('/abs/project', 'feat: add widget');

      expect(core.invoke).toHaveBeenCalledTimes(1);
      expect(core.invoke).toHaveBeenCalledWith('commit_changes', {
        projectPath: '/abs/project',
        message: 'feat: add widget',
      });
      expect(result).toBe(true);
    });

    it('returns false when there was nothing to commit', async () => {
      vi.mocked(core.invoke).mockResolvedValue(false);

      const result = await commitChanges('/abs/project', 'noop');

      expect(result).toBe(false);
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('not a git repo'));

      await expect(commitChanges('/abs/project', 'msg')).rejects.toThrow('not a git repo');
    });
  });
});
