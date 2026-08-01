/**
 * Hook for managing plugin lifecycle.
 *
 * Loads enabled plugins for the current project, tracks loaded modules,
 * and provides helpers for querying which plugins register for specific UI slots.
 *
 * Failures (unsupported API version, bundle load errors, registry list errors)
 * are exposed via `failures` so the UI can show them instead of silently
 * shrinking the plugin list; lifecycle-hook errors are reported through the
 * optional `onError` callback.
 *
 * @module hooks/usePlugins
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { listPlugins, PluginInfo } from '../lib/plugins';
import { loadPluginModule, unloadPluginModule, PluginModule } from '../lib/plugin-loader';
import { asCommandError, formatCommandError } from '../lib/errors';
import { logger } from '../lib/logger';

/** API versions the host supports. Plugins with unsupported versions are skipped. */
const SUPPORTED_API_VERSIONS = [0, 1];

/** A fully loaded plugin: manifest + JS module */
export interface LoadedPlugin {
  info: PluginInfo;
  module: PluginModule;
}

/** A plugin that could not be loaded, with a user-facing reason */
export interface PluginFailure {
  /** Manifest id, or null when the failure isn't tied to one plugin (list error) */
  id: string | null;
  name: string;
  reason: string;
}

/** Options for usePlugins */
export interface UsePluginsOptions {
  /** Called when a plugin's onActivate/onDeactivate lifecycle hook throws. */
  onError?: (pluginName: string, message: string) => void;
}

/** Return type for usePlugins hook */
export interface UsePluginsReturn {
  /** All loaded plugins */
  plugins: LoadedPlugin[];
  /** Plugins that failed to load (unsupported API version, bad bundle, list error) */
  failures: PluginFailure[];
  /** Get plugins registered for a specific UI slot */
  getSlotPlugins: (slotName: string) => LoadedPlugin[];
  /** Reload all plugins (call after install/uninstall) */
  reloadPlugins: () => Promise<void>;
  /** Whether plugins are currently loading */
  isLoading: boolean;
}

export function usePlugins(
  projectPath: string | null,
  options?: UsePluginsOptions
): UsePluginsReturn {
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  const [failures, setFailures] = useState<PluginFailure[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);
  const currentPathRef = useRef(projectPath);

  // Keep the latest onError without re-triggering plugin loads
  const onErrorRef = useRef(options?.onError);
  useEffect(() => {
    onErrorRef.current = options?.onError;
  });

  /** Stable lifecycle-error handler passed to the module loader. */
  const handleLifecycleError = useCallback((pluginName: string, error: unknown) => {
    onErrorRef.current?.(pluginName, formatCommandError(asCommandError(error)));
  }, []);

  const loadAllPlugins = useCallback(
    async (path: string | null) => {
      if (!path) {
        setPlugins([]);
        setFailures([]);
        return;
      }

      setIsLoading(true);
      try {
        const installed = await listPlugins(path);
        const enabled = installed.filter((p) => p.enabled);
        const failed: PluginFailure[] = [];

        // Skip plugins with unsupported API versions
        const compatible = enabled.filter((info) => {
          const v = info.manifest.api_version ?? 0;
          if (!SUPPORTED_API_VERSIONS.includes(v)) {
            logger.warn(
              `Plugin "${info.manifest.id}" requires API v${v} which is not supported (supported: ${SUPPORTED_API_VERSIONS.join(', ')}). Skipping.`
            );
            failed.push({
              id: info.manifest.id,
              name: info.manifest.name,
              reason: `Requires plugin API v${v}; this app supports v${SUPPORTED_API_VERSIONS.join(', ')}. Update Ship Studio or the plugin.`,
            });
            return false;
          }
          return true;
        });

        const results = await Promise.allSettled(
          compatible.map((info) =>
            loadPluginModule(path, info.manifest.id, handleLifecycleError).then((module) => ({
              info,
              module,
            }))
          )
        );
        const loaded: LoadedPlugin[] = [];
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            loaded.push(result.value);
          } else {
            const info = compatible[i];
            logger.error('Failed to load plugin', {
              plugin: info.manifest.id,
              // Mirror failed.push below — String() on a CommandError object
              // logs "[object Object]" (issue #408).
              error: formatCommandError(asCommandError(result.reason)),
            });
            failed.push({
              id: info.manifest.id,
              name: info.manifest.name,
              reason: formatCommandError(asCommandError(result.reason)),
            });
          }
        });

        if (mountedRef.current && currentPathRef.current === path) {
          setPlugins(loaded);
          setFailures(failed);
        }
      } catch (e) {
        logger.error('Failed to list plugins', {
          error: formatCommandError(asCommandError(e)),
        });
        if (mountedRef.current && currentPathRef.current === path) {
          setPlugins([]);
          setFailures([
            {
              id: null,
              name: 'Plugins',
              reason: `Could not read installed plugins: ${formatCommandError(asCommandError(e))}`,
            },
          ]);
        }
      } finally {
        if (mountedRef.current) {
          setIsLoading(false);
        }
      }
    },
    [handleLifecycleError]
  );

  // Reload when project changes
  useEffect(() => {
    mountedRef.current = true;
    // Unload the previous project's plugins under the path they were loaded
    // with — the module cache is keyed by (path, id), so unloading with the
    // NEW path is a silent no-op that leaves the old modules' timers and
    // hooks alive, firing backend calls against a project where the plugin
    // isn't installed ("Plugin 'x' not found" toasts on project switch).
    const previousPath = currentPathRef.current;
    currentPathRef.current = projectPath;
    plugins.forEach((p) =>
      unloadPluginModule(previousPath || '', p.info.manifest.id, handleLifecycleError)
    );

    void loadAllPlugins(projectPath);

    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const reloadPlugins = useCallback(async () => {
    // Unload current plugins
    plugins.forEach((p) =>
      unloadPluginModule(projectPath || '', p.info.manifest.id, handleLifecycleError)
    );
    await loadAllPlugins(projectPath);
  }, [plugins, loadAllPlugins, projectPath, handleLifecycleError]);

  const getSlotPlugins = useCallback(
    (slotName: string): LoadedPlugin[] => {
      return plugins.filter(
        (p) => p.info.manifest.slots.includes(slotName) && p.module.slots[slotName]
      );
    },
    [plugins]
  );

  return { plugins, failures, getSlotPlugins, reloadPlugins, isLoading };
}
