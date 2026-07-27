/**
 * Workspace integration for WordPress projects.
 *
 * Owns the preview-gate state (the site check itself runs inside
 * `WordpressSetup`; this hook tracks whether the gate has cleared for the
 * current project) and the connected site URL that the preview proxy targets.
 * Kept out of `WorkspaceView` so the orchestrator only wires callbacks.
 *
 * @module hooks/useWordpress
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getWordpressSiteUrl,
  isLocalSite,
  reconcileWordpressPending,
  siteHost,
  siteIsTls,
  sitePort,
} from '../lib/wordpress';
import type { RemotePreviewTarget } from './usePreviewConnection';
import type { ProjectType } from '../lib/static-server';

interface UseWordpressParams {
  projectPath: string;
  projectType: ProjectType;
  /** Restarts the dev server — a local site needs Ship Studio to start
   *  serving it the moment it's connected. */
  restartDevServer: () => Promise<void>;
}

export function useWordpress({ projectPath, projectType, restartDevServer }: UseWordpressParams) {
  const isWordpress = projectType === 'wordpress';

  // The gate re-checks whenever the user switches projects. State is adjusted
  // during render (React's recommended pattern) instead of in an effect, so
  // the stale-project frame never paints.
  const [ready, setReady] = useState(false);
  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  const [prevPath, setPrevPath] = useState(projectPath);
  if (prevPath !== projectPath) {
    setPrevPath(projectPath);
    setReady(false);
    setSiteUrl(null);
  }

  // Load the connected site so the preview has a proxy target the moment the
  // gate clears. Also retire the creation-time pending marker once the project
  // carries real WordPress files — detection no longer needs the hint, and a
  // folder later repurposed shouldn't stay WordPress forever.
  useEffect(() => {
    if (!isWordpress) return;
    let cancelled = false;
    void reconcileWordpressPending(projectPath).catch(() => {});
    void getWordpressSiteUrl(projectPath)
      .then((url) => {
        if (!cancelled) setSiteUrl(url);
      })
      .catch(() => {
        if (!cancelled) setSiteUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isWordpress, projectPath]);

  /** A site was already connected — show the preview as-is. */
  const markReady = useCallback((url: string) => {
    setSiteUrl(url);
    setReady(true);
  }, []);

  /** A site was just connected or changed — adopt it and drop the gate.
   *  A local site additionally needs the dev server started: Ship Studio owns
   *  it (a server the agent backgrounds dies with its shell), and the spawn
   *  decision is made when the server starts, which hasn't happened yet. */
  const connect = useCallback(
    (url: string) => {
      setSiteUrl(url);
      setReady(true);
      if (isLocalSite(url)) void restartDevServer();
    },
    [restartDevServer]
  );

  const remoteTarget = useMemo<RemotePreviewTarget | null>(() => {
    if (!isWordpress || !siteUrl) return null;
    return {
      origin: siteUrl,
      host: siteHost(siteUrl),
      port: sitePort(siteUrl),
      tls: siteIsTls(siteUrl),
    };
  }, [isWordpress, siteUrl]);

  return {
    isWordpress,
    siteUrl,
    remoteTarget,
    showGate: isWordpress && !ready,
    markReady,
    connect,
  };
}
