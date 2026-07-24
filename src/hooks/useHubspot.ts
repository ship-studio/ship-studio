/**
 * Workspace integration for HubSpot CMS theme projects.
 *
 * Owns the preview-gate state (the CLI + auth checks themselves run inside
 * `HubspotSetup`; this hook tracks whether the gate has cleared for the
 * current project) and registers the HubSpot palette commands. Kept out of
 * `WorkspaceView` so the orchestrator only wires callbacks.
 *
 * @module hooks/useHubspot
 */

import { useCallback, useState } from 'react';
import { useHubspotCommands } from '../commands/useHubspotCommands';
import type { ProjectType } from '../lib/static-server';

interface UseHubspotParams {
  projectPath: string;
  projectType: ProjectType;
  onSendToAgent: (prompt: string) => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
  /** Restarts the dev server — used after the CLI is set up or the theme path changes. */
  restartDevServer: () => Promise<void>;
}

export function useHubspot({
  projectPath,
  projectType,
  onSendToAgent,
  showToast,
  restartDevServer,
}: UseHubspotParams) {
  const isHubspotTheme = projectType === 'hubspotcms';

  // The gate re-checks whenever the user switches projects. State is
  // adjusted during render (React's recommended pattern) instead of in an
  // effect, so the stale-project frame never paints.
  const [ready, setReady] = useState(false);
  const [prevPath, setPrevPath] = useState(projectPath);
  if (prevPath !== projectPath) {
    setPrevPath(projectPath);
    setReady(false);
  }

  /** CLI + auth were already in place — show the preview as-is. */
  const markReady = useCallback(() => setReady(true), []);

  /** Setup just completed (or theme path changed) — the deferred dev server must (re)start. */
  const connect = useCallback(() => {
    setReady(true);
    void restartDevServer();
  }, [restartDevServer]);

  useHubspotCommands({ projectType, projectPath, onSendToAgent, showToast });

  return { isHubspotTheme, showGate: isHubspotTheme && !ready, markReady, connect };
}
