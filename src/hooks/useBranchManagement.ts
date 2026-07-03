/**
 * Hook for git branch state and operations.
 *
 * Manages: current branch, branch list, pull requests, uncommitted changes,
 * branch switching, conflict resolution, periodic git status polling,
 * and publish error handling.
 *
 * @module hooks/useBranchManagement
 */

import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import {
  BranchInfo,
  PullRequestInfo,
  listBranches,
  listPullRequests,
  getCurrentBranch,
  switchBranch,
  pullAndMerge,
} from '../lib/branches';
import { getChangedFiles, ChangedFile } from '../lib/git';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../lib/logger';
import { asCommandError, formatCommandError } from '../lib/errors';
import { trackEvent } from '../lib/analytics';
import type { PreviewHandle } from '../components/preview/Preview';
import type { HealthTabPanelRef } from '../components/code/HealthTabPanel';
import { usePolling } from './usePolling';
import type { Project } from '../lib/project';

export interface UseBranchManagementParams {
  currentProject: Project | null;
  previewRef: RefObject<PreviewHandle | null>;
  healthPanelRef: RefObject<HealthTabPanelRef | null>;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  fetchBranchInfoExternal?: (projectPath: string) => Promise<void>;
}

export function useBranchManagement({
  currentProject,
  previewRef,
  healthPanelRef,
  showToast,
}: UseBranchManagementParams) {
  // Branch management state
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [openPRs, setOpenPRs] = useState<PullRequestInfo[]>([]);
  const [hasUncommittedChanges, setHasUncommittedChanges] = useState(false);
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [showSubmitReview, setShowSubmitReview] = useState<string | null>(null);
  const [isBranchSwitching, setIsBranchSwitching] = useState(false);
  const [gitError, setGitError] = useState<{
    errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic';
    message: string;
    branchName: string;
  } | null>(null);

  // Conflict resolution modal state
  const [showConflictResolution, setShowConflictResolution] = useState(false);

  // Fetch branch info for a project
  const fetchBranchInfo = useCallback(async (projectPath: string) => {
    try {
      const [branch, branchList] = await Promise.all([
        getCurrentBranch(projectPath).catch(() => null),
        listBranches(projectPath).catch(() => []),
      ]);
      setCurrentBranch(branch);
      setBranches(branchList);

      // Fetch open PRs for branch status display (non-blocking)
      void listPullRequests(projectPath)
        .then((prs) => setOpenPRs(prs.filter((pr) => pr.state === 'OPEN')))
        .catch(() => setOpenPRs([]));

      // Check for uncommitted changes using the backend
      void invoke<boolean>('check_git_has_changes', { projectPath })
        .then((hasChanges) => setHasUncommittedChanges(hasChanges))
        .catch(() => setHasUncommittedChanges(false));
    } catch (e) {
      logger.error('Failed to fetch branch info', { error: e });
      setCurrentBranch(null);
      setBranches([]);
    }
  }, []);

  // Use a ref for currentBranch in the polling callback to avoid recreating the
  // interval every time the branch changes (which tears down and restarts polling).
  const currentBranchRef = useRef(currentBranch);
  currentBranchRef.current = currentBranch;

  // Track previous hasChanges state to detect external pushes (agent/CLI)
  const hadChangesRef = useRef(false);

  // Track branch-switch timeouts so they can be cancelled on unmount or re-switch
  const branchSwitchTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Check git status (called periodically to sync with CLI changes)
  const checkGitStatus = useCallback(
    async (projectPath: string) => {
      try {
        const [branch, hasChanges, files] = await Promise.all([
          getCurrentBranch(projectPath).catch(() => null),
          invoke<boolean>('check_git_has_changes', { projectPath }).catch(() => false),
          getChangedFiles(projectPath).catch(() => []),
        ]);

        // Update branch if changed (e.g., user switched via CLI/agent)
        if (branch && branch !== currentBranchRef.current) {
          setCurrentBranch(branch);
          void trackEvent('branch_switched', {
            source: 'external',
            from_branch: currentBranchRef.current,
            to_branch: branch,
            $screen_name: 'Workspace',
          });
          // Refresh full branch list when branch changes
          void listBranches(projectPath)
            .then(setBranches)
            .catch((err) => logger.warn('Failed to refresh branch list', { error: err }));
        }

        // Detect external push: had changes before, now synced, same branch
        if (hadChangesRef.current && !hasChanges && branch === currentBranchRef.current) {
          void trackEvent('branch_published', {
            source: 'external',
            branch: branch,
            $screen_name: 'Workspace',
          });
        }
        hadChangesRef.current = hasChanges;

        setHasUncommittedChanges(hasChanges);
        setChangedFiles(files);
      } catch (e) {
        // Silently ignore errors during periodic checks
        logger.warn('Error checking git status', { error: e });
      }
    },
    [] // stable — reads currentBranch from ref
  );

  // Track tab visibility so polling pauses when the window is hidden
  const [isTabVisible, setIsTabVisible] = useState(() =>
    typeof document === 'undefined' ? true : !document.hidden
  );
  useEffect(() => {
    const handler = () => setIsTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Periodically check git status when a project is open and window is focused
  const projectPath = currentProject?.path ?? null;
  usePolling(
    async () => {
      if (projectPath) {
        await checkGitStatus(projectPath);
      }
    },
    {
      intervalMs: 10000,
      enabled: !!projectPath && isTabVisible,
      name: 'branchManagement.checkGitStatus',
    }
  );

  // Clear branch-switch timers on unmount
  useEffect(() => {
    return () => {
      branchSwitchTimers.current.forEach(clearTimeout);
    };
  }, []);

  // Handle branch switch
  const handleBranchSwitch = useCallback(
    async (branchName: string) => {
      setIsBranchSwitching(true);
      setCurrentBranch(branchName);
      // Reset uncommitted changes immediately - will be updated by fetchBranchInfo
      setHasUncommittedChanges(false);
      if (currentProject) {
        await fetchBranchInfo(currentProject.path);
        // Re-assert: fetchBranchInfo may have set stale cached branch data
        setCurrentBranch(branchName);
      }
      // Clear any pending timers from a previous branch switch
      branchSwitchTimers.current.forEach(clearTimeout);
      // Refresh preview after Next.js has time to detect file changes and rebuild
      branchSwitchTimers.current = [
        setTimeout(() => previewRef.current?.refresh(), 300),
        setTimeout(() => {
          previewRef.current?.refresh();
          setIsBranchSwitching(false);
        }, 2500),
        // Run health checks after branch switch (give files time to settle)
        setTimeout(() => {
          void healthPanelRef.current?.refreshScripts();
          void healthPanelRef.current?.runAllChecks();
        }, 1000),
      ];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- previewRef and healthPanelRef are stable refs
    [currentProject, fetchBranchInfo]
  );

  // Handle publish error
  const handlePublishError = useCallback(
    (error: string, errorType: 'push_rejected' | 'auth_error' | 'merge_conflict' | 'generic') => {
      if (currentBranch) {
        setGitError({
          errorType,
          message: error,
          branchName: currentBranch,
        });
      }
    },
    [currentBranch]
  );

  // Handle opening conflict resolution modal
  // For PR conflicts: switch to head branch, merge base branch, then show UI
  const handleResolveConflicts = useCallback(
    async (headBranch?: string, baseBranch?: string) => {
      setGitError(null);

      if (!currentProject) return;

      // If we have branch info, we're resolving PR conflicts
      if (headBranch && baseBranch) {
        try {
          showToast('Preparing to resolve conflicts...', 'success');

          // Switch to the PR's head branch
          const switchResult = await switchBranch(currentProject.path, headBranch, true);
          if (!switchResult.success) {
            showToast(switchResult.error || 'Failed to switch branch', 'error');
            return;
          }

          // Update current branch state
          setCurrentBranch(headBranch);

          // Merge the base branch to create conflicts locally
          try {
            await pullAndMerge(currentProject.path, baseBranch);
            // If merge succeeds without conflicts, we're done
            showToast('Branch is up to date, no conflicts!', 'success');
            void fetchBranchInfo(currentProject.path);
            return;
          } catch (e) {
            const errorMsg = formatCommandError(asCommandError(e));
            if (errorMsg.includes('MERGE_CONFLICT')) {
              // Conflicts created locally - show the UI
              setShowConflictResolution(true);
            } else {
              showToast(`Failed to merge: ${errorMsg}`, 'error');
            }
          }
        } catch (e) {
          const errorMsg = formatCommandError(asCommandError(e));
          showToast(`Error: ${errorMsg}`, 'error');
        }
      } else {
        // Direct conflict resolution (e.g., from GitErrorHandler after a failed push)
        setShowConflictResolution(true);
      }
    },
    [currentProject, showToast, fetchBranchInfo]
  );

  // Handle conflict resolution completed
  const handleConflictsResolved = useCallback(() => {
    setShowConflictResolution(false);
    if (currentProject) {
      void fetchBranchInfo(currentProject.path);
    }
  }, [currentProject, fetchBranchInfo]);

  // Clear all branch state (used when navigating back to projects)
  const clearBranchState = useCallback(() => {
    setCurrentBranch(null);
    setBranches([]);
    setHasUncommittedChanges(false);
    setChangedFiles([]);
  }, []);

  return {
    // State
    currentBranch,
    setCurrentBranch,
    branches,
    openPRs,
    hasUncommittedChanges,
    changedFiles,
    showSubmitReview,
    setShowSubmitReview,
    isBranchSwitching,
    gitError,
    setGitError,
    showConflictResolution,
    setShowConflictResolution,

    // Functions
    fetchBranchInfo,
    checkGitStatus,
    handleBranchSwitch,
    handlePublishError,
    handleResolveConflicts,
    handleConflictsResolved,
    clearBranchState,
  };
}
