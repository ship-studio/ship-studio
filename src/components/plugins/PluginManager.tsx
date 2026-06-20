/**
 * PluginManager component for installing, managing, and removing plugins.
 *
 * Plugins are project-level: each project has its own set of plugins.
 * The "Library" tab fetches available plugins from the remote registry.
 *
 * @module components/PluginManager
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { CloseIcon, SearchIcon } from '../icons';
import { trackEvent, trackError } from '../../lib/analytics';
import { logger } from '../../lib/logger';
import {
  listPlugins,
  installPlugin,
  uninstallPlugin,
  togglePlugin,
  checkPluginUpdate,
  updatePlugin,
  fetchPluginRegistry,
  linkDevPlugin,
  unlinkDevPlugin,
  type PluginInfo,
  type PluginRegistryEntry,
} from '../../lib/plugins';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import { useModal } from '../../contexts/ModalContext';
import { PluginInstallForm } from './PluginInstallForm';
import { Spinner } from '../primitives/Spinner';
import { PluginStatusGrid } from './PluginStatusGrid';

type Tab = 'installed' | 'library';

interface PluginManagerProps {
  onPluginsChanged: () => void;
  projectPath: string | null;
  /** Loaded plugins from usePlugins hook, used to render toolbar icons */
  loadedPlugins?: LoadedPlugin[];
}

