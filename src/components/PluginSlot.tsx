/**
 * PluginSlot renders plugin components in designated UI locations.
 *
 * Each plugin slot wraps its plugins in a PluginContext.Provider
 * and an error boundary to isolate crashes.
 *
 * @module components/PluginSlot
 */

import { Component, type ReactNode, useState, useRef, useEffect, type ComponentType } from 'react';
import {
  PluginContext,
  exposePluginContext,
  type PluginContextValue,
  type PluginProjectData,
  type PluginAppActions,
  type PluginThemeData,
} from '../contexts/PluginContext';
import {
  execPluginShell,
  readPluginStorage,
  writePluginStorage,
  uninstallPlugin,
} from '../lib/plugins';
import { markPluginCrashed, isPluginCrashed } from '../lib/plugin-loader';
import { invoke } from '@tauri-apps/api/core';
import type { LoadedPlugin } from '../hooks/usePlugins';

interface PluginSlotProps {
  /** Slot name (e.g., "toolbar", "sidebar") */
  name: string;
  /** Plugins registered for this slot */
  plugins: LoadedPlugin[];
  /** Current project data */
  project: PluginProjectData | null;
  /** App actions for plugins */
  actions: PluginAppActions;
  /** Theme data for consistent styling */
  theme: PluginThemeData;
}

/** Error boundary state */
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  pluginId: string;
  pluginName: string;
  compact: boolean;
  onCrash?: () => void;
  children: ReactNode;
}

/**
 * Outermost isolation boundary — wraps the entire plugin render including
 * the Context.Provider. Catches errors that escape the inner PluginErrorBoundary
 * (e.g. plugins bundling their own React, errors during Provider setup, or
 * dual-React-instance edge cases).
 */
class PluginIsolationBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error(
      `[PluginIsolation] Plugin "${this.props.pluginId}" crashed (outer boundary):`,
      error
    );
    this.props.onCrash?.();
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

/** Error boundary that isolates plugin crashes */
class PluginErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error(`Plugin ${this.props.pluginId} crashed:`, error);
    this.props.onCrash?.();
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

/** Build a PluginContextValue for a specific plugin */
function buildContext(
  pluginId: string,
  project: PluginProjectData | null,
  actions: PluginAppActions,
  theme: PluginThemeData,
  requiredCommands: string[]
): PluginContextValue {
  const projectPath = project?.path || '';
  const allowedCommands = new Set(requiredCommands);

  return {
    pluginId,
    project,
    actions,
    shell: {
      exec: (command: string, args: string[], options?: { timeout?: number }) =>
        execPluginShell(pluginId, projectPath, command, args, options?.timeout),
    },
    storage: {
      read: () => readPluginStorage(pluginId, projectPath),
      write: (data: Record<string, unknown>) => writePluginStorage(pluginId, projectPath, data),
    },
    invoke: {
      call: <T = unknown,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        if (!allowedCommands.has(command)) {
          return Promise.reject(
            new Error(`Plugin "${pluginId}" is not allowed to call "${command}"`)
          );
        }
        return invoke<T>(command, args);
      },
    },
    theme,
  };
}

/**
 * Safely renders a plugin component inside a container div.
 *
 * Some plugins bundle their own React, causing hook errors that escape
 * React error boundaries entirely. This wrapper catches those by:
 * 1. Rendering the plugin component inside an isolated container
 * 2. Listening for error events that originate from plugin blob: URLs
 * 3. Replacing crashed plugin content with an inline error indicator
 */
function SafePluginWrapper({
  Component: PluginComponent,
  pluginId,
  onCrash,
}: {
  Component: ComponentType;
  pluginId: string;
  onCrash?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [crashed, setCrashed] = useState(false);

  useEffect(() => {
    function handleError(event: ErrorEvent) {
      if (!event.filename?.startsWith('blob:')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      console.error(`Plugin "${pluginId}" error caught by safety wrapper:`, event.error);
      setCrashed(true);
      onCrash?.();
    }

    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, [pluginId, onCrash]);

  if (crashed) return null;

  return (
    <div ref={containerRef} style={{ display: 'contents' }}>
      <PluginComponent />
    </div>
  );
}

export function PluginSlot({ name, plugins, project, actions, theme }: PluginSlotProps) {
  if (plugins.length === 0) return null;

  const compact = name === 'toolbar' || name === 'preview';

  return (
    <>
      {plugins.map((plugin) => {
        const pluginId = plugin.info.manifest.id;
        const pluginName = plugin.info.manifest.name;

        // Skip plugins that already crashed this session
        if (isPluginCrashed(pluginId)) return null;

        const SlotComponent = plugin.module.slots[name];
        if (!SlotComponent) return null;

        const ctx = buildContext(
          pluginId,
          project,
          actions,
          theme,
          plugin.info.manifest.required_commands || []
        );

        // Expose context on window globals for raw-JS and legacy plugins.
        const pluginsMap = ((
          window as unknown as Record<string, unknown>
        ).__SHIPSTUDIO_PLUGINS__ ??= {}) as Record<string, PluginContextValue>;
        pluginsMap[pluginId] = ctx;
        exposePluginContext(ctx);

        const handleCrash = () => {
          // 1. Block immediately so next render skips this plugin
          markPluginCrashed(pluginId);
          // 2. Toast the user
          actions.showToast(`"${pluginName}" crashed and was removed.`, 'error');
          // 3. Uninstall from disk (async, best-effort)
          const projectPath = project?.path;
          if (projectPath) {
            void uninstallPlugin(projectPath, pluginId).catch((e) =>
              console.error(`Failed to auto-remove plugin "${pluginId}":`, e)
            );
          }
        };

        return (
          <PluginIsolationBoundary
            key={pluginId}
            pluginId={pluginId}
            pluginName={pluginName}
            compact={compact}
            onCrash={handleCrash}
          >
            <PluginContext.Provider value={ctx}>
              <PluginErrorBoundary
                pluginId={pluginId}
                pluginName={pluginName}
                compact={compact}
                onCrash={handleCrash}
              >
                <SafePluginWrapper
                  Component={SlotComponent}
                  pluginId={pluginId}
                  onCrash={handleCrash}
                />
              </PluginErrorBoundary>
            </PluginContext.Provider>
          </PluginIsolationBoundary>
        );
      })}
    </>
  );
}
