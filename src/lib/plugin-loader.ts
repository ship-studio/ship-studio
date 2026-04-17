/**
 * Plugin module loader for Ship Studio.
 *
 * Handles dynamic loading of plugin JavaScript bundles using Blob URLs
 * (since Tauri WebKit doesn't support import() of local filesystem paths).
 *
 * Also exposes React globals for plugins to use without bundling their own copy.
 *
 * @module lib/plugin-loader
 */

import { readPluginBundle } from './plugins';
import { trackError } from './analytics';
import { logger } from './logger';

/** A component that a plugin registers for a specific UI slot */
export type SlotComponent = React.ComponentType<Record<string, never>>;

/** The module interface that plugins must export */
export interface PluginModule {
  /** Plugin display name */
  name: string;
  /** Map of slot names to React components */
  slots: Record<string, SlotComponent>;
  /** Called when the plugin is activated */
  onActivate?: () => void;
  /** Called when the plugin is deactivated */
  onDeactivate?: () => void;
}

/** Maximum time (ms) to wait for a plugin's dynamic import to resolve */
const PLUGIN_LOAD_TIMEOUT_MS = 10_000;

/** Cache of loaded plugin modules, keyed by "projectPath:pluginId" */
const moduleCache = new Map<string, PluginModule>();

/** Cache of blob URLs for cleanup */
const blobUrlCache = new Map<string, string>();

function cacheKey(projectPath: string, pluginId: string): string {
  return `${projectPath}:${pluginId}`;
}

/**
 * Load a plugin's JavaScript module via Blob URL + dynamic import.
 *
 * 1. Reads dist/index.js from the project's plugin directory via Rust backend
 * 2. Creates a Blob URL from the source
 * 3. Dynamic imports the Blob URL
 * 4. Caches the result
 */
export async function loadPluginModule(
  projectPath: string,
  pluginId: string
): Promise<PluginModule> {
  const key = cacheKey(projectPath, pluginId);

  // Return cached module if available
  const cached = moduleCache.get(key);
  if (cached) return cached;

  // Read JS bundle source from backend
  const source = await readPluginBundle(projectPath, pluginId);

  // Create Blob URL for dynamic import
  const blob = new Blob([source], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  blobUrlCache.set(key, blobUrl);

  try {
    // Dynamic import with cache-busting fragment and timeout protection
    const importUrl = `${blobUrl}#t=${Date.now()}`;
    const mod = (await Promise.race([
      import(/* @vite-ignore */ importUrl),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`Plugin "${pluginId}" timed out after ${PLUGIN_LOAD_TIMEOUT_MS}ms`)),
          PLUGIN_LOAD_TIMEOUT_MS
        )
      ),
    ])) as Record<string, unknown>;

    // Validate module exports
    const raw = mod;
    const pluginModule: PluginModule = {
      name: (raw.name as string) || pluginId,
      slots: (raw.slots as Record<string, SlotComponent>) || {},
      onActivate: typeof raw.onActivate === 'function' ? (raw.onActivate as () => void) : undefined,
      onDeactivate:
        typeof raw.onDeactivate === 'function' ? (raw.onDeactivate as () => void) : undefined,
    };

    moduleCache.set(key, pluginModule);

    // Call onActivate lifecycle hook
    if (pluginModule.onActivate) {
      try {
        pluginModule.onActivate();
      } catch (e) {
        trackError('plugin_onactivate', e, 'Workspace');
        logger.error(`Plugin ${pluginId} onActivate failed`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return pluginModule;
  } catch (e) {
    // Clean up blob URL on failure
    URL.revokeObjectURL(blobUrl);
    blobUrlCache.delete(key);
    throw new Error(`Failed to load plugin ${pluginId}: ${String(e)}`);
  }
}

/**
 * Unload a plugin module, cleaning up its Blob URL and cache entry.
 */
export function unloadPluginModule(projectPath: string, pluginId: string): void {
  const key = cacheKey(projectPath, pluginId);

  const mod = moduleCache.get(key);
  if (mod?.onDeactivate) {
    try {
      mod.onDeactivate();
    } catch (e) {
      trackError('plugin_ondeactivate', e, 'Workspace');
      logger.error(`Plugin ${pluginId} onDeactivate failed`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  moduleCache.delete(key);

  const blobUrl = blobUrlCache.get(key);
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrlCache.delete(key);
  }
}

/** Plugins that crashed at render time. Checked synchronously by PluginSlot to skip them. */
const crashedPlugins = new Set<string>();

/** Mark a plugin as crashed so it's immediately skipped on next render. */
export function markPluginCrashed(pluginId: string): void {
  crashedPlugins.add(pluginId);
}

/** Check if a plugin has been marked as crashed. */
export function isPluginCrashed(pluginId: string): boolean {
  return crashedPlugins.has(pluginId);
}

/**
 * Look up which plugin owns a blob URL.
 * Returns `{ projectPath, pluginId }` or null if not found.
 */
export function lookupBlobOwner(blobUrl: string): { projectPath: string; pluginId: string } | null {
  const base = blobUrl.split('#')[0];
  for (const [key, url] of blobUrlCache) {
    if (url === base) {
      const sep = key.indexOf(':');
      return { projectPath: key.slice(0, sep), pluginId: key.slice(sep + 1) };
    }
  }
  return null;
}

/**
 * Expose React and ReactDOM as window globals for plugins.
 *
 * Plugins mark react/react-dom as externals that resolve to these globals,
 * avoiding duplicate React instances.
 *
 * Must be called before any plugins are loaded (in main.tsx).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function exposeReactGlobals(React: any, ReactDOM: any): void {
  (window as unknown as Record<string, unknown>).__SHIPSTUDIO_REACT__ = React;
  (window as unknown as Record<string, unknown>).__SHIPSTUDIO_REACT_DOM__ = ReactDOM;
}