export function PluginManager({
  onPluginsChanged,
  projectPath,
  loadedPlugins = [],
}: PluginManagerProps) {
  const { isOpen, close: onClose } = useModal('pluginManager');
  const [activeTab, setActiveTab] = useState<Tab>('installed');
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Update state per plugin: 'idle' | 'checking' | 'available' | 'up_to_date' | 'updating'
  const [updateStates, setUpdateStates] = useState<Record<string, string>>({});

  // Library state
  const [registry, setRegistry] = useState<PluginRegistryEntry[]>([]);
  const [isLoadingRegistry, setIsLoadingRegistry] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [isInstallingUrl, setIsInstallingUrl] = useState(false);

  // Dev plugin state
  const [isLinkingDev, setIsLinkingDev] = useState(false);
  const [reloadingId, setReloadingId] = useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 150);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQuery]);

  // Clear search when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setDebouncedQuery('');
    }
  }, [isOpen]);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Fetch installed plugins when modal opens
  const fetchPlugins = useCallback(async () => {
    if (!projectPath) {
      setPlugins([]);
      return;
    }
    setIsLoading(true);
    try {
      const result = await listPlugins(projectPath);
      setPlugins(result);
    } catch (err) {
      trackError('plugin_list_load', err, 'Plugin Manager');
      logger.error('Failed to load plugins', {
        error: err instanceof Error ? err.message : String(err),
      });
      setPlugins([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (!isOpen) return;
    void fetchPlugins();
  }, [isOpen, fetchPlugins]);

  // Fetch registry when library tab is selected
  const fetchRegistry = useCallback(async () => {
    setIsLoadingRegistry(true);
    try {
      const result = await fetchPluginRegistry();
      setRegistry(result);
    } catch (err) {
      trackError('plugin_registry_load', err, 'Plugin Manager');
      logger.error('Failed to fetch plugin registry', {
        error: err instanceof Error ? err.message : String(err),
      });
      setRegistry([]);
    } finally {
      setIsLoadingRegistry(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen || activeTab !== 'library') return;
    void fetchRegistry();
  }, [isOpen, activeTab, fetchRegistry]);

  // Handle uninstall
  const handleUninstall = async (pluginId: string) => {
    if (!projectPath) return;
    setRemovingId(pluginId);
    try {
      await uninstallPlugin(projectPath, pluginId);
      void trackEvent('plugin_uninstalled', {
        plugin_id: pluginId,
        $screen_name: 'Plugin Manager',
      });
      await fetchPlugins();
      onPluginsChanged();
    } catch (err) {
      trackError('plugin_uninstall', err, 'Plugin Manager');
      logger.error('Failed to uninstall plugin', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRemovingId(null);
    }
  };

  // Handle toggle
  const handleToggle = async (pluginId: string, enabled: boolean) => {
    if (!projectPath) return;
    setTogglingId(pluginId);
    try {
      await togglePlugin(projectPath, pluginId, enabled);
      void trackEvent('plugin_toggled', {
        plugin_id: pluginId,
        enabled,
        $screen_name: 'Plugin Manager',
      });
      await fetchPlugins();
      onPluginsChanged();
    } catch (err) {
      trackError('plugin_toggle', err, 'Plugin Manager');
      logger.error('Failed to toggle plugin', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTogglingId(null);
    }
  };

  // Handle check for update
  const handleCheckUpdate = async (pluginId: string) => {
    if (!projectPath) return;
    setUpdateStates((prev) => ({ ...prev, [pluginId]: 'checking' }));
    try {
      const result = await checkPluginUpdate(projectPath, pluginId);
      setUpdateStates((prev) => ({
        ...prev,
        [pluginId]: result.has_update ? 'available' : 'up_to_date',
      }));
    } catch (err) {
      trackError('plugin_update_check', err, 'Plugin Manager');
      logger.error('Failed to check for update', {
        error: err instanceof Error ? err.message : String(err),
      });
      setUpdateStates((prev) => ({ ...prev, [pluginId]: 'idle' }));
    }
  };

  // Handle update
  const handleUpdate = async (pluginId: string) => {
    if (!projectPath) return;
    setUpdateStates((prev) => ({ ...prev, [pluginId]: 'updating' }));
    try {
      await updatePlugin(projectPath, pluginId);
      void trackEvent('plugin_updated', { plugin_id: pluginId, $screen_name: 'Plugin Manager' });
      await fetchPlugins();
      onPluginsChanged();
      setUpdateStates((prev) => ({ ...prev, [pluginId]: 'up_to_date' }));
    } catch (err) {
      trackError('plugin_update', err, 'Plugin Manager');
      logger.error('Failed to update plugin', {
        error: err instanceof Error ? err.message : String(err),
      });
      setUpdateStates((prev) => ({ ...prev, [pluginId]: 'available' }));
    }
  };

  // Handle install from library
  const handleLibraryInstall = async (entry: PluginRegistryEntry) => {
    if (!projectPath) return;
    setInstallingId(entry.id);
    setError(null);
    try {
      await installPlugin(projectPath, entry.repo);
      void trackEvent('plugin_installed', {
        plugin_id: entry.id,
        plugin_name: entry.name,
        source: 'library',
        category: entry.category,
        $screen_name: 'Plugin Manager',
      });
      await fetchPlugins();
      onPluginsChanged();
      setInstallingId(null);
    } catch (err) {
      trackError('plugin_install', err, 'Plugin Manager');
      logger.error('Failed to install plugin', {
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : String(err));
      setInstallingId(null);
    }
  };

  // Handle install from URL
  const handleUrlInstall = async () => {
    if (!repoUrl.trim() || !projectPath) return;
    setIsInstallingUrl(true);
    setError(null);
    try {
      await installPlugin(projectPath, repoUrl.trim());
      void trackEvent('plugin_installed', {
        source: 'url',
        repo_url: repoUrl.trim(),
        $screen_name: 'Plugin Manager',
      });
      setRepoUrl('');
      setShowUrlInput(false);
      await fetchPlugins();
      setActiveTab('installed');
      onPluginsChanged();
    } catch (err) {
      trackError('plugin_install_url', err, 'Plugin Manager');
      logger.error('Failed to install plugin from URL', {
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsInstallingUrl(false);
    }
  };

  // Handle link dev plugin
  const handleLinkDevPlugin = async () => {
    if (!projectPath) return;
    setIsLinkingDev(true);
    setError(null);
    try {
      const result = await linkDevPlugin(projectPath);
      if (result) {
        void trackEvent('plugin_dev_linked', {
          plugin_id: result.manifest.id,
          plugin_name: result.manifest.name,
          $screen_name: 'Plugin Manager',
        });
        await fetchPlugins();
        onPluginsChanged();
      }
    } catch (err) {
      trackError('plugin_dev_link', err, 'Plugin Manager');
      logger.error('Failed to link dev plugin', {
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLinkingDev(false);
    }
  };

  // Handle reload dev plugin
  const handleReloadDevPlugin = (pluginId: string) => {
    setReloadingId(pluginId);
    try {
      onPluginsChanged();
    } finally {
      // Small delay so spinner is visible
      setTimeout(() => setReloadingId(null), 400);
    }
  };

  // Handle unlink dev plugin
  const handleUnlinkDevPlugin = async (pluginId: string) => {
    if (!projectPath) return;
    setUnlinkingId(pluginId);
    try {
      await unlinkDevPlugin(projectPath, pluginId);
      void trackEvent('plugin_dev_unlinked', {
        plugin_id: pluginId,
        $screen_name: 'Plugin Manager',
      });
      await fetchPlugins();
      onPluginsChanged();
    } catch (err) {
      trackError('plugin_dev_unlink', err, 'Plugin Manager');
      logger.error('Failed to unlink dev plugin', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUnlinkingId(null);
    }
  };

  const installedIds = new Set(plugins.map((p) => p.manifest.id));

  // Filter plugins based on search query
  const filteredPlugins = debouncedQuery
    ? plugins.filter((p) => {
        const q = debouncedQuery.toLowerCase();
        return (
          p.manifest.name.toLowerCase().includes(q) ||
          p.manifest.description.toLowerCase().includes(q) ||
          (p.manifest.author && p.manifest.author.toLowerCase().includes(q))
        );
      })
    : plugins;

  const filteredRegistry = debouncedQuery
    ? registry.filter((entry) => {
        const q = debouncedQuery.toLowerCase();
        return (
          entry.name.toLowerCase().includes(q) ||
          entry.description.toLowerCase().includes(q) ||
          entry.author.toLowerCase().includes(q) ||
          entry.category.toLowerCase().includes(q)
        );
      })
    : registry;

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal plugins-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="plugins-modal-header">
          <h3>Plugins</h3>
          <button className="plugins-close-btn" onClick={onClose} title="Close" aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="plugins-tabs">
          <button
            className={`plugins-tab ${activeTab === 'installed' ? 'active' : ''}`}
            onClick={() => setActiveTab('installed')}
          >
            Installed
          </button>
          <button
            className={`plugins-tab ${activeTab === 'library' ? 'active' : ''}`}
            onClick={() => setActiveTab('library')}
          >
            Library
          </button>
        </div>

        {projectPath && (
          <div className="plugins-search">
            <SearchIcon size={12} />
            <input
              type="text"
              className="plugins-search-input"
              placeholder="Filter plugins..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
        )}

        <div className="plugins-modal-body">
          {!projectPath && (
            <div className="plugins-empty">Open a project to manage its plugins.</div>
          )}

          {projectPath && activeTab === 'installed' && (
            <>
              {isLoading && plugins.length === 0 && (
                <div className="plugins-loading">
                  <Spinner style={{ color: 'var(--text-primary)' }} />
                  Loading plugins...
                </div>
              )}

              {!isLoading && plugins.length === 0 && (
                <div className="plugins-empty">
                  No plugins installed yet. Browse the{' '}
                  <button className="plugins-empty-link" onClick={() => setActiveTab('library')}>
                    Library
                  </button>{' '}
                  to add one.
                </div>
              )}

              {!isLoading && plugins.length > 0 && filteredPlugins.length === 0 && (
                <div className="plugins-empty">No matching plugins</div>
              )}

              <PluginStatusGrid
                plugins={filteredPlugins}
                loadedPlugins={loadedPlugins}
                togglingId={togglingId}
                removingId={removingId}
                reloadingId={reloadingId}
                unlinkingId={unlinkingId}
                updateStates={updateStates}
                onToggle={(id, enabled) => void handleToggle(id, enabled)}
                onCheckUpdate={(id) => void handleCheckUpdate(id)}
                onUpdate={(id) => void handleUpdate(id)}
                onUninstall={(id) => void handleUninstall(id)}
                onReloadDev={(id) => handleReloadDevPlugin(id)}
                onUnlinkDev={(id) => void handleUnlinkDevPlugin(id)}
              />

              {error && activeTab === 'installed' && <div className="plugins-error">{error}</div>}

              <button
                className="plugins-link-dev-btn"
                onClick={() => {
                  void handleLinkDevPlugin();
                }}
                disabled={isLinkingDev}
              >
                {isLinkingDev ? 'Linking...' : 'Link Dev Plugin'}
              </button>
            </>
          )}

          {projectPath && activeTab === 'library' && (
            <>
              <div className="plugins-beta-notice">
                Plugins are new and in beta. If you experience any issues, please report them in the
                Slack group.
              </div>

              {isLoadingRegistry && registry.length === 0 && (
                <div className="plugins-loading">
                  <Spinner style={{ color: 'var(--text-primary)' }} />
                  Loading plugin library...
                </div>
              )}

              {!isLoadingRegistry && registry.length === 0 && (
                <div className="plugins-empty">
                  Could not load plugin library. Try installing from a URL below.
                </div>
              )}

              {!isLoadingRegistry && registry.length > 0 && filteredRegistry.length === 0 && (
                <div className="plugins-empty">No matching plugins</div>
              )}

              <div className="plugins-list">
                {filteredRegistry.map((entry) => {
                  const isInstalled = installedIds.has(entry.id);
                  const isThisInstalling = installingId === entry.id;

                  return (
                    <div key={entry.id} className="plugin-row">
                      <div className="plugin-info">
                        <div className="plugin-header">
                          <div>
                            <span className="plugin-name">{entry.name}</span>
                            <span className="plugin-meta">{entry.author}</span>
                          </div>
                          {isInstalled ? (
                            <span className="plugin-installed-badge">Installed</span>
                          ) : (
                            <button
                              className="plugin-library-install-btn"
                              onClick={() => {
                                void handleLibraryInstall(entry);
                              }}
                              disabled={isThisInstalling || installingId !== null}
                            >
                              {isThisInstalling ? 'Installing...' : 'Install'}
                            </button>
                          )}
                        </div>
                        <div className="plugin-desc">{entry.description}</div>
                        {entry.category && (
                          <div className="plugin-category-badge">{entry.category}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {error && <div className="plugins-error">{error}</div>}

              <PluginInstallForm
                showUrlInput={showUrlInput}
                onShowUrlInput={() => setShowUrlInput(true)}
                repoUrl={repoUrl}
                onRepoUrlChange={setRepoUrl}
                isInstallingUrl={isInstallingUrl}
                onInstall={() => void handleUrlInstall()}
              />
            </>
          )}
        </div>

        <div className="plugins-footer">
          <span className="plugins-footer-hint">
            Press <span className="help-shortcut">Esc</span> to close
          </span>
        </div>
      </div>
    </div>
  );
}
