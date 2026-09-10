/**
 * Access the Harbr plugin context.
 *
 * Preferred: usePluginContext() — uses React.useContext with the shared
 * PluginContext ref, so each plugin always gets its own context even when
 * multiple plugins render simultaneously.
 *
 * Legacy: getPluginContext() — reads the single window global (last-writer-wins).
 *
 * @module context
 */

/** Plugin context value matching the host app's PluginContextValue */
export interface PluginContextValue {
  pluginId: string;
  project: {
    name: string;
    path: string;
    currentBranch: string;
    hasUncommittedChanges: boolean;
    devServerUrl?: string;
  } | null;
  actions: {
    showToast: (message: string, type?: 'success' | 'error') => void;
    refreshGitStatus: () => void;
    refreshBranches: () => void;
    focusTerminal: () => void;
    openUrl: (url: string) => void;
  };
  shell: {
    exec: (command: string, args: string[], options?: { timeout?: number }) => Promise<{
      stdout: string;
      stderr: string;
      exit_code: number;
    }>;
  };
  storage: {
    read: () => Promise<Record<string, unknown>>;
    write: (data: Record<string, unknown>) => Promise<void>;
  };
  /**
   * Cross-platform filesystem access scoped to the project directory. Use
   * this instead of `shell.exec('test', ['-f', path])` or
   * `shell.exec('cat', [path])` — those POSIX binaries aren't on PATH by
   * default on Windows, so any plugin shelling out to them for a file check
   * fails outright there.
   */
  fs: {
    /** Whether `path` (relative to the project root) exists. */
    exists: (path: string) => Promise<boolean>;
    /** UTF-8 contents of `path` (relative to the project root), or `null` if it doesn't exist. */
    readText: (path: string) => Promise<string | null>;
  };
  invoke: {
    call: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
  };
  theme: {
    bgPrimary: string;
    bgSecondary: string;
    bgTertiary: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    border: string;
    accent: string;
    accentHover: string;
    action: string;
    actionHover: string;
    actionText: string;
    error: string;
    success: string;
  };
}

/**
 * React hook that returns the current plugin's context.
 *
 * Uses React.useContext with the shared PluginContext ref exposed by the host,
 * so each plugin always receives its own per-plugin context — even when
 * multiple plugins render at the same time.
 *
 * Must be called inside a React component (it's a hook).
 */
export function usePluginContext(): PluginContextValue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const React = (window as any).__SHIPSTUDIO_REACT__;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CtxRef = (window as any).__SHIPSTUDIO_PLUGIN_CONTEXT_REF__;

  if (CtxRef && React?.useContext) {
    const ctx = React.useContext(CtxRef) as PluginContextValue | null;
    if (ctx) return ctx;
  }

  // Fallback: legacy single global (last-writer-wins, won't work in async code)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (window as any).__SHIPSTUDIO_PLUGIN_CONTEXT__ as PluginContextValue | undefined;
  if (!ctx) {
    throw new Error(
      '@shipstudio/plugin-sdk: Plugin context not available. ' +
        'Ensure this is called within a Harbr plugin component.'
    );
  }
  return ctx;
}

/**
 * @deprecated Use usePluginContext() instead. This reads the legacy single
 * window global which suffers from context collision when multiple plugins render.
 */
export function getPluginContext(): PluginContextValue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (window as any).__SHIPSTUDIO_PLUGIN_CONTEXT__ as PluginContextValue | undefined;
  if (!ctx) {
    throw new Error(
      '@shipstudio/plugin-sdk: Plugin context not available. ' +
        'Ensure this is called within a Harbr plugin component.'
    );
  }
  return ctx;
}
