/**
 * Hook for workspace layout state management.
 *
 * Manages: log panel visibility, preview visibility, and the workspace tab
 * selector (preview/code/branches/prs). The narrow-window compact layout is a
 * separate tree driven by `useIsCompact`; its state lives in CompactWorkspace,
 * not here.
 */

import { useState, useCallback } from 'react';
import { trackEvent, trackPageview } from '../lib/analytics';

interface UseWorkspaceLayoutParams {
  /** Whether GitHub is connected for the current project */
  isGitHubConnected: boolean;
}

type WorkspaceTab = 'preview' | 'code' | 'branches' | 'prs';

const TAB_SCREEN: Record<WorkspaceTab, string> = {
  preview: 'Workspace - Preview',
  code: 'Workspace - Code',
  branches: 'Workspace - Branches',
  prs: 'Workspace - Pull Requests',
};

export function useWorkspaceLayout({ isGitHubConnected }: UseWorkspaceLayoutParams) {
  // Health-logs panel visibility (takes over the terminal pane when the user
  // opens the code-health log feed).
  const [showHealthLogs, setShowHealthLogs] = useState(false);

  // Preview panel visibility
  const [isPreviewHidden, setIsPreviewHidden] = useState(false);

  // Workspace tab state (preview/code/branches/prs). The raw value is what the
  // user selected; `workspaceTab` below projects it through the GitHub-connected
  // gate so branches/prs fall back to preview when GitHub isn't available. We
  // keep the raw value so the user's last selection comes back on reconnect.
  const [workspaceTabRaw, setWorkspaceTabRaw] = useState<WorkspaceTab>('preview');

  // Wrap the raw setter with analytics. Functional update lets us see the
  // previous tab without re-rendering this hook on every workspaceTabRaw change.
  const setWorkspaceTab = useCallback((tab: WorkspaceTab) => {
    setWorkspaceTabRaw((prev) => {
      if (prev !== tab) {
        void trackEvent('workspace_tab_switched', { from_tab: prev, to_tab: tab });
        trackPageview(TAB_SCREEN[tab]);
      }
      return tab;
    });
  }, []);

  const workspaceTab: WorkspaceTab =
    !isGitHubConnected && (workspaceTabRaw === 'branches' || workspaceTabRaw === 'prs')
      ? 'preview'
      : workspaceTabRaw;

  // Reset layout state (when going back to projects)
  const resetLayout = useCallback(() => {
    setShowHealthLogs(false);
  }, []);

  return {
    // Log panel
    showHealthLogs,
    setShowHealthLogs,

    // Preview
    isPreviewHidden,
    setIsPreviewHidden,

    // Tabs
    workspaceTab,
    setWorkspaceTab,

    // Reset
    resetLayout,
  };
}
