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
import {
  markPluginCrashed,
  isPluginCrashed,
  wasPluginUnloaded,
  unloadPluginModule,
} from '../../lib/plugin-loader';
import { asCommandError, formatCommandError, isProjectFolderGoneError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { invoke } from '@tauri-apps/api/core';
import { WarningIcon } from '../icons';
import type { LoadedPlugin } from '../../hooks/usePlugins';

/**
 * Project paths whose root folder was detected missing mid-session (deleted,
 * renamed, or moved outside Ship Studio). Session-scoped one-shot guard: the
 * first plugin rejection for that project shows one info toast; a plugin that
 * keeps polling in the background is then only warn-logged instead of
 * toasting on every tick (issue #629 — same repeated-toast shape #315 fixed
 * for a plugin's own folder disappearing).
 */
const projectGoneNotified = new Set<string>();

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
    // A call that was already in flight when its plugin was unloaded
    // (project switch, uninstall) rejects after the plugin is gone —
    // an expected transient state, not an actionable error (issue #288).
    if (wasPluginUnloaded(projectPath, pluginId)) {
      logger.warn(`Plugin "${pluginId}" call rejected after unload — suppressing toast`, {
        error: formatCommandError(asCommandError(e)),
      });
      throw e;
    }
    const message = formatCommandError(asCommandError(e));
    // The plugin's backing files vanished without an in-app unlink/uninstall
    // (dev-linked folder deleted or moved, branch switch). Deactivate it like
    // an explicit unload — one clear toast now, and any background calls it
    // keeps making are suppressed instead of toasting every tick (issue #315).
    if (message.includes(`Plugin '${pluginId}' not found`)) {
      unloadPluginModule(projectPath, pluginId);
      actions.showToast(
        `Plugin "${pluginName}" was deactivated because its files are no longer on disk. Unlink or reinstall it from the Plugins menu.`,
        'error'
      );
      throw e;
    }
    // The *project's* folder is gone (deleted/renamed/moved outside the app
    // while its session stayed open) — an Expected environment change the
    // backend deliberately keeps out of telemetry, and permanent for this
    // path. One info toast per project, then only a local warn log, so a
    // plugin polling on its own interval can't toast every tick (issue #629).
    if (isProjectFolderGoneError(e)) {
      if (projectGoneNotified.has(projectPath)) {
        logger.warn(
          `Plugin "${pluginId}" call rejected — project folder is gone; toast suppressed`,
          { projectPath, error: message }
        );
      } else {
        projectGoneNotified.add(projectPath);
        actions.showToast(`Plugin "${pluginName}": ${message}`, 'info');
      }
      throw e;
    }
    // The host's own shell-command timeout (exec_plugin_shell). This catch is
    // attached at the context level, so it fires BEFORE the plugin's own
    // `.catch(() => null)` — a background poll the plugin deliberately lets
    // fail (e.g. the Vercel plugin's 3-second git ticks) used to error-toast
    // and telemetry-report anyway (issues #661/#662). The plugin decides
    // what's fatal: warn locally, re-throw, no toast.
    if (
      message.includes(`Plugin '${pluginId}' shell command '`) &&
      message.includes('timed out after')
    ) {
      logger.warn(`Plugin "${pluginId}" shell command timed out — plugin handles this itself`, {
        error: message,
      });
      throw e;
    }
    actions.showToast(`Plugin "${pluginName}": ${message}`, 'error');
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
        // Auto-inject the current project's path, matching how shell/storage
        // already close over it — most allow-listed commands require it, and
        // omitting it surfaced Tauri's raw "missing required key projectPath"
        // under the plugin's name (issue #322). Commands that don't take it
        // ignore extra args; an explicit args.projectPath still wins.
        const mergedArgs = projectPath ? { projectPath, ...args } : args;
        const result: Promise<T> = allowedCommands.has(command)
          ? invoke<T>(command, mergedArgs)
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
