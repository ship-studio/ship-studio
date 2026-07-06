/**
 * PluginSlot renders plugin components in designated UI locations.
 *
 * Each plugin slot wraps its plugins in a PluginContext.Provider
 * and an error boundary to isolate crashes. Crashed plugins render a
 * compact inline error chip (never silently disappear) and are disabled
 * for the session only — never uninstalled from disk.
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
} from '../../contexts/PluginContext';
import { execPluginShell, readPluginStorage, writePluginStorage } from '../../lib/plugins';
import { markPluginCrashed, isPluginCrashed } from '../../lib/plugin-loader';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { invoke } from '@tauri-apps/api/core';
import { WarningIcon } from '../icons';
import type { LoadedPlugin } from '../../hooks/usePlugins';

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

/**
 * Compact inline indicator shown where a crashed plugin would have rendered.
 * Keeps the plugin visible (so counts still add up) without being loud —
 * a muted warning glyph plus, outside compact slots, the plugin name.
 * The full error lives in the title tooltip.
 */
export function PluginErrorChip({
  pluginName,
  compact = false,
  detail,
}: {
  pluginName: string;
  compact?: boolean;
  detail?: string;
}) {
  const title = detail
    ? `"${pluginName}" failed: ${detail}`
    : `"${pluginName}" crashed — disabled for this session. Re-enable from Plugins.`;
  return (
    <span className="plugin-error-chip" title={title} aria-label={`${pluginName} unavailable`}>
      <WarningIcon size={12} />
      {!compact && <span className="plugin-error-chip-name">{pluginName}</span>}
    </span>
  );
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
    if (this.state.hasError) {
      return (
        <PluginErrorChip
          pluginName={this.props.pluginName}
          compact={this.props.compact}
          detail={this.state.error?.message}
        />
      );
    }
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
    if (this.state.hasError) {
      return (
        <PluginErrorChip
          pluginName={this.props.pluginName}
          compact={this.props.compact}
          detail={this.state.error?.message}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Build a PluginContextValue for a specific plugin.
 *
 * Every async capability (shell.exec, storage.*, invoke.call) is wrapped so
 * a rejection surfaces as an error toast (with the plugin name) before
 * re-throwing — plugins that handle their own errors still can, but a plugin
 * that ignores the rejection no longer fails silently.
 *
 * Exported for tests.
 */
export function buildContext(
  pluginId: string,
  pluginName: string,
  project: PluginProjectData | null,
  actions: PluginAppActions,
  theme: PluginThemeData,
  requiredCommands: string[]
): PluginContextValue {
  const projectPath = project?.path || '';
  const allowedCommands = new Set(requiredCommands);

  /** Toast the rejection (naming the plugin), then re-throw for the caller. */
  const report = (e: unknown): never => {
    actions.showToast(`Plugin "${pluginName}": ${formatCommandError(asCommandError(e))}`, 'error');
    throw e;
  };

  return {
    pluginId,
    project,
    actions,
    shell: {
      exec: (command: string, args: string[], options?: { timeout?: number }) =>
        execPluginShell(pluginId, projectPath, command, args, options?.timeout).catch(report),
    },
    storage: {
      read: () => readPluginStorage(pluginId, projectPath).catch(report),
      write: (data: Record<string, unknown>) =>
        writePluginStorage(pluginId, projectPath, data).catch(report),
    },
    invoke: {
      call: <T = unknown,>(command: string, args?: Record<string, unknown>): Promise<T> => {
        const result: Promise<T> = allowedCommands.has(command)
          ? invoke<T>(command, args)
          : Promise.reject(new Error(`Plugin "${pluginId}" is not allowed to call "${command}"`));
        return result.catch(report);
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
  pluginName,
  compact,
  onCrash,
}: {
  Component: ComponentType;
  pluginId: string;
  pluginName: string;
  compact: boolean;
  onCrash?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [crashError, setCrashError] = useState<Error | null>(null);

  useEffect(() => {
    function handleError(event: ErrorEvent) {
      if (!event.filename?.startsWith('blob:')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      console.error(`Plugin "${pluginId}" error caught by safety wrapper:`, event.error);
      setCrashError(event.error instanceof Error ? event.error : new Error(event.message));
      onCrash?.();
    }

    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, [pluginId, onCrash]);

  if (crashError) {
    return (
      <PluginErrorChip pluginName={pluginName} compact={compact} detail={crashError.message} />
    );
  }

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

        // Plugins that already crashed this session render an inert chip
        // instead of vanishing — visible counts stay honest.
        if (isPluginCrashed(pluginId)) {
          return <PluginErrorChip key={pluginId} pluginName={pluginName} compact={compact} />;
        }

        const SlotComponent = plugin.module.slots[name];
        if (!SlotComponent) return null;

        const ctx = buildContext(
          pluginId,
          pluginName,
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
          // Both boundaries (and the safety wrapper) can fire for the same
          // crash — only mark + toast once.
          if (isPluginCrashed(pluginId)) return;
          // Block immediately so next render swaps in the error chip. This is
          // session-only on purpose: a transient error must not permanently
          // disable (let alone delete) the plugin.
          markPluginCrashed(pluginId);
          actions.showToast(
            `"${pluginName}" crashed — disabled for this session. Re-enable from Plugins.`,
            'error'
          );
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
                  pluginName={pluginName}
                  compact={compact}
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
