import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import type { PluginInfo } from '../../lib/plugins';
import { PluginStatusGrid } from './PluginStatusGrid';

const plugin: PluginInfo = {
  manifest: {
    id: 'vercel',
    name: 'Vercel',
    version: '1.0.0',
    description: 'Deploy with Vercel',
    slots: ['toolbar'],
    author: 'Ship Studio',
    repository: 'https://github.com/ship-studio/plugin-vercel',
    setup: [],
    min_app_version: '',
    icon: '',
    required_commands: [],
  },
  enabled: true,
  installed_at: 0,
  source_url: 'https://github.com/ship-studio/plugin-vercel',
  is_dev: false,
  local_path: '',
};

function renderGrid(loadedPlugins: LoadedPlugin[]) {
  render(
    <PluginStatusGrid
      plugins={[plugin]}
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

    expect(screen.getByText('Vercel')).toBeInTheDocument();
    expect(toolbarRender).not.toHaveBeenCalled();
  });
});
