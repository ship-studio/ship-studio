/**
 * Tests for project management Tauri wrappers (src/lib/project.ts).
 *
 * Focuses on the thin invoke() wrappers: project CRUD, metadata getters/setters,
 * and settings that persist to `.shipstudio/project.json`.
 *
 * The complex `startDevServer` function is intentionally not covered here — it
 * orchestrates `tauri-pty`, file reads, event listeners, and PID polling, which
 * is integration-level behavior, not a wrapper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DashboardProject } from './project';
import {
  getDashboardProjects,
  listProjects,
  ensureShipStudioDir,
  spawnPty,
  ensureGitignoreHasShipstudio,
  getProjectThumbnail,
  deleteProject,
  exportProjectAsTemplate,
  openProjectInNewWindow,
  getCustomDevCommand,
  setCustomDevCommand,
  getAutoAcceptMode,
  setAutoAcceptMode,
  getHideMainBranchWarning,
  setHideMainBranchWarning,
} from './project';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Silence logger + analytics (not exercised by these wrappers but imported by the module)
vi.mock('./logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./analytics', () => ({
  trackError: vi.fn(),
}));

describe('lib/project', () => {
  let core: typeof import('@tauri-apps/api/core');

  beforeEach(async () => {
    vi.clearAllMocks();
    core = await import('@tauri-apps/api/core');
  });

  // ============ getDashboardProjects ============

  describe('getDashboardProjects', () => {
    it('invokes "get_dashboard_projects" with no args and returns project list', async () => {
      const projects: DashboardProject[] = [
        {
          name: 'acme',
          path: '/Users/test/ShipStudio/acme',
          thumbnail: null,
          last_opened: 1234567890,
          git_branch: 'main',
          uncommitted_count: 0,
          auto_accept_mode: false,
          hide_main_branch_warning: false,
          is_external: false,
          workspace_subpath: null,
        },
      ];
      vi.mocked(core.invoke).mockResolvedValue(projects);

      const result = await getDashboardProjects();

      expect(core.invoke).toHaveBeenCalledTimes(1);
      expect(core.invoke).toHaveBeenCalledWith('get_dashboard_projects');
      expect(result).toEqual(projects);
    });

    it('preserves the full DashboardProject shape including nullable fields', async () => {
      const projects: DashboardProject[] = [
        {
          name: 'fresh',
          path: '/p',
          thumbnail: null,
          last_opened: null,
          git_branch: null,
          uncommitted_count: null,
          auto_accept_mode: null,
          hide_main_branch_warning: null,
          is_external: true,
          workspace_subpath: null,
        },
      ];
      vi.mocked(core.invoke).mockResolvedValue(projects);

      const result = await getDashboardProjects();

      expect(result[0].last_opened).toBeNull();
      expect(result[0].git_branch).toBeNull();
      expect(result[0].is_external).toBe(true);
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('scan failed'));
      await expect(getDashboardProjects()).rejects.toThrow('scan failed');
    });
  });

  // ============ listProjects ============

  describe('listProjects', () => {
    it('invokes "list_projects" and returns name/path pairs', async () => {
      const list = [
        { name: 'a', path: '/ShipStudio/a' },
        { name: 'b', path: '/ShipStudio/b' },
      ];
      vi.mocked(core.invoke).mockResolvedValue(list);

      const result = await listProjects();

      expect(core.invoke).toHaveBeenCalledWith('list_projects');
      expect(result).toEqual(list);
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('no home dir'));
      await expect(listProjects()).rejects.toThrow('no home dir');
    });
  });

  // ============ ensureShipStudioDir ============

  describe('ensureShipStudioDir', () => {
    it('invokes "ensure_shipstudio_dir" and returns the absolute path', async () => {
      vi.mocked(core.invoke).mockResolvedValue('/Users/test/ShipStudio');

      const result = await ensureShipStudioDir();

      expect(core.invoke).toHaveBeenCalledWith('ensure_shipstudio_dir');
      expect(result).toBe('/Users/test/ShipStudio');
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('mkdir failed'));
      await expect(ensureShipStudioDir()).rejects.toThrow('mkdir failed');
    });
  });

  // ============ spawnPty ============

  describe('spawnPty', () => {
    it('invokes "spawn_pty" with options + windowLabel and returns the pty id', async () => {
      vi.mocked(core.invoke).mockResolvedValue(42);

      const options = {
        cwd: '/p',
        command: 'npm',
        args: ['run', 'dev'],
        rows: 24,
        cols: 80,
      };
      const result = await spawnPty(options, 'main');

      expect(core.invoke).toHaveBeenCalledWith('spawn_pty', {
        options,
        windowLabel: 'main',
      });
      expect(result).toBe(42);
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('spawn failed'));
      const options = { cwd: '/p', command: 'bad', args: [], rows: 24, cols: 80 };
      await expect(spawnPty(options, 'main')).rejects.toThrow('spawn failed');
    });
  });

  // ============ ensureGitignoreHasShipstudio ============

  describe('ensureGitignoreHasShipstudio', () => {
    it('invokes "ensure_gitignore_has_shipstudio" with projectPath', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      await ensureGitignoreHasShipstudio('/abs/project');

      expect(core.invoke).toHaveBeenCalledWith('ensure_gitignore_has_shipstudio', {
        projectPath: '/abs/project',
      });
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('write failed'));
      await expect(ensureGitignoreHasShipstudio('/abs/project')).rejects.toThrow('write failed');
    });
  });

  // ============ getProjectThumbnail ============

  describe('getProjectThumbnail', () => {
    it('invokes "get_project_thumbnail" with projectPath and returns base64', async () => {
      vi.mocked(core.invoke).mockResolvedValue('data:image/png;base64,AAA');

      const result = await getProjectThumbnail('/abs/project');

      expect(core.invoke).toHaveBeenCalledWith('get_project_thumbnail', {
        projectPath: '/abs/project',
      });
      expect(result).toBe('data:image/png;base64,AAA');
    });

    it('returns null when no thumbnail exists', async () => {
      vi.mocked(core.invoke).mockResolvedValue(null);
      const result = await getProjectThumbnail('/abs/project');
      expect(result).toBeNull();
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('read error'));
      await expect(getProjectThumbnail('/abs/project')).rejects.toThrow('read error');
    });
  });

  // ============ deleteProject ============

  describe('deleteProject', () => {
    it('invokes "delete_project" with path', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      await deleteProject('/abs/project');

      expect(core.invoke).toHaveBeenCalledWith('delete_project', {
        path: '/abs/project',
      });
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('permission denied'));
      await expect(deleteProject('/abs/project')).rejects.toThrow('permission denied');
    });
  });

  // ============ exportProjectAsTemplate ============

  describe('exportProjectAsTemplate', () => {
    it('invokes "export_project_as_template" with projectPath and returns saved path', async () => {
      vi.mocked(core.invoke).mockResolvedValue('/Users/test/template.zip');

      const result = await exportProjectAsTemplate('/abs/project');

      expect(core.invoke).toHaveBeenCalledWith('export_project_as_template', {
        projectPath: '/abs/project',
      });
      expect(result).toBe('/Users/test/template.zip');
    });

    it('returns null when the user cancels the save dialog', async () => {
      vi.mocked(core.invoke).mockResolvedValue(null);
      const result = await exportProjectAsTemplate('/abs/project');
      expect(result).toBeNull();
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('export failed'));
      await expect(exportProjectAsTemplate('/abs/project')).rejects.toThrow('export failed');
    });
  });

  // ============ openProjectInNewWindow ============

  describe('openProjectInNewWindow', () => {
    it('invokes "open_project_in_new_window" with projectPath + projectName', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      await openProjectInNewWindow('/abs/project', 'My Project');

      expect(core.invoke).toHaveBeenCalledWith('open_project_in_new_window', {
        projectPath: '/abs/project',
        projectName: 'My Project',
      });
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('window spawn failed'));
      await expect(openProjectInNewWindow('/abs/project', 'name')).rejects.toThrow(
        'window spawn failed'
      );
    });
  });

  // ============ getCustomDevCommand / setCustomDevCommand ============

  describe('getCustomDevCommand', () => {
    it('invokes "get_custom_dev_command" with projectPath and returns the string', async () => {
      vi.mocked(core.invoke).mockResolvedValue('npm run start');

      const result = await getCustomDevCommand('/abs/project');

      expect(core.invoke).toHaveBeenCalledWith('get_custom_dev_command', {
        projectPath: '/abs/project',
      });
      expect(result).toBe('npm run start');
    });

    it('returns null when no custom command configured', async () => {
      vi.mocked(core.invoke).mockResolvedValue(null);
      const result = await getCustomDevCommand('/abs/project');
      expect(result).toBeNull();
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('read failed'));
      await expect(getCustomDevCommand('/abs/project')).rejects.toThrow('read failed');
    });
  });

  describe('setCustomDevCommand', () => {
    it('invokes "set_custom_dev_command" with projectPath + command string', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      await setCustomDevCommand('/abs/project', 'pnpm dev');

      expect(core.invoke).toHaveBeenCalledWith('set_custom_dev_command', {
        projectPath: '/abs/project',
        command: 'pnpm dev',
      });
    });

    it('passes null command through when clearing', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      await setCustomDevCommand('/abs/project', null);

      expect(core.invoke).toHaveBeenCalledWith('set_custom_dev_command', {
        projectPath: '/abs/project',
        command: null,
      });
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('write failed'));
      await expect(setCustomDevCommand('/abs/project', 'x')).rejects.toThrow('write failed');
    });
  });

  // ============ getAutoAcceptMode / setAutoAcceptMode ============

  describe('getAutoAcceptMode', () => {
    it('invokes "get_auto_accept_mode" with projectPath and returns the boolean', async () => {
      vi.mocked(core.invoke).mockResolvedValue(true);

      const result = await getAutoAcceptMode('/abs/project');

      expect(core.invoke).toHaveBeenCalledWith('get_auto_accept_mode', {
        projectPath: '/abs/project',
      });
      expect(result).toBe(true);
    });

    it('returns false when disabled', async () => {
      vi.mocked(core.invoke).mockResolvedValue(false);
      const result = await getAutoAcceptMode('/abs/project');
      expect(result).toBe(false);
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('read failed'));
      await expect(getAutoAcceptMode('/abs/project')).rejects.toThrow('read failed');
    });
  });

  describe('setAutoAcceptMode', () => {
    it('invokes "set_auto_accept_mode" with projectPath + enabled flag', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      await setAutoAcceptMode('/abs/project', true);

      expect(core.invoke).toHaveBeenCalledWith('set_auto_accept_mode', {
        projectPath: '/abs/project',
        enabled: true,
      });
    });

    it('passes through the enabled=false case', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      await setAutoAcceptMode('/abs/project', false);

      expect(core.invoke).toHaveBeenCalledWith('set_auto_accept_mode', {
        projectPath: '/abs/project',
        enabled: false,
      });
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('write failed'));
      await expect(setAutoAcceptMode('/abs/project', true)).rejects.toThrow('write failed');
    });
  });

  // ============ getHideMainBranchWarning / setHideMainBranchWarning ============

  describe('getHideMainBranchWarning', () => {
    it('invokes "get_hide_main_branch_warning" with projectPath', async () => {
      vi.mocked(core.invoke).mockResolvedValue(true);

      const result = await getHideMainBranchWarning('/abs/project');

      expect(core.invoke).toHaveBeenCalledWith('get_hide_main_branch_warning', {
        projectPath: '/abs/project',
      });
      expect(result).toBe(true);
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('read failed'));
      await expect(getHideMainBranchWarning('/abs/project')).rejects.toThrow('read failed');
    });
  });

  describe('setHideMainBranchWarning', () => {
    it('invokes "set_hide_main_branch_warning" with projectPath + hidden flag', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      await setHideMainBranchWarning('/abs/project', true);

      expect(core.invoke).toHaveBeenCalledWith('set_hide_main_branch_warning', {
        projectPath: '/abs/project',
        hidden: true,
      });
    });

    it('passes through hidden=false', async () => {
      vi.mocked(core.invoke).mockResolvedValue(undefined);

      await setHideMainBranchWarning('/abs/project', false);

      expect(core.invoke).toHaveBeenCalledWith('set_hide_main_branch_warning', {
        projectPath: '/abs/project',
        hidden: false,
      });
    });

    it('propagates errors from invoke', async () => {
      vi.mocked(core.invoke).mockRejectedValue(new Error('write failed'));
      await expect(setHideMainBranchWarning('/abs/project', true)).rejects.toThrow('write failed');
    });
  });
});
