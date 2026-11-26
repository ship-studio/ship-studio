/**
 * Visibility for workspace tools that operate on the live web preview.
 * Opening one brings Preview forward and starts its dev server. Saved rail
 * placement remains separate from whether a feature is currently open.
 */

import { useCallback, useState } from 'react';

interface Params {
  isWebProject: boolean;
  workspaceTab: string;
  isPreviewHidden: boolean;
  projectPath: string;
  setIsPreviewHidden: (hidden: boolean) => void;
  setWorkspaceTab: (tab: 'preview' | 'code' | 'branches' | 'prs') => void;
  startDevServer: () => Promise<void> | void;
}

/** Own the open state shared by preview-bound workspace panels. */
export function useWorkspacePreviewPanel({
  isWebProject,
  workspaceTab,
  isPreviewHidden,
  projectPath,
  setIsPreviewHidden,
  setWorkspaceTab,
  startDevServer,
}: Params) {
  const [visible, setVisible] = useState(false);

  // A different project must never inherit the previous project's open panel.
  const [seenPath, setSeenPath] = useState(projectPath);
  if (projectPath !== seenPath) {
    setSeenPath(projectPath);
    setVisible(false);
  }

  const open = isWebProject && workspaceTab === 'preview' && !isPreviewHidden && visible;

  const toggle = useCallback(() => {
    const shouldOpen = !open;
    setVisible(shouldOpen);
    if (!shouldOpen) return;
    setIsPreviewHidden(false);
    setWorkspaceTab('preview');
    void Promise.resolve(startDevServer()).catch(() => undefined);
  }, [open, setIsPreviewHidden, setWorkspaceTab, startDevServer]);

  return { open, setVisible, toggle };
}
