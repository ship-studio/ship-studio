/**
 * Renders the top-level application views once AppContents has assembled the
 * domain props and callbacks. Keeping the view branches here leaves App.tsx
 * focused on orchestration rather than markup.
 */

import type { ComponentProps, ReactNode } from 'react';
import { AccountSelectScreen } from './accounts/AccountSelectScreen';
import { ProjectsView } from './dashboard/ProjectsView';
import { MonorepoPickerModal } from './dashboard/MonorepoPickerModal';
import { BootLoadingScreen } from './BootLoadingScreen';
import { ThumbnailConsentModal } from './preview/ThumbnailConsentModal';
import { ToastList } from './primitives/ToastList';
import { OnboardingRouter } from './setup';
import { HomeSidebar } from './workspace/HomeSidebar';
import { StandingWorkView } from './workspace/StandingWorkView';
import { AgentsView } from './agents/AgentsView';
import { WorkspaceNavigation, WorkspaceTitlebar } from './workspace/WorkspaceHeader';
import { WorkspaceSidebar } from './workspace/WorkspaceSidebar';
import { WorkspaceView } from './workspace/WorkspaceView';
import { Spinner } from './primitives/Spinner';
import type { Project, WorkspaceInfo } from '../lib/project';
import type { AppView } from '../lib/types';
import type { WorkspacePick } from './dashboard/MonorepoPickerModal';

type AccountSelectProps = ComponentProps<typeof AccountSelectScreen>;
type HomeSidebarProps = Omit<ComponentProps<typeof HomeSidebar>, 'activeNav'>;
type ProjectsViewProps = ComponentProps<typeof ProjectsView>;
type WorkspaceViewProps = ComponentProps<typeof WorkspaceView>;
type ThumbnailConsentProps = ComponentProps<typeof ThumbnailConsentModal>;
type ToastListProps = ComponentProps<typeof ToastList>;

interface PendingMonorepoPick {
  project: Project;
  workspaces: WorkspaceInfo[];
  selectedPick: WorkspacePick | null;
}

export interface AppViewRouterProps {
  view: AppView;
  isCompact: boolean;
  compactWorkspaceToolbarEnabled: boolean;
  bootProgress: ComponentProps<typeof BootLoadingScreen>['progress'];
  onOnboardingComplete: () => void;
  accountSelectProps: AccountSelectProps;
  homeSidebarProps: HomeSidebarProps;
  projectsViewProps: ProjectsViewProps;
  workspaceViewProps: Omit<WorkspaceViewProps, 'currentProject'> & {
    currentProject: Project | null;
  };
  currentProject: Project | null;
  pendingMonorepoPick: PendingMonorepoPick | null;
  onSelectMonorepoPick: (pick: WorkspacePick) => void;
  onConfirmMonorepoPick: () => void;
  onCancelMonorepoPick: () => void;
  thumbnailConsentProps: ThumbnailConsentProps;
  toasts: ToastListProps['toasts'];
  onDismissToast: ToastListProps['onDismiss'];
  quitConfirmModal: ReactNode;
}

const EMPTY_TAB_TITLES = new Map<number, string>();
const EMPTY_ATTENTION_TABS = new Set<number>();
const noop = () => {};

export function AppViewRouter({
  view,
  isCompact,
  compactWorkspaceToolbarEnabled,
  bootProgress,
  onOnboardingComplete,
  accountSelectProps,
  homeSidebarProps,
  projectsViewProps,
  workspaceViewProps,
  currentProject,
  pendingMonorepoPick,
  onSelectMonorepoPick,
  onConfirmMonorepoPick,
  onCancelMonorepoPick,
  thumbnailConsentProps,
  toasts,
  onDismissToast,
  quitConfirmModal,
}: AppViewRouterProps) {
  if (view === 'loading') {
    return (
      <>
        <BootLoadingScreen progress={bootProgress} />
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'onboarding') {
    return (
      <>
        <div className="app">
          <OnboardingRouter onComplete={onOnboardingComplete} />
        </div>
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'account-select') {
    return (
      <>
        <div className="app">
          <AccountSelectScreen {...accountSelectProps} />
        </div>
        <ToastList toasts={toasts} onDismiss={onDismissToast} />
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'projects') {
    return (
      <>
        <div className="app workspace workspace-home">
          <div
            className={`projects-with-rail${isCompact ? ' is-compact' : ''}`}
            key="view-projects"
          >
            {!isCompact && <HomeSidebar {...homeSidebarProps} activeNav="home" />}
            <ProjectsView {...projectsViewProps} />
          </div>
        </div>
        {pendingMonorepoPick && (
          <MonorepoPickerModal
            projectName={pendingMonorepoPick.project.name}
            workspaces={pendingMonorepoPick.workspaces}
            selectedPick={pendingMonorepoPick.selectedPick}
            onSelect={onSelectMonorepoPick}
            onConfirm={onConfirmMonorepoPick}
            onCancel={onCancelMonorepoPick}
          />
        )}
        <ToastList toasts={toasts} onDismiss={onDismissToast} />
        {quitConfirmModal}
      </>
    );
  }

  // Agents takes over the whole window: its own sidebar is the agent list.
  if (view === 'agents') {
    return (
      <>
        <AgentsView isCompact={isCompact} sidebarProps={homeSidebarProps} />
        <ToastList toasts={toasts} onDismiss={onDismissToast} />
        {quitConfirmModal}
      </>
    );
  }

  // Workflows, Inbox and Team: home-level screens sharing the home sidebar.
  if (view === 'workflows' || view === 'inbox') {
    return (
      <>
        <StandingWorkView
          view={view}
          isCompact={isCompact}
          sidebarProps={homeSidebarProps}
          currentProjectPath={currentProject?.path ?? null}
          onOpenProject={projectsViewProps.onSelectProject}
        />
        <ToastList toasts={toasts} onDismiss={onDismissToast} />
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'project-loading') {
    const showCompactWorkspaceTitlebar = !isCompact && compactWorkspaceToolbarEnabled;
    return (
      <>
        <div
          className={`app workspace workspace-home${
            showCompactWorkspaceTitlebar ? ' has-workspace-titlebar workspace--compact-toolbar' : ''
          }`}
        >
          {showCompactWorkspaceTitlebar && (
            <WorkspaceTitlebar>
              <WorkspaceNavigation
                onGoHome={homeSidebarProps.onGoHome}
                isSidebarHidden={homeSidebarProps.isSidebarHidden}
                onToggleSidebar={homeSidebarProps.onToggleSidebar}
              />
            </WorkspaceTitlebar>
          )}
          <div className="projects-with-rail" key="view-project-loading">
            <WorkspaceSidebar
              {...homeSidebarProps}
              key="sidebar-project-loading"
              isHomeActive={false}
              showNavigationControls={!compactWorkspaceToolbarEnabled}
              currentProjectPath={currentProject?.path ?? null}
              currentProjectName={currentProject?.name ?? null}
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
            />
            <div className="project-loading-body">
              <Spinner size="lg" />
              <p>Opening {currentProject?.name}...</p>
            </div>
          </div>
        </div>
        {quitConfirmModal}
      </>
    );
  }

  const project = workspaceViewProps.currentProject;
  if (!project) {
    return (
      <>
        <div className="app loading">
          <Spinner size="lg" />
        </div>
        {quitConfirmModal}
      </>
    );
  }

  return (
    <>
      <WorkspaceView {...workspaceViewProps} currentProject={project} />
      <ThumbnailConsentModal {...thumbnailConsentProps} />
      {quitConfirmModal}
    </>
  );
}
