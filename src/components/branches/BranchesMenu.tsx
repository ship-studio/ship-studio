/**
 * Compact repository workflow for the workspace header.
 *
 * Pulling, branch switching, pull-request entry points, repository setup, and
 * navigation to the full repository pages live here. Destructive/advanced
 * branch and PR management remains in the full views.
 */

import { useCallback, useMemo } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { switchBranch, type BranchInfo, type PullRequestInfo } from '../../lib/branches';
import { queueBranchSwitch } from '../../lib/branchSwitchHandoff';
import { trackEvent } from '../../lib/analytics';
import { useOptionalToast } from '../../contexts/ToastContext';
import { remoteLabel, type ProjectGitHubStatus } from '../../lib/github';
import type { GitHubState } from '../../hooks/useIntegrationStatus';
import {
  AddIcon,
  ChevronIcon,
  ExternalLinkIcon,
  GitBranchEndIcon,
  GitBranchHorizontalIcon,
  GitBranchMainIcon,
  GitBranchMainNoneIcon,
  GitBranchMidIcon,
  GitHubIcon,
  PullIcon,
  PullRequestIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { Dropdown } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { Spinner } from '../primitives/Spinner';
import { TextButton } from '../primitives/TextButton';
import { GitHubButton } from './GitHubButton';

interface BranchesMenuProps {
  githubState: GitHubState;
  projectStatus: ProjectGitHubStatus | null;
  projectPath: string;
  projectName: string;
  currentBranch: string | null;
  branches: BranchInfo[];
  openPRs: PullRequestInfo[];
  isPulling: boolean;
  isBranchSwitching: boolean;
  isRepositoryViewActive: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onPullLatest: () => void;
  onBranchSwitch: (branch: string) => void;
  onViewBranches: () => void;
  onCreateBranch: () => void;
  onViewPRs: () => void;
  onStartPR: (branch: string) => void;
  onGitHubConnect: () => void;
  onGitHubStatusChange: () => void | Promise<void>;
  onModalClose?: () => void;
}

/** Renders the repository status menu and routes its branch, pull, and review actions. */
export function BranchesMenu({
  githubState,
  projectStatus,
  projectPath,
  projectName,
  currentBranch,
  branches,
  openPRs,
  isPulling,
  isBranchSwitching,
  isRepositoryViewActive,
  isOpen,
  onOpenChange,
  onPullLatest,
  onBranchSwitch,
  onViewBranches,
  onCreateBranch,
  onViewPRs,
  onStartPR,
  onGitHubConnect,
  onGitHubStatusChange,
  onModalClose,
}: BranchesMenuProps) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { showToast } = useOptionalToast();

  // `onBranchSwitch` only syncs the UI to a switch that already happened — the
  // checkout is ours to run. Without it the UI showed the target branch until
  // the next git poll snapped it back (issue #1012). Anything short of a clean
  // switch goes to the Branches view, which owns the uncommitted-changes,
  // worktree and paused-merge flows; it re-runs the switch and voices errors.
  const switchTo = async (branchName: string) => {
    close();
    const result = await switchBranch(projectPath, branchName, false).catch(() => null);
    if (result?.success) {
      onBranchSwitch(branchName);
      void trackEvent('branch_switched', { $screen_name: 'Workspace' });
      showToast(
        result.stashApplied
          ? `Switched to ${branchName} and restored your stashed changes`
          : `Switched to ${branchName}`,
        'success'
      );
      return;
    }
    queueBranchSwitch(projectPath, branchName);
    onViewBranches();
  };

  // Pulling and switching branches are plain git. A project on another forge
  // is ready for all of it without `gh` — it just can't have the GitHub-only
  // extras (the repo link, reviews), which are each conditional below.
  const repositoryReady =
    (githubState.cliStatus.installed &&
      githubState.cliStatus.authenticated &&
      projectStatus?.status === 'connected') ||
    projectStatus?.status === 'other-remote';

  /** "GitHub", "GitLab", or a bare host — never a guessed vendor. */
  const remoteName = remoteLabel(projectStatus) ?? 'GitHub';
  /** Gates the pull-request section: GitHub owns PRs, git doesn't. */
  const isGitHubRepo = projectStatus?.status === 'connected';

  const recentBranches = useMemo(
    () =>
      branches
        .filter((branch) => !branch.isCurrent && branch.name !== currentBranch)
        .sort((a, b) => b.lastCommitDate - a.lastCommitDate)
        .slice(0, 5),
    [branches, currentBranch]
  );

  const currentOpenPR = useMemo(
    () =>
      currentBranch
        ? (openPRs.find((pr) => pr.state === 'OPEN' && pr.headRef === currentBranch) ?? null)
        : null,
    [currentBranch, openPRs]
  );
  const isMainBranch = currentBranch === 'main' || currentBranch === 'master';
  const pullRequestBranch = useMemo(() => {
    if (currentBranch && !isMainBranch && !currentOpenPR) return currentBranch;
    return (
      recentBranches.find(
        (branch) =>
          !branch.isRemote &&
          branch.name !== 'main' &&
          branch.name !== 'master' &&
          !openPRs.some((pr) => pr.state === 'OPEN' && pr.headRef === branch.name)
      )?.name ?? null
    );
  }, [currentBranch, currentOpenPR, isMainBranch, openPRs, recentBranches]);

  const runAndClose = (action: () => void) => {
    close();
    action();
  };

  const branchIcon = (branchName: string, isLast: boolean, isOnlyCurrentBranch = false) => {
    if (branchName === 'main') {
      return isOnlyCurrentBranch ? (
        <GitBranchMainNoneIcon size={24} />
      ) : (
        <GitBranchMainIcon size={24} />
      );
    }
    if (branchName === 'master') {
      return <GitBranchMainIcon size={24} />;
    }
    return isLast ? <GitBranchEndIcon size={24} /> : <GitBranchMidIcon size={24} />;
  };

  return (
    <div className="branches-menu">
      <Dropdown
        portal
        align="right"
        open={isOpen}
        onOpenChange={onOpenChange}
        menuClassName="branches-menu-popover"
        trigger={(triggerProps) => (
          <MenuButton
            expanded={triggerProps['aria-expanded']}
            className={`branches-menu-trigger${isRepositoryViewActive ? ' is-active' : ''}`}
            data-education-id="branches-button"
            title="Branches"
            leftIcon={<GitBranchHorizontalIcon size={14} />}
            rightIcon={<ChevronIcon />}
            {...triggerProps}
          >
            <span className="toolbar-btn-label">Branches</span>
          </MenuButton>
        )}
      >
        {!repositoryReady ? (
          <div className="branches-menu-setup">
            <div className="branches-menu-section-title">GitHub</div>
            <p>Connect this project to GitHub to pull, switch branches, and manage reviews.</p>
            <GitHubButton
              githubState={githubState}
              projectStatus={projectStatus}
              projectPath={projectPath}
              projectName={projectName}
              onStatusChange={onGitHubStatusChange}
              onGitHubConnect={onGitHubConnect}
              onModalClose={onModalClose}
            />
          </div>
        ) : (
          <>
            <div className="branches-menu-header">
              <h3 id="branches-menu-title">Branches</h3>
              {projectStatus.github_url && (
                <TextButton
                  className="branches-menu-repository-button"
                  onClick={() => {
                    close();
                    void openUrl(projectStatus.github_url!);
                  }}
                  leftIcon={<GitHubIcon size={14} />}
                  rightIcon={<ExternalLinkIcon size={12} />}
                >
                  Open in GitHub
                </TextButton>
              )}
            </div>

            <section className="branches-menu-section" aria-labelledby="branches-menu-sync">
              <div className="branches-menu-section-title" id="branches-menu-sync">
                Sync
              </div>
              <Button
                width="fill"
                variant="default"
                onClick={onPullLatest}
                disabled={isPulling}
                leftIcon={isPulling ? <Spinner size="sm" /> : <PullIcon size={14} />}
              >
                {isPulling ? 'Pulling latest...' : `Pull latest from ${remoteName}`}
              </Button>
            </section>

            <section className="branches-menu-section" aria-labelledby="branches-menu-branches">
              <div className="branches-menu-section-heading">
                <div className="branches-menu-section-heading-main">
                  <div className="branches-menu-section-title" id="branches-menu-branches">
                    Branches
                  </div>
                  <span className="branches-menu-count" aria-label={`${branches.length} branches`}>
                    {branches.length}
                  </span>
                </div>
                <TextButton
                  className="branches-menu-section-view-all"
                  onClick={() => runAndClose(onViewBranches)}
                >
                  View all branches
                </TextButton>
              </div>
              {currentBranch && (
                <button
                  type="button"
                  className="branches-menu-row branches-menu-branch-row is-current"
                  disabled
                >
                  <span className="branches-menu-row-icon">
                    {branchIcon(
                      currentBranch,
                      recentBranches.length === 0,
                      recentBranches.length === 0
                    )}
                  </span>
                  <span className="branches-menu-row-content">
                    <span className="branches-menu-row-label">{currentBranch}</span>
                    <span className="branches-menu-row-meta">Current</span>
                  </span>
                </button>
              )}
              {recentBranches.map((branch, index) => (
                <button
                  type="button"
                  className="branches-menu-row branches-menu-branch-row"
                  key={`${branch.isRemote ? 'remote' : 'local'}:${branch.name}`}
                  disabled={isBranchSwitching}
                  onClick={() => void switchTo(branch.name)}
                >
                  <span className="branches-menu-row-icon">
                    {branchIcon(branch.name, index === recentBranches.length - 1)}
                  </span>
                  <span className="branches-menu-row-content">
                    <span className="branches-menu-row-label">{branch.name}</span>
                    {branch.isRemote && <span className="branches-menu-row-meta">Remote</span>}
                  </span>
                </button>
              ))}
              {recentBranches.length === 0 && (
                <div className="branches-menu-empty">No other branches yet.</div>
              )}
              <Button
                width="fill"
                variant="ghost"
                className="branches-menu-action"
                onClick={() => runAndClose(onCreateBranch)}
              >
                <span className="branches-menu-action-content">
                  <span className="branches-menu-action-main">
                    <span className="branches-menu-action-icon">
                      <AddIcon size={14} />
                    </span>
                    <span className="branches-menu-row-label">New branch</span>
                  </span>
                </span>
              </Button>
            </section>

            {/* Pull requests are the one thing here that is GitHub's, not
                git's — `gh pr create` against a GitLab repo cannot work, so a
                non-GitHub project gets the rest of the menu without it. */}
            {isGitHubRepo && (
              <section className="branches-menu-section" aria-labelledby="branches-menu-prs">
                <div className="branches-menu-section-heading">
                  <div className="branches-menu-section-heading-main">
                    <div className="branches-menu-section-title" id="branches-menu-prs">
                      Pull requests
                    </div>
                    <span className="branches-menu-count" aria-label={`${openPRs.length} open`}>
                      {openPRs.length}
                    </span>
                  </div>
                  <TextButton
                    className="branches-menu-section-view-all"
                    onClick={() => runAndClose(onViewPRs)}
                  >
                    View all pull requests
                  </TextButton>
                </div>
                {currentOpenPR && (
                  <button
                    type="button"
                    className="branches-menu-row branches-menu-pr-row"
                    onClick={() => {
                      close();
                      void openUrl(currentOpenPR.url);
                    }}
                  >
                    <span className="branches-menu-pr-leading-icon">
                      <PullRequestIcon size={14} />
                    </span>
                    <span className="branches-menu-pr-content">
                      <span className="branches-menu-pr-main">
                        <span className="branches-menu-pr-inline">
                          <span className="branches-menu-pr-number">#{currentOpenPR.number}</span>
                          {currentOpenPR.title}
                        </span>
                      </span>
                      <span className="branches-menu-pr-meta">
                        <span className="branches-menu-pr-branches">
                          <span className="branches-menu-pr-branch">{currentOpenPR.headRef}</span>
                          <span aria-hidden="true">→</span>
                          <span className="branches-menu-pr-branch">{currentOpenPR.baseRef}</span>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="branches-menu-pr-author">{currentOpenPR.author}</span>
                      </span>
                    </span>
                  </button>
                )}
                <Button
                  width="fill"
                  variant="ghost"
                  className="branches-menu-action"
                  disabled={!pullRequestBranch}
                  title={
                    pullRequestBranch
                      ? `Create a pull request from ${pullRequestBranch}`
                      : 'Create a feature branch first'
                  }
                  onClick={() =>
                    pullRequestBranch && runAndClose(() => onStartPR(pullRequestBranch))
                  }
                >
                  <span className="branches-menu-action-content">
                    <span className="branches-menu-action-main">
                      <span className="branches-menu-action-icon">
                        <AddIcon size={14} />
                      </span>
                      <span className="branches-menu-row-label">New pull request</span>
                    </span>
                    {pullRequestBranch && (
                      <span className="branches-menu-row-meta">{pullRequestBranch}</span>
                    )}
                  </span>
                </Button>
              </section>
            )}
          </>
        )}
      </Dropdown>
    </div>
  );
}
