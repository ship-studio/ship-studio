/**
 * Open state for the pinned-comments layer, owned by the workspace rather than
 * the preview so the header can render the toggle and badge the backlog.
 *
 * Comments are placed by clicking the live preview, so opening them brings the
 * preview forward and starts the dev server — the same thing the Variables
 * panel does for the same reason.
 */
import { useCallback, useState } from 'react';

interface Params {
  isWebProject: boolean;
  setIsPreviewHidden: (hidden: boolean) => void;
  setWorkspaceTab: (tab: 'preview' | 'code' | 'branches' | 'prs') => void;
  startDevServer: () => Promise<void> | void;
}

export function useWorkspaceComments({
  isWebProject,
  setIsPreviewHidden,
  setWorkspaceTab,
  startDevServer,
}: Params) {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsPendingCount, setCommentsPendingCount] = useState(0);
  const toggleComments = useCallback(() => {
    const shouldOpen = !commentsOpen;
    setCommentsOpen(shouldOpen);
    if (shouldOpen) {
      setIsPreviewHidden(false);
      setWorkspaceTab('preview');
      void startDevServer();
    }
  }, [commentsOpen, setIsPreviewHidden, setWorkspaceTab, startDevServer]);
  return {
    open: commentsOpen,
    setOpen: setCommentsOpen,
    pendingCount: commentsPendingCount,
    setPendingCount: setCommentsPendingCount,
    available: isWebProject,
    toggle: toggleComments,
  };
}
