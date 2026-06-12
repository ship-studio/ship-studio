/**
 * Workspace integration for Shopify theme projects.
 *
 * Owns the preview-gate state (the CLI + store checks themselves run inside
 * `ShopifySetup`; this hook tracks whether the gate has cleared for the
 * current project) and registers the Shopify palette commands. Kept out of
 * `WorkspaceView` so the orchestrator only wires callbacks.
 *
 * @module hooks/useShopifyTheme
 */

import { useCallback, useState } from 'react';
import { useShopifyCommands } from '../commands/useShopifyCommands';
import type { ProjectType } from '../lib/static-server';

interface UseShopifyThemeParams {
  projectPath: string;
  projectType: ProjectType;
  onSendToAgent: (prompt: string) => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
  /** Restarts the dev server — used after a store is connected/changed. */
  restartDevServer: () => Promise<void>;
}

export function useShopifyTheme({
  projectPath,
  projectType,
  onSendToAgent,
  showToast,
  restartDevServer,
}: UseShopifyThemeParams) {
  const isShopifyTheme = projectType === 'shopifytheme';

  // The gate re-checks whenever the user switches projects. State is
  // adjusted during render (React's recommended pattern) instead of in an
  // effect, so the stale-project frame never paints.
  const [ready, setReady] = useState(false);
  const [prevPath, setPrevPath] = useState(projectPath);
  if (prevPath !== projectPath) {
    setPrevPath(projectPath);
    setReady(false);
  }

  /** CLI + store were already in place — show the preview as-is. */
  const markReady = useCallback(() => setReady(true), []);

  /** A store was just connected/changed — the deferred dev server must (re)start. */
  const connect = useCallback(() => {
    setReady(true);
    void restartDevServer();
  }, [restartDevServer]);

  useShopifyCommands({ projectType, projectPath, onSendToAgent, showToast });

  return { isShopifyTheme, showGate: isShopifyTheme && !ready, markReady, connect };
}
