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
    if (!shouldOpen) return;
    setIsPreviewHidden(false);
    setWorkspaceTab('preview');
    // Bringing the preview up is a convenience, not a precondition. If starting
    // the dev server throws — an unmocked command, a missing script, a port
    // already busy — it used to take the whole handler down with it, and React
    // never flushed the state update above, so the toggle did nothing at all.
    // The panel opens either way and says the preview isn't running.
    try {
      void Promise.resolve(startDevServer()).catch(() => undefined);
    } catch {
      // Deliberately ignored; see above.
    }
  }, [commentsOpen, setIsPreviewHidden, setWorkspaceTab, startDevServer]);
  return {
    open: commentsOpen,
    setOpen: setCommentsOpen,
    setPendingCount: setCommentsPendingCount,
    /** The header's prop group, shaped here so WorkspaceView just spreads it. */
    header: {
      commentsVisible: commentsOpen,
      commentsAvailable: isWebProject,
      commentsPendingCount,
      onToggleComments: toggleComments,
    },
  };
}
