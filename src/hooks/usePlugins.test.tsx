/**
 * Tests for usePlugins' missing-bundle self-heal (issue #624).
 *
 * Plugins registered before the install-time bundle check (issue #381)
 * can have a valid manifest but no dist/index.js. The hook must repair
 * those by re-installing from source once, and — when repair isn't
 * possible — surface an actionable failure instead of the raw path error
 * (and without re-attempting the heal on every reload).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePlugins } from './usePlugins';
import type { PluginInfo } from '../lib/plugins';
import type { PluginModule } from '../lib/plugin-loader';

vi.mock('../lib/plugins', () => ({
  listPlugins: vi.fn(),
  updatePlugin: vi.fn(),
  // The hook asks this whether a plugin has been replaced by a native feature
  // or a skill. These fixtures are unrelated plugins, so nothing is superseded.
  supersededReason: () => null,
  isExpectedPluginFailure: () => false,
}));

vi.mock('../lib/plugin-loader', () => ({
  loadPluginModule: vi.fn(),
  unloadPluginModule: vi.fn(),
}));

import { listPlugins, updatePlugin } from '../lib/plugins';
import { loadPluginModule } from '../lib/plugin-loader';

const mockListPlugins = vi.mocked(listPlugins);
const mockUpdatePlugin = vi.mocked(updatePlugin);
const mockLoadPluginModule = vi.mocked(loadPluginModule);

function makeInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    manifest: {
      id: 'dependency-checker',
      name: 'Dependency Checker',
      version: '1.0.0',
      description: '',
      slots: ['toolbar'],
      author: '',
      repository: '',
      setup: [],
      min_app_version: '',
      icon: '',
      required_commands: [],
      api_version: 1,
    },
    enabled: true,
    installed_at: 0,
    source_url: 'https://github.com/ship-studio/plugin-dependency-checker',
    is_dev: false,
    local_path: '',
    ...overrides,
  };
}

const workingModule: PluginModule = { name: 'Dependency Checker', slots: {} };

const missingBundleError = new Error(
  'Plugin bundle not found: /p/.shipstudio/plugins/dependency-checker/dist/index.js'
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usePlugins missing-bundle self-heal', () => {
  it('re-installs from source and loads the plugin when the bundle is missing', async () => {
    mockListPlugins.mockResolvedValue([makeInfo()]);
    mockLoadPluginModule
      .mockRejectedValueOnce(missingBundleError)
      .mockResolvedValueOnce(workingModule);
    mockUpdatePlugin.mockResolvedValue(makeInfo());

    const { result } = renderHook(() => usePlugins('/projects/heal-success'));

    await waitFor(() => expect(result.current.plugins).toHaveLength(1));
    expect(mockUpdatePlugin).toHaveBeenCalledWith('/projects/heal-success', 'dependency-checker');
    expect(result.current.failures).toHaveLength(0);
  });

  it('surfaces an actionable failure when the re-install also fails', async () => {
    mockListPlugins.mockResolvedValue([makeInfo()]);
    mockLoadPluginModule.mockRejectedValue(missingBundleError);
    mockUpdatePlugin.mockRejectedValue(new Error('Git clone failed: no network'));

    const { result } = renderHook(() => usePlugins('/projects/heal-failure'));

    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(result.current.plugins).toHaveLength(0);
    expect(result.current.failures[0].reason).toContain('Uninstall and reinstall');
    // The raw bundle path must not leak into the user-facing reason.
    expect(result.current.failures[0].reason).not.toContain('dist/index.js');
  });

  it('does not retry the heal for the same plugin within a session', async () => {
    mockListPlugins.mockResolvedValue([makeInfo()]);
    mockLoadPluginModule.mockRejectedValue(missingBundleError);
    mockUpdatePlugin.mockRejectedValue(new Error('Git clone failed'));

    const { result } = renderHook(() => usePlugins('/projects/heal-once'));
    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(mockUpdatePlugin).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.reloadPlugins();
    });
    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    // Reload re-fails, but no second network re-install is attempted.
    expect(mockUpdatePlugin).toHaveBeenCalledTimes(1);
  });

  it('never self-heals dev plugins', async () => {
    mockListPlugins.mockResolvedValue([
      makeInfo({ is_dev: true, local_path: '/dev/plugin', source_url: '' }),
    ]);
    mockLoadPluginModule.mockRejectedValue(missingBundleError);

    const { result } = renderHook(() => usePlugins('/projects/dev-plugin'));

    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(mockUpdatePlugin).not.toHaveBeenCalled();
  });

  it('does not heal unrelated load failures', async () => {
    mockListPlugins.mockResolvedValue([makeInfo()]);
    mockLoadPluginModule.mockRejectedValue(new Error('Plugin must export a name'));

    const { result } = renderHook(() => usePlugins('/projects/other-error'));

    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(mockUpdatePlugin).not.toHaveBeenCalled();
    expect(result.current.failures[0].reason).toContain('Plugin must export a name');
  });
});
