/**
 * The two home-level screens that aren't the project list: Workflows and Inbox.
 *
 * Extracted from App.tsx so the shell stays a router rather than growing a
 * third full screen body. They share the home sidebar and the same
 * `workspace-home` chrome as the dashboard, which is what makes moving between
 * Home, Workflows and Inbox feel like one app instead of three.
 *
 * @module components/workspace/StandingWorkView
 */

import type { ComponentProps } from 'react';
import { HomeSidebar } from './HomeSidebar';
import { WorkflowsView } from '../workflows/WorkflowsView';
import { InboxView } from '../inbox/InboxView';
import type { Project } from '../../lib/project';

interface StandingWorkViewProps {
  view: 'workflows' | 'inbox';
  isCompact: boolean;
  sidebarProps: Omit<ComponentProps<typeof HomeSidebar>, 'activeNav'>;
  /** Preselects the project when creating a workflow from an open workspace. */
  currentProjectPath: string | null;
  /** Opens a finding's project so its prompt can be handed to a terminal. */
  onOpenProject: (project: Project) => void | Promise<void>;
}

export function StandingWorkView({
  view,
  isCompact,
  sidebarProps,
  currentProjectPath,
  onOpenProject,
}: StandingWorkViewProps) {
  return (
    <div className="app workspace workspace-home">
      <div className={`projects-with-rail${isCompact ? ' is-compact' : ''}`} key="view-standing">
        {!isCompact && <HomeSidebar {...sidebarProps} activeNav={view} />}
        {view === 'workflows' ? (
          <WorkflowsView currentProjectPath={currentProjectPath} />
        ) : (
          <InboxView onOpenProject={onOpenProject} />
        )}
      </div>
    </div>
  );
}
