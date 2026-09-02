/**
 * PluginManager component for installing, managing, and removing plugins.
 *
 * Plugins are project-level: each project has its own set of plugins.
 * The "Library" tab fetches available plugins from the remote registry.
 *
 * @module components/PluginManager
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { trackEvent, trackError } from '../../lib/analytics';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { repoUrlsMatch } from '../../lib/pluginRepoUrl';
import {
  listPlugins,
  installPlugin,
  uninstallPlugin,
  togglePlugin,
  checkPluginUpdate,
  updatePlugin,
  fetchPluginRegistry,
  isExpectedPluginFailure,
  isRegistryUnreachableError,
  linkDevPlugin,
  unlinkDevPlugin,
  type PluginInfo,
  type PluginRegistryEntry,
} from '../../lib/plugins';
import type { LoadedPlugin } from '../../hooks/usePlugins';
import { useModal } from '../../contexts/ModalContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { PluginInstallForm } from './PluginInstallForm';
import { PluginStatusGrid } from './PluginStatusGrid';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import {
  ExtensionListRow,
  ExtensionManagerLayout,
  ExtensionSearchField,
  ExtensionState,
} from './extension';

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
  const { showToast } = useOptionalToast();
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
  /** Why the library fetch failed, so an empty list isn't read as "the library
   *  is empty" (#713). `unreachable` is the user's network or GitHub's rate
   *  limiter; `malformed` is a registry body we couldn't parse — a different
   *  problem, with a different fix, so it gets its own copy. */
  const [registryFailure, setRegistryFailure] = useState<'unreachable' | 'malformed' | null>(null);
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

  // Plugins already background-checked for updates this modal-open, so a
  // refetch (toggle, uninstall, …) doesn't re-hit the network per plugin.
  const autoCheckedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isOpen) autoCheckedRef.current = new Set();
  }, [isOpen]);

  // Proactively check installed plugins for updates in the background
  // (issue #572): fixed plugin releases otherwise never reach users who
  // don't think to click "Check for update" on each plugin — a stale broken
  // bundle (e.g. the Vercel plugin's POSIX-only `cat` on Windows) kept
  // failing indefinitely. Failures are silent: this is a nicety, and an
  // offline machine shouldn't toast or file reports over it.
  const autoCheckUpdates = useCallback(
    async (installed: PluginInfo[]) => {
      if (!projectPath) return;
      const candidates = installed.filter(
        (p) => !p.is_dev && p.source_url && !autoCheckedRef.current.has(p.manifest.id)
      );
      await Promise.allSettled(
        candidates.map(async (p) => {
          autoCheckedRef.current.add(p.manifest.id);
          try {
            const result = await checkPluginUpdate(projectPath, p.manifest.id);
            setUpdateStates((prev) => {
              // Never clobber an in-flight manual action.
              const current = prev[p.manifest.id];
              if (current === 'updating' || current === 'checking') return prev;
              return {
                ...prev,
                [p.manifest.id]: result.has_update ? 'available' : 'up_to_date',
              };
            });
          } catch (err) {
            logger.warn('Background plugin update check failed', {
              plugin: p.manifest.id,
              error: formatCommandError(asCommandError(err)),
            });
          }
        })
      );
    },
    [projectPath]
  );

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
      void autoCheckUpdates(result);
    } catch (err) {
      trackError('plugin_list_load', err, 'Plugin Manager');
      // A vanished project folder / denied plugin registry is an environment
      // state the backend classifies Expected (#831, #762) — warn, don't file.
      logger[isExpectedPluginFailure(err) ? 'warn' : 'error']('Failed to load plugins', {
        error: formatCommandError(asCommandError(err)),
      });
      setPlugins([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath, autoCheckUpdates]);

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
      setRegistryFailure(null);
    } catch (err) {
      trackError('plugin_registry_load', err, 'Plugin Manager');
      // A reachability failure survived the retry/backoff (#713) — that's the
      // network or GitHub's rate limiter, not an app defect. A malformed
      // registry body still errors: that one IS ours to fix, and telling the
      // user to check their connection would send them after the wrong thing.
      const msg = formatCommandError(asCommandError(err));
      const unreachable = isRegistryUnreachableError(err);
      logger[unreachable ? 'warn' : 'error']('Failed to fetch plugin registry', { error: msg });
      setRegistry([]);
      setRegistryFailure(unreachable ? 'unreachable' : 'malformed');
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
        error: formatCommandError(asCommandError(err)),
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
        error: formatCommandError(asCommandError(err)),
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
      // Offline / auth-walled / deleted remotes are Expected (#803, #732).
      logger[isExpectedPluginFailure(err) ? 'warn' : 'error']('Failed to check for update', {
        error: formatCommandError(asCommandError(err)),
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
      logger[isExpectedPluginFailure(err) ? 'warn' : 'error']('Failed to update plugin', {
        error: formatCommandError(asCommandError(err)),
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
      const msg = formatCommandError(asCommandError(err));
      // A by-design refusal (bad manifest, unclonable URL, version mismatch…)
      // is the app working correctly. logger.error files a bug report, and so
      // does an 'error' toast — both had to be downgraded, since logger.error
      // fires before the toast (issues #734, #833).
      const expected = isExpectedPluginFailure(err);
      logger[expected ? 'warn' : 'error']('Failed to install plugin', { error: msg });
      setError(msg);
      // Toast too — the inline error renders below the plugin list, off-screen
      // in a long library, so a failure otherwise looks like nothing happened.
      showToast(msg, expected ? 'info' : 'error');
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
      const msg = formatCommandError(asCommandError(err));
      // Same downgrade as handleLibraryInstall — a pasted URL that isn't a
      // clonable repo is user input, not a defect (issues #734, #833, #803).
      const expected = isExpectedPluginFailure(err);
      logger[expected ? 'warn' : 'error']('Failed to install plugin from URL', { error: msg });
      setError(msg);
      showToast(msg, expected ? 'info' : 'error');
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
      // link_dev_plugin's manifest/bundle/id checks are by-design refusals of
      // the folder the developer picked (issue #760) — the inline error still
      // tells them what's wrong, but it isn't a bug to file.
      logger[isExpectedPluginFailure(err) ? 'warn' : 'error']('Failed to link dev plugin', {
        error: formatCommandError(asCommandError(err)),
      });
      setError(formatCommandError(asCommandError(err)));
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
        error: formatCommandError(asCommandError(err)),
      });
    } finally {
      setUnlinkingId(null);
    }
  };

  // A registry entry counts as installed when its slug matches an installed
  // manifest id OR its repo matches an installed plugin's source URL — the
  // slug and manifest id can drift apart (renames), and matching only ids
  // caused an endless "Install" loop for already-installed plugins.
  const installedIds = new Set(plugins.map((p) => p.manifest.id));
  const isEntryInstalled = (entry: PluginRegistryEntry): boolean =>
    installedIds.has(entry.id) || plugins.some((p) => repoUrlsMatch(p.source_url, entry.repo));

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
    <ModalFrame isOpen onClose={onClose} title="Plugins" className="plugins-modal">
      <Tabs value={activeTab} onValueChange={(next) => setActiveTab(next as Tab)}>
        <ExtensionManagerLayout
          tabs={
            <TabsList className="plugins-tabs" aria-label="Plugins view">
              <TabsTab value="installed" className="plugins-tab">
                Installed
              </TabsTab>
              <TabsTab value="library" className="plugins-tab">
                Library
              </TabsTab>
            </TabsList>
          }
          controls={
            projectPath ? (
              <ExtensionSearchField
                className="plugins-search"
                placeholder="Filter plugins..."
                aria-label="Filter plugins"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            ) : undefined
          }
          footer={
            <span className="extension-manager-layout__footer-hint">
              Press <span className="help-shortcut">Esc</span> to close
            </span>
          }
        >
          <TabsPanel value="installed" className="plugins-modal-body">
            {!projectPath && (
              <ExtensionState kind="empty">Open a project to manage its plugins.</ExtensionState>
            )}

            {projectPath && activeTab === 'installed' && (
              <>
                {isLoading && plugins.length === 0 && (
                  <ExtensionState kind="loading" loadingLabel="Loading plugins">
                    Loading plugins...
                  </ExtensionState>
                )}

                {!isLoading && plugins.length === 0 && (
                  <ExtensionState kind="empty">
                    No plugins installed yet. Browse the{' '}
                    <TextButton variant="primary" onClick={() => setActiveTab('library')}>
                      Library
                    </TextButton>{' '}
                    to add one.
                  </ExtensionState>
                )}

                {!isLoading && plugins.length > 0 && filteredPlugins.length === 0 && (
                  <ExtensionState kind="empty">No matching plugins</ExtensionState>
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

                {error && activeTab === 'installed' && (
                  <ExtensionState kind="error">{error}</ExtensionState>
                )}

                <Button
                  variant="default"
                  width="fill"
                  onClick={() => {
                    void handleLinkDevPlugin();
                  }}
                  disabled={isLinkingDev}
                >
                  {isLinkingDev ? 'Linking...' : 'Link Dev Plugin'}
                </Button>
              </>
            )}
          </TabsPanel>

          <TabsPanel value="library" className="plugins-modal-body">
            {!projectPath && (
              <ExtensionState kind="empty">Open a project to manage its plugins.</ExtensionState>
            )}
            {projectPath && activeTab === 'library' && (
              <>
                <div className="plugins-beta-notice">
                  Plugins are new and in beta. If you experience any issues, please report them in
                  the Slack group.
                </div>

                {isLoadingRegistry && registry.length === 0 && (
                  <ExtensionState kind="loading" loadingLabel="Loading plugin library">
                    Loading plugin library...
                  </ExtensionState>
                )}

                {!isLoadingRegistry && registry.length === 0 && (
                  <ExtensionState kind="empty">
                    {registryFailure === 'unreachable' && (
                      <>
                        Couldn&apos;t reach the plugin library. Check your connection, or try again
                        in a minute — GitHub sometimes rate-limits this request. You can still
                        install from a URL below.
                      </>
                    )}
                    {registryFailure === 'malformed' && (
                      <>
                        The plugin library loaded but we couldn&apos;t read it — that&apos;s a
                        problem on our side, not your connection. You can still install from a URL
                        below.
                      </>
                    )}
                    {registryFailure === null &&
                      'The plugin library is empty right now. You can still install from a URL below.'}
                  </ExtensionState>
                )}

                {!isLoadingRegistry && registry.length > 0 && filteredRegistry.length === 0 && (
                  <ExtensionState kind="empty">No matching plugins</ExtensionState>
                )}

                <div className="plugins-list">
                  {filteredRegistry.map((entry) => {
                    const isInstalled = isEntryInstalled(entry);
                    const isThisInstalling = installingId === entry.id;

                    return (
                      <ExtensionListRow
                        key={entry.id}
                        className="plugin-row"
                        action={
                          isInstalled ? (
                            <span className="plugin-installed-badge">Installed</span>
                          ) : (
                            <Button
                              variant="primary"
                              onClick={() => {
                                void handleLibraryInstall(entry);
                              }}
                              disabled={isThisInstalling || installingId !== null}
                            >
                              {isThisInstalling ? 'Installing...' : 'Install'}
                            </Button>
                          )
                        }
                      >
                        <div className="plugin-info">
                          <div className="plugin-header">
                            <div>
                              <span className="plugin-name">{entry.name}</span>
                              <span className="plugin-meta">{entry.author}</span>
                            </div>
                          </div>
                          <div className="plugin-desc">{entry.description}</div>
                          {entry.category && (
                            <div className="plugin-category-badge">{entry.category}</div>
                          )}
                        </div>
                      </ExtensionListRow>
                    );
                  })}
                </div>

                {error && <ExtensionState kind="error">{error}</ExtensionState>}

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
          </TabsPanel>
        </ExtensionManagerLayout>
      </Tabs>
    </ModalFrame>
  );
}
