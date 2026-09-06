/**
 * Hook for plugin terminal and suggestion popup state.
 *
 * Manages the plugin terminal modal (for CLI commands triggered by plugins)
 * and the plugin suggestion popup (currently dormant — hosting moved native).
 */

import { useState, useCallback } from 'react';
import { installPlugin } from '../lib/plugins';
import { asCommandError, formatCommandError } from '../lib/errors';

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

  // Hosting is becoming a native feature, so detecting `.vercel/project.json`
  // no longer offers to install the Vercel plugin — a project linked to a
  // provider is picked up by the native hosting module instead. The suggestion
  // machinery below stays wired (nothing else suggests a plugin today) so this
  // is a one-line revert if the native rollout is paused; it is removed
  // wholesale once the native module ships for all three providers.
  // Still returns a promise so callers keep awaiting it unchanged.
  const checkPluginSuggestion = useCallback((_projectPath: string): Promise<void> => {
    return Promise.resolve();
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
