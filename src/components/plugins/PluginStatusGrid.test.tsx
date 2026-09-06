import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type { PluginInfo } from '../../lib/plugins';
import { PluginStatusGrid } from './PluginStatusGrid';

function makePlugin(overrides: Partial<PluginInfo['manifest']> = {}): PluginInfo {
  return {
    manifest: {
      id: 'ccusage',
      name: 'Claude Usage',
      version: '1.0.0',
      description: 'Shows Claude Code spend',
      slots: ['toolbar'],
      author: 'Ship Studio',
      repository: 'https://github.com/ship-studio/plugin-ccusage',
      setup: [],
      min_app_version: '',
      icon: '',
      required_commands: [],
      ...overrides,
    },
    enabled: true,
    installed_at: 0,
    source_url: 'https://github.com/ship-studio/plugin-ccusage',
    is_dev: false,
    local_path: '',
  };
}

const plugin = makePlugin();

function renderGrid(loadedPlugins: LoadedPlugin[], plugins: PluginInfo[] = [plugin]) {
  render(
    <PluginStatusGrid
      plugins={plugins}
      loadedPlugins={loadedPlugins}
      togglingId={null}
      removingId={null}
      reloadingId={null}
      unlinkingId={null}
      updateStates={{}}
      onToggle={vi.fn()}
      onCheckUpdate={vi.fn()}
      onUpdate={vi.fn()}
      onUninstall={vi.fn()}
      onReloadDev={vi.fn()}
      onUnlinkDev={vi.fn()}
    />
  );
}

describe('PluginStatusGrid', () => {
  it('does not mount a plugin toolbar component while rendering its manager row', () => {
    const toolbarRender = vi.fn(() => {
      throw new Error('toolbar context is unavailable');
    });

    renderGrid([
      {
        info: plugin,
        module: {
          name: 'Vercel',
          slots: { toolbar: toolbarRender },
        },
      },
    ]);

    expect(screen.getByText('Claude Usage')).toBeInTheDocument();
    expect(toolbarRender).not.toHaveBeenCalled();
  });
});

describe('a plugin the app now does itself', () => {
  const superseded = makePlugin({ id: 'vercel', name: 'Vercel' });

  it('says why it stopped doing anything', () => {
    // It is skipped at load, so it renders nothing anywhere else in the app.
    // This row is the only place someone finds out why.
    renderGrid([], [superseded]);

    expect(screen.getByText('Built in now')).toBeInTheDocument();
    expect(screen.getByText(/Hosting is built in now/)).toBeInTheDocument();
  });

  it('offers no on/off toggle', () => {
    // Turning it on would change nothing, and offering the switch implies it
    // would.
    renderGrid([], [superseded]);

    expect(screen.queryByTitle('Disable')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Enable')).not.toBeInTheDocument();
  });

  it("leaves an ordinary plugin's toggle alone", () => {
    renderGrid([]);
    expect(screen.getByTitle('Disable')).toBeInTheDocument();
  });
});
