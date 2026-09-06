/**
 * PluginStatusGrid — renders the list of installed plugins with toggle,
 * update, and remove/unlink actions. Used in the "Installed" tab of the
 * Plugin Manager.
 *
 * @module components/PluginStatusGrid
 */

import { supersededReason, type PluginInfo } from '../../lib/plugins';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import { PuzzleIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { ExtensionListRow } from './extension';

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
        // Superseded plugins are skipped at load, so this row is the only place
        // a user finds out why one stopped doing anything.
        const superseded = supersededReason(plugin.manifest.id);

        return (
          <ExtensionListRow
            key={plugin.manifest.id}
            className={`plugin-row${superseded ? ' is-superseded' : ''}`}
          >
            <div className="plugin-icon-container">
              <PuzzleIcon size={14} />
            </div>
            <div className="plugin-info">
              <div className="plugin-header">
                <div>
                  <span className="plugin-name">
                    {plugin.manifest.name}
                    {plugin.is_dev && <span className="plugin-dev-badge">DEV</span>}
                    {superseded && <span className="plugin-superseded-badge">Built in now</span>}
                  </span>
                  <span className="plugin-meta">
                    v{plugin.manifest.version}
                    {plugin.manifest.author && <> · {plugin.manifest.author}</>}
                  </span>
                </div>
                {/* No toggle for a superseded plugin: it is skipped at load,
                    so switching it on would change nothing and imply it had. */}
                {!superseded && (
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
                )}
              </div>
              {plugin.is_dev && plugin.local_path && (
                <div className="plugin-local-path" title={plugin.local_path}>
                  {plugin.local_path}
                </div>
              )}
              <div className="plugin-desc">{superseded ?? plugin.manifest.description}</div>
              <div className="plugin-actions">
                {plugin.is_dev ? (
                  <>
                    <TextButton
                      onClick={() => onReloadDev(plugin.manifest.id)}
                      disabled={reloadingId === plugin.manifest.id}
                    >
                      {reloadingId === plugin.manifest.id ? 'Reloading...' : 'Reload'}
                    </TextButton>
                    <TextButton
                      variant="danger"
                      onClick={() => {
                        onUnlinkDev(plugin.manifest.id);
                      }}
                      disabled={unlinkingId === plugin.manifest.id}
                    >
                      {unlinkingId === plugin.manifest.id ? 'Unlinking...' : 'Unlink'}
                    </TextButton>
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
                          <TextButton
                            variant="accent"
                            onClick={() => {
                              onUpdate(plugin.manifest.id);
                            }}
                          >
                            Update available
                          </TextButton>
                        );
                      }
                      if (state === 'updating') {
                        return <span className="plugin-action-status">Updating...</span>;
                      }
                      if (state === 'up_to_date') {
                        return <span className="plugin-action-status">Up to date</span>;
                      }
                      return (
                        <TextButton
                          onClick={() => {
                            onCheckUpdate(plugin.manifest.id);
                          }}
                        >
                          Check for updates
                        </TextButton>
                      );
                    })()}
                    <TextButton
                      variant="danger"
                      onClick={() => {
                        onUninstall(plugin.manifest.id);
                      }}
                      disabled={removingId === plugin.manifest.id}
                    >
                      {removingId === plugin.manifest.id ? 'Removing...' : 'Remove'}
                    </TextButton>
                  </>
                )}
              </div>
            </div>
          </ExtensionListRow>
        );
      })}
    </div>
  );
}
