/**
 * The workspace side of leaving a comment.
 *
 * Comments used to have their own header toggle and their own floating panel.
 * They do not any more: a comment lives in Team → Comments, and *that* tab
 * being open is what arms clicking an element in the preview. One door, one
 * list, one place a note can be.
 *
 * What is left here is the side effect that door still needs. Placing a comment
 * means clicking the live preview, so opening the tab brings the preview
 * forward and starts the dev server — the same thing the Variables panel does
 * for the same reason.
 */
import { useEffect, useRef } from 'react';
import { useTeamWorkspace } from './useTeamWorkspace';
import type { CommentAgent } from '../lib/canvasComments';

interface Params {
  project: { path: string; name: string };
  /** Terminals a comment can be handed to. */
  agents: CommentAgent[];
  activeAgentId: number | null;
  isWebProject: boolean;
  previewRunning: boolean;
  setIsPreviewHidden: (hidden: boolean) => void;
  setWorkspaceTab: (tab: 'preview' | 'code' | 'branches' | 'prs') => void;
  startDevServer: () => Promise<void> | void;
  onTeamPanelToggle?: (isOpen: boolean, toggle: () => void) => void;
  teamPanelSelected?: boolean;
}

export function useWorkspaceComments({
  project,
  agents,
  activeAgentId,
  isWebProject,
  previewRunning,
  setIsPreviewHidden,
  setWorkspaceTab,
  startDevServer,
  onTeamPanelToggle,
  teamPanelSelected,
}: Params) {
  // Said once, where the list is, rather than left to be inferred from a list
  // that never grows.
  const pickerHint = !isWebProject
    ? 'Comments are placed on a live page, so they need a web preview.'
    : !previewRunning
      ? 'Start the preview to comment on an element. Comments you already left are here.'
      : null;
  const team = useTeamWorkspace(project, {
    agents,
    activeAgentId,
    pickerHint,
    onPanelToggle: onTeamPanelToggle,
    panelSelected: teamPanelSelected,
  });
  const active = team.commentsActive;
  const wasActive = useRef(false);

  useEffect(() => {
    if (!active || wasActive.current) {
      wasActive.current = active;
      return;
    }
    wasActive.current = true;
    setIsPreviewHidden(false);
    setWorkspaceTab('preview');
    // Bringing the preview up is a convenience, not a precondition. If starting
    // the dev server throws — an unmocked command, a missing script, a port
    // already busy — it must not take the rest of this down with it. The tab
    // opens either way and says the preview isn't running.
    try {
      void Promise.resolve(startDevServer()).catch(() => undefined);
    } catch {
      // Deliberately ignored; see above.
    }
  }, [active, setIsPreviewHidden, setWorkspaceTab, startDevServer]);

  return team;
}
