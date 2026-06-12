/**
 * PluginStatusGrid — renders the list of installed plugins with toggle,
 * update, and remove/unlink actions. Used in the "Installed" tab of the
 * Plugin Manager.
 *
 * @module components/PluginStatusGrid
 */

import type { PluginInfo } from '../../lib/plugins';
import type { LoadedPlugin } from '../../hooks/usePlugins';

export interface PluginStatusGridProps {
  plugins: PluginInfo[];
  loadedPlugins: LoadedPlugin[];
  togglingId: string | null;
  removingId: string | null;
  reloadingId: string | null;
  unlinkingId: string | null;
  updateStates: Record<string, string>;
  onToggle: (pluginId: string, enabled: boolean) => void;
  onCheckUpdate: (pluginId: string) => void;
  onUpdate: (pluginId: string) => void;
  onUninstall: (pluginId: string) => void;
  onReloadDev: (pluginId: string) => void;
  onUnlinkDev: (pluginId: string) => void;
}

export function PluginStatusGrid({
  plugins,
  loadedPlugins,
  togglingId,
  removingId,
  reloadingId,
  unlinkingId,
  updateStates,
  onToggle,
  onCheckUpdate,
  onUpdate,
  onUninstall,
  onReloadDev,
  onUnlinkDev,
}: PluginStatusGridProps) {
  return (
    <div className="plugins-list">
      {plugins.map((plugin) => {
        const loaded = loadedPlugins.find((lp) => lp.info.manifest.id === plugin.manifest.id);
        const ToolbarIcon = loaded?.module.slots['toolbar'];

        return (
          <div key={plugin.manifest.id} className="plugin-row">
            <div className="plugin-icon-container">{ToolbarIcon ? <ToolbarIcon /> : null}</div>
            <div className="plugin-info">
              <div className="plugin-header">
                <div>
                  <span className="plugin-name">
                    {plugin.manifest.name}
                    {plugin.is_dev && <span className="plugin-dev-badge">DEV</span>}
                  </span>
                  <span className="plugin-meta">
                    v{plugin.manifest.version}
                    {plugin.manifest.author && <> · {plugin.manifest.author}</>}
                  </span>
                </div>
                <button
                  className={`plugin-toggle-btn ${plugin.enabled ? 'enabled' : ''}`}
                  onClick={() => {
                    onToggle(plugin.manifest.id, !plugin.enabled);
                  }}
                  disabled={togglingId === plugin.manifest.id}
                  title={plugin.enabled ? 'Disable' : 'Enable'}
                >
                  {plugin.enabled ? 'On' : 'Off'}
                </button>
              </div>
              {plugin.is_dev && plugin.local_path && (
                <div className="plugin-local-path" title={plugin.local_path}>
                  {plugin.local_path}
                </div>
              )}
              <div className="plugin-desc">{plugin.manifest.description}</div>
              <div className="plugin-actions">
                {plugin.is_dev ? (
                  <>
                    <button
                      className="plugin-action-link"
                      onClick={() => onReloadDev(plugin.manifest.id)}
                      disabled={reloadingId === plugin.manifest.id}
                    >
                      {reloadingId === plugin.manifest.id ? 'Reloading...' : 'Reload'}
                    </button>
                    <button
                      className="plugin-action-link plugin-action-danger"
                      onClick={() => {
                        onUnlinkDev(plugin.manifest.id);
                      }}
                      disabled={unlinkingId === plugin.manifest.id}
                    >
                      {unlinkingId === plugin.manifest.id ? 'Unlinking...' : 'Unlink'}
                    </button>
                  </>
                ) : (
                  <>
                    {(() => {
                      const state = updateStates[plugin.manifest.id] || 'idle';
                      if (state === 'checking') {
                        return <span className="plugin-action-status">Checking...</span>;
                      }
                      if (state === 'available') {
                        return (
                          <button
                            className="plugin-action-link plugin-action-update"
                            onClick={() => {
                              onUpdate(plugin.manifest.id);
                            }}
                          >
                            Update available
                          </button>
                        );
                      }
                      if (state === 'updating') {
                        return <span className="plugin-action-status">Updating...</span>;
                      }
                      if (state === 'up_to_date') {
                        return <span className="plugin-action-status">Up to date</span>;
                      }
                      return (
                        <button
                          className="plugin-action-link"
                          onClick={() => {
                            onCheckUpdate(plugin.manifest.id);
                          }}
                        >
                          Check for updates
                        </button>
                      );
                    })()}
                    <button
                      className="plugin-action-link plugin-action-danger"
                      onClick={() => {
                        onUninstall(plugin.manifest.id);
                      }}
                      disabled={removingId === plugin.manifest.id}
                    >
                      {removingId === plugin.manifest.id ? 'Removing...' : 'Remove'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
