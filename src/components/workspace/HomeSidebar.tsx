/**
 * The workspace sidebar as it appears on the home-level screens (Projects,
 * Workflows, Inbox), where there is no active project and no terminal tabs.
 *
 * Extracted so the home screens share one configuration of `WorkspaceSidebar`
 * instead of each repeating its twenty inert props.
 *
 * @module components/workspace/HomeSidebar
 */

import type { ReactNode } from 'react';
import { WorkspaceSidebar, type ToggleProjectPinHandler } from './WorkspaceSidebar';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';

const EMPTY_TAB_TITLES = new Map<number, string>();
const EMPTY_ATTENTION_TABS = new Set<number>();
const noop = () => {};

interface HomeSidebarProps {
  /** Which home destination is showing, so the nav row can mark it current. */
  activeNav: 'home' | 'workflows' | 'inbox' | 'agents';
  /** Agents mode shows its agent list in place of the projects. */
  listContent?: ReactNode;
  onGoHome: () => void;
  onGoWorkflows: () => void;
  onGoInbox: () => void;
  inboxUnreadCount: number;
  onGoAgents: () => void;
  agentsUnreadCount: number;
  /** Agents mode's + menu, on the Agents row. */
  agentsNavAction?: ReactNode;
  isSidebarHidden: boolean;
  onToggleSidebar: () => void;
  onOpenProjectPicker: () => void;
  projects: PinnedProjectRow[];
  onSelectProject: (projectPath: string) => void;
  onCloseProject: (projectPath: string) => void;
  onUnpinProject?: (projectPath: string) => void;
  onReorderProjects?: (orderedPaths: string[]) => Promise<void> | void;
  onRenameProject?: (projectPath: string, newName: string) => Promise<void>;
  onTogglePinProject?: ToggleProjectPinHandler;
  onSelectProjectTab: (projectPath: string, tabSessionId: string) => void;
  isProjectDevServerRunning: (projectPath: string) => boolean;
  onStopDevServer?: (projectPath: string) => void | Promise<void>;
  onSwitchAccount: () => void;
}

export function HomeSidebar({
  activeNav,
  onGoHome,
  onGoWorkflows,
  onGoInbox,
  inboxUnreadCount,
  onGoAgents,
  agentsUnreadCount,
  agentsNavAction,
  listContent,
  isSidebarHidden,
  onToggleSidebar,
  onOpenProjectPicker,
  projects,
  onSelectProject,
  onCloseProject,
  onUnpinProject,
  onReorderProjects,
  onRenameProject,
  onTogglePinProject,
  onSelectProjectTab,
  isProjectDevServerRunning,
  onStopDevServer,
  onSwitchAccount,
}: HomeSidebarProps) {
  return (
    <WorkspaceSidebar
      key="sidebar-home"
      isHomeActive={activeNav === 'home'}
      activeNav={activeNav}
      onGoHome={onGoHome}
      onGoWorkflows={onGoWorkflows}
      onGoInbox={onGoInbox}
      inboxUnreadCount={inboxUnreadCount}
      onGoAgents={onGoAgents}
      agentsUnreadCount={agentsUnreadCount}
      agentsNavAction={agentsNavAction}
      listContent={listContent}
      onOpenProjectPicker={onOpenProjectPicker}
      isSidebarHidden={isSidebarHidden}
      onToggleSidebar={onToggleSidebar}
      showNavigationControls
      projects={projects}
      currentProjectPath={null}
      currentProjectName={null}
      onSelectProject={onSelectProject}
      onCloseProject={onCloseProject}
      onUnpinProject={onUnpinProject}
      onReorderProjects={onReorderProjects}
      onRenameProject={onRenameProject}
      onTogglePinProject={onTogglePinProject}
      onSelectProjectTab={onSelectProjectTab}
      terminalTabs={[]}
      activeTerminalTab={0}
      tabTitles={EMPTY_TAB_TITLES}
      attentionTabs={EMPTY_ATTENTION_TABS}
      maxTabs={5}
      onSelectTab={noop}
      onAddTab={noop}
      onCloseTab={noop}
      hasDevServer={false}
      isRestartingDevServer={false}
      devServerRunning={false}
      isProjectDevServerRunning={isProjectDevServerRunning}
      onStopDevServer={onStopDevServer}
      onSwitchAccount={onSwitchAccount}
    />
  );
}
