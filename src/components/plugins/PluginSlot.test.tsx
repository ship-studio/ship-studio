/**
 * Tests for the plugin context built by PluginSlot — async rejections from
 * shell.exec / storage.* / invoke.call must surface as an error toast naming
 * the plugin, then re-throw so plugins handling their own errors still can.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import { render } from '@testing-library/react';
import { buildContext, PluginSlot } from './PluginSlot';
import { unloadPluginModule } from '../../lib/plugin-loader';
import type {
  PluginAppActions,
  PluginContextValue,
  PluginThemeData,
} from '../../contexts/PluginContext';
import type { LoadedPlugin } from '../../hooks/usePlugins';

const theme: PluginThemeData = {
  bgPrimary: '',
  bgSecondary: '',
  bgTertiary: '',
  textPrimary: '',
  textSecondary: '',
  textMuted: '',
  border: '',
  accent: '',
  accentHover: '',
  action: '',
  actionHover: '',
  actionText: '',
  error: '',
  success: '',
};

function makeActions() {
  const showToast = vi.fn();
  const actions: PluginAppActions = {
    showToast,
    refreshGitStatus: vi.fn(),
    refreshBranches: vi.fn(),
    focusTerminal: vi.fn(),
    openUrl: vi.fn(),
    openTerminal: vi.fn(() => Promise.resolve(null)),
  };
  return { actions, showToast };
}

const project = {
  name: 'demo',
  path: '/p/demo',
  currentBranch: 'main',
  hasUncommittedChanges: false,
};

describe('buildContext failure reporting', () => {
  beforeEach(() => {
    // Every backend call rejects — simulates e.g. a failing CLI.
    mockIPC(() => {
      throw new Error('boom from backend');
    });
  });

  it('toasts and re-throws when shell.exec rejects', async () => {
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, []);

    await expect(ctx.shell.exec('sanity', ['deploy'])).rejects.toThrow('boom from backend');
    expect(showToast).toHaveBeenCalledTimes(1);
    const message = showToast.mock.calls[0][0] as string;
    expect(message).toContain('Plugin "Sanity"');
    expect(message).toContain('boom from backend');
    expect(showToast.mock.calls[0][1]).toBe('error');
  });

  it('toasts and re-throws when storage.read / storage.write reject', async () => {
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, []);

    await expect(ctx.storage.read()).rejects.toThrow('boom from backend');
    await expect(ctx.storage.write({ a: 1 })).rejects.toThrow('boom from backend');
    expect(showToast).toHaveBeenCalledTimes(2);
  });

  it('toasts the allowlist rejection for non-allowlisted invoke.call', async () => {
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, ['allowed_cmd']);

    await expect(ctx.invoke.call('forbidden_cmd')).rejects.toThrow(
      'Plugin "sanity" is not allowed to call "forbidden_cmd"'
    );
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toContain('not allowed to call "forbidden_cmd"');
    expect(showToast.mock.calls[0][1]).toBe('error');
  });

  it('toasts and re-throws when an allowlisted invoke.call rejects', async () => {
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, ['allowed_cmd']);

    await expect(ctx.invoke.call('allowed_cmd')).rejects.toThrow('boom from backend');
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toContain('Plugin "Sanity"');
  });

  it('suppresses the toast for a call that raced a plugin unload (#288)', async () => {
    const { actions, showToast } = makeActions();
    const stale = { ...project, path: '/p/stale' };
    const ctx = buildContext('vercel', 'Vercel', stale, actions, theme, []);

    // Call goes out, then the plugin is unloaded (project switch/uninstall)
    // before the rejection lands — no user-facing toast, but still re-throws.
    const pending = ctx.shell.exec('vercel', ['whoami']);
    unloadPluginModule(stale.path, 'vercel');
    await expect(pending).rejects.toThrow('boom from backend');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('one-shots the project-folder-gone toast as info instead of erroring every poll (#629)', async () => {
    mockIPC(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately a plain CommandError object, the shape under test
      throw {
        type: 'Other',
        message:
          "The folder '/p/gone' no longer exists — it may have been moved, renamed, or deleted outside Ship Studio",
      };
    });
    const { actions, showToast } = makeActions();
    const gone = { ...project, path: '/p/gone' };
    const ctx = buildContext('vercel', 'Vercel', gone, actions, theme, []);

    // First background call: one friendly info toast (Expected condition —
    // must not go through the error-toast telemetry pipeline).
    await expect(ctx.shell.exec('vercel', ['ls'])).rejects.toBeTruthy();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toContain('no longer exists');
    expect(showToast.mock.calls[0][1]).toBe('info');

    // Subsequent polls for the same project: suppressed entirely.
    await expect(ctx.storage.read()).rejects.toBeTruthy();
    await expect(ctx.shell.exec('vercel', ['ls'])).rejects.toBeTruthy();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('suppresses the toast for a plugin shell timeout — the plugin decides what is fatal (#661/#662)', async () => {
    mockIPC(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately a plain CommandError object, the shape under test
      throw {
        type: 'Other',
        message: "Plugin 'vercel' shell command 'git' timed out after 10s",
      };
    });
    const { actions, showToast } = makeActions();
    const ctx = buildContext('vercel', 'Vercel', project, actions, theme, []);

    // Still re-throws so the plugin's own `.catch(() => null)` sees it, but
    // no error toast (which would auto-file a telemetry report).
    await expect(ctx.shell.exec('git', ['remote', '-v'])).rejects.toBeTruthy();
    expect(showToast).not.toHaveBeenCalled();

    // A different plugin's timeout message doesn't match this plugin's id —
    // still toasts (the match is on the host's own message shape, per-plugin).
    mockIPC(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- plain CommandError shape under test
      throw {
        type: 'Other',
        message: "Plugin 'other' shell command 'git' timed out after 10s",
      };
    });
    await expect(ctx.shell.exec('git', ['remote', '-v'])).rejects.toBeTruthy();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('routes a transient spawn-pressure failure to an info toast (#775)', async () => {
    mockIPC(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- plain CommandError shape under test
      throw {
        type: 'Other',
        message:
          "Couldn't start `brew` — your system is temporarily low on process resources or open files. Close some apps or terminal tabs and try again.",
      };
    });
    const { actions, showToast } = makeActions();
    const ctx = buildContext('vercel', 'Vercel', project, actions, theme, []);

    await expect(ctx.shell.exec('brew', ['list'])).rejects.toBeTruthy();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toContain('temporarily low on process resources');
    // 'error' would re-report an environment state to telemetry.
    expect(showToast.mock.calls[0][1]).toBe('info');
  });

  it('does not error-toast a bundled hosting plugin whose files vanished (#386)', async () => {
    mockIPC(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- plain CommandError shape under test
      throw { type: 'Other', message: "Plugin 'cloudflare' not found" };
    });
    const { actions, showToast } = makeActions();
    const ctx = buildContext('cloudflare', 'Cloudflare Pages', project, actions, theme, []);

    await expect(ctx.shell.exec('wrangler', ['whoami'])).rejects.toBeTruthy();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toContain('was deactivated');
    expect(showToast.mock.calls[0][1]).toBe('info');
  });

  it('still error-toasts a user-installed plugin whose files vanished (#315)', async () => {
    mockIPC(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- plain CommandError shape under test
      throw { type: 'Other', message: "Plugin 'sanity' not found" };
    });
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, []);

    await expect(ctx.shell.exec('sanity', ['deploy'])).rejects.toBeTruthy();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][1]).toBe('error');
  });

  it('does not toast when the call succeeds', async () => {
    mockIPC((cmd) => {
      if (cmd === 'read_plugin_storage') return { key: 'value' };
      return undefined;
    });
    const { actions, showToast } = makeActions();
    const ctx = buildContext('sanity', 'Sanity', project, actions, theme, []);

    await expect(ctx.storage.read()).resolves.toEqual({ key: 'value' });
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('legacy plugin context global (#389/#465/#695)', () => {
  function makeLegacyPlugin(id: string, name: string, seen: Record<string, string>) {
    // Mimics a pre-React-context SDK bundle: reads the single window global
    // during render instead of using PluginContext.
    function LegacySlotComponent() {
      const ctx = (window as unknown as Record<string, unknown>).__SHIPSTUDIO_PLUGIN_CONTEXT__ as
        | PluginContextValue
        | undefined;
      seen[id] = ctx?.pluginId ?? '(missing)';
      return null;
    }
    const plugin: LoadedPlugin = {
      info: {
        manifest: {
          id,
          name,
          version: '1.0.0',
          description: '',
          slots: ['toolbar'],
          author: '',
          repository: '',
          setup: [],
          min_app_version: '0.0.0',
          icon: '',
          required_commands: [],
        },
        enabled: true,
        installed_at: 0,
        source_url: '',
        is_dev: false,
        local_path: '',
      },
      module: { name, slots: { toolbar: LegacySlotComponent } },
    };
    return plugin;
  }

  it('each legacy plugin sees its own context during render, not the last-mounted one', () => {
    const seen: Record<string, string> = {};
    const { actions } = makeActions();
    render(
      <PluginSlot
        name="toolbar"
        plugins={[
          makeLegacyPlugin('vercel', 'Vercel', seen),
          makeLegacyPlugin('webflow-cloud', 'Webflow Cloud', seen),
        ]}
        project={project}
        actions={actions}
        theme={theme}
      />
    );
    expect(seen).toEqual({ vercel: 'vercel', 'webflow-cloud': 'webflow-cloud' });
  });
});
