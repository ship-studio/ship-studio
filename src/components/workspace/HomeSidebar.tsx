/**
 * The workspace sidebar as it appears on the home-level screens (Projects,
 * Workflows, Inbox), where there is no active project and no terminal tabs.
 *
 * Extracted so the home screens share one configuration of `WorkspaceSidebar`
 * instead of each repeating its twenty inert props.
 *
 * @module components/workspace/HomeSidebar
 */

import { WorkspaceSidebar } from './WorkspaceSidebar';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';

const EMPTY_TAB_TITLES = new Map<number, string>();
const EMPTY_ATTENTION_TABS = new Set<number>();
const noop = () => {};

interface HomeSidebarProps {
  /** Which home destination is showing, so the nav row can mark it current. */
  activeNav: 'home' | 'workflows' | 'inbox';
  onGoHome: () => void;
  onGoWorkflows: () => void;
  onGoInbox: () => void;
  inboxUnreadCount: number;
  isSidebarHidden: boolean;
  onToggleSidebar: () => void;
  onOpenProjectPicker: () => void;
  projects: PinnedProjectRow[];
  onSelectProject: (projectPath: string) => void;
  onCloseProject: (projectPath: string) => void;
  onSelectProjectTab: (projectPath: string, tabSessionId: string) => void;
  isProjectDevServerRunning: (projectPath: string) => boolean;
  onSwitchAccount: () => void;
}

export function HomeSidebar({
  activeNav,
  onGoHome,
  onGoWorkflows,
  onGoInbox,
  inboxUnreadCount,
  isSidebarHidden,
  onToggleSidebar,
  onOpenProjectPicker,
  projects,
  onSelectProject,
  onCloseProject,
  onSelectProjectTab,
  isProjectDevServerRunning,
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
      onOpenProjectPicker={onOpenProjectPicker}
      isSidebarHidden={isSidebarHidden}
      onToggleSidebar={onToggleSidebar}
      showNavigationControls
      projects={projects}
      currentProjectPath={null}
      currentProjectName={null}
      onSelectProject={onSelectProject}
      onCloseProject={onCloseProject}
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
      onSwitchAccount={onSwitchAccount}
    />
  );
}
