/**
 * Hook for plugin terminal and suggestion popup state.
 *
 * Manages the plugin terminal modal (for CLI commands triggered by plugins)
 * and the plugin suggestion popup (e.g., suggesting Vercel plugin).
 */

import { useState, useCallback } from 'react';
import { installPlugin, listPlugins, VERCEL_PLUGIN_REPO } from '../lib/plugins';
import { asCommandError, formatCommandError } from '../lib/errors';
import { invoke } from '@tauri-apps/api/core';

interface PluginTerminalState {
  command: string;
  args: string[];
  title: string;
  resolve: (exitCode: number | null) => void;
}

interface PluginSuggestionState {
  pluginName: string;
  projectPath: string;
  repoUrl: string;
}

export function usePluginState() {
  // Plugin terminal modal state
  const [pluginTerminal, setPluginTerminal] = useState<PluginTerminalState | null>(null);
  const [pluginTerminalExited, setPluginTerminalExited] = useState(false);

  // Plugin suggestion popup state
  const [pluginSuggestion, setPluginSuggestion] = useState<PluginSuggestionState | null>(null);
  const [pluginSuggestionInstalling, setPluginSuggestionInstalling] = useState(false);

  // Open a terminal for plugin commands
  const openPluginTerminal = useCallback(
    (command: string, args: string[], options?: { title?: string }) => {
      return new Promise<number | null>((resolve) => {
        setPluginTerminalExited(false);
        setPluginTerminal({ command, args, title: options?.title || command, resolve });
      });
    },
    []
  );

  // Cancel/close plugin terminal
  const closePluginTerminal = useCallback(() => {
    if (pluginTerminal) {
      const resolve = pluginTerminal.resolve;
      setPluginTerminal(null);
      setPluginTerminalExited(false);
      resolve(null);
    }
  }, [pluginTerminal]);

  // Handle plugin terminal exit
  const handlePluginTerminalExit = useCallback(
    (exitCode: number | null) => {
      setPluginTerminalExited(true);
      if (pluginTerminal) {
        const resolve = pluginTerminal.resolve;
        setTimeout(() => {
          setPluginTerminal(null);
          setPluginTerminalExited(false);
          resolve(exitCode);
        }, 1000);
      }
    },
    [pluginTerminal]
  );

  // Check if Vercel plugin should be suggested for this project
  const checkPluginSuggestion = useCallback(async (projectPath: string) => {
    try {
      const sessionKey = `plugin-suggested-vercel-${projectPath}`;
      if (sessionStorage.getItem(sessionKey)) return;

      const hasVercelConfig = await invoke<boolean>('has_vercel_config', { projectPath });
      if (!hasVercelConfig) return;

      const installed = await listPlugins(projectPath);
      if (installed.some((p) => p.manifest.id === 'vercel')) return;

      sessionStorage.setItem(sessionKey, '1');
      setPluginSuggestion({
        pluginName: 'Vercel',
        projectPath,
        repoUrl: VERCEL_PLUGIN_REPO,
      });
    } catch {
      // Non-critical — silently ignore detection errors
    }
  }, []);

  // Install suggested plugin
  const installSuggestedPlugin = useCallback(
    async (
      onSuccess: (message: string) => void,
      onError: (message: string) => void,
      reloadPlugins: () => Promise<void>
    ) => {
      if (!pluginSuggestion) return;

      setPluginSuggestionInstalling(true);
      try {
        await installPlugin(pluginSuggestion.projectPath, pluginSuggestion.repoUrl);
        await reloadPlugins();
        const name = pluginSuggestion.pluginName;
        setPluginSuggestion(null);
        onSuccess(`${name} plugin installed`);
      } catch (err) {
        onError(`Failed to install plugin: ${formatCommandError(asCommandError(err))}`);
      } finally {
        setPluginSuggestionInstalling(false);
      }
    },
    [pluginSuggestion]
  );

  return {
    // Terminal state
    pluginTerminal,
    pluginTerminalExited,
    openPluginTerminal,
    closePluginTerminal,
    handlePluginTerminalExit,

    // Suggestion state
    pluginSuggestion,
    setPluginSuggestion,
    pluginSuggestionInstalling,
    checkPluginSuggestion,
    installSuggestedPlugin,
  };
}
