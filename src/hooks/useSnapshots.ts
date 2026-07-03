/**
 * Snapshots hook — wires the per-turn undo/redo backend to a React component.
 *
 * Starts the watcher when a project becomes active and stops it on cleanup or
 * when the project changes. Polls status (cheap — just an in-memory state
 * read on the backend) so the toolbar buttons enable/disable as the user
 * edits. Exposes stable `undo` / `redo` callbacks.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as snapshots from '../lib/snapshots';
import { logger } from '../lib/logger';
import { asCommandError, formatCommandError } from '../lib/errors';
import { usePolling } from './usePolling';
import type { ToastType } from './useToasts';

type ShowToast = (message: string, type?: ToastType) => void;

interface UseSnapshotsResult {
  canUndo: boolean;
  canRedo: boolean;
  /** Whether the project is a git repo (snapshots require one). */
  isGitRepo: boolean;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const EMPTY_STATUS: snapshots.SnapshotStatus = {
  watching: false,
  can_undo: false,
  can_redo: false,
  is_git_repo: false,
  history_size: 0,
  cursor: 0,
  files_changed: [],
};

/**
 * Build a short toast summary like "Undid 3 files: App.tsx, Preview.tsx +1 more".
 * Returns null when the snapshot transition didn't actually change any files.
 */
function summarize(verb: 'Undid' | 'Redid', files: string[]): string | null {
  if (files.length === 0) return null;
  const basenames = files.map((f) => f.split('/').pop() ?? f);
  const shown = basenames.slice(0, 2).join(', ');
  const extra = basenames.length > 2 ? ` +${basenames.length - 2} more` : '';
  const noun = files.length === 1 ? 'file' : 'files';
  return `${verb} ${files.length} ${noun}: ${shown}${extra}`;
}

export function useSnapshots(
  projectPath: string | null | undefined,
  showToast: ShowToast
): UseSnapshotsResult {
  const [status, setStatus] = useState<snapshots.SnapshotStatus>(EMPTY_STATUS);
  const prevPathRef = useRef<string | null>(null);

  // Start the watcher on project change. We deliberately do NOT stop it in
  // the effect cleanup — under React StrictMode that races the immediate
  // re-mount and tears the history down. Instead we stop the *previous*
  // project's watcher when the active project changes, which is the only
  // moment we actually want to free the watcher.
  useEffect(() => {
    if (!projectPath) return;
    const prev = prevPathRef.current;
    prevPathRef.current = projectPath;
    if (prev && prev !== projectPath) {
      void snapshots.stopWatching(prev).catch(() => {});
    }
    void snapshots
      .startWatching(projectPath)
      .then(() => snapshots.getStatus(projectPath))
      .then(setStatus)
      .catch((err) => {
        logger.warn('snapshots.startWatching failed', { projectPath, err: String(err) });
      });
  }, [projectPath]);

  // Poll status so the toolbar reflects new captures debounced from the
  // backend. Cheap call; the backend just reads an in-memory map.
  usePolling(
    async () => {
      if (!projectPath) return;
      const next = await snapshots.getStatus(projectPath);
      setStatus(next);
    },
    { intervalMs: 1000, enabled: Boolean(projectPath), name: 'snapshots' }
  );

  const undo = useCallback(async () => {
    if (!projectPath) return;
    try {
      const next = await snapshots.undo(projectPath);
      setStatus(next);
      const summary = summarize('Undid', next.files_changed);
      showToast(summary ?? 'Nothing to undo', summary ? 'success' : 'info');
    } catch (err) {
      const msg = formatCommandError(asCommandError(err));
      showToast(`Undo failed: ${msg}`, 'error');
    }
  }, [projectPath, showToast]);

  const redo = useCallback(async () => {
    if (!projectPath) return;
    try {
      const next = await snapshots.redo(projectPath);
      setStatus(next);
      const summary = summarize('Redid', next.files_changed);
      showToast(summary ?? 'Nothing to redo', summary ? 'success' : 'info');
    } catch (err) {
      const msg = formatCommandError(asCommandError(err));
      showToast(`Redo failed: ${msg}`, 'error');
    }
  }, [projectPath, showToast]);

  return {
    canUndo: status.can_undo,
    canRedo: status.can_redo,
    isGitRepo: status.is_git_repo,
    undo,
    redo,
  };
}
