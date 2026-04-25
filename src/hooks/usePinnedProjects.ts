/**
 * Hook that powers the project rail.
 *
 * Joins three sources of truth into a single render-friendly list:
 *
 * 1. The pinned-projects list from `pins.json` (persisted on disk).
 * 2. The live `SessionRegistry` (frontend, in-memory) for status / unread.
 * 3. The set of all known projects (so the rail can show display names
 *    and thumbnails without each pin needing to fetch them separately).
 *
 * The rail rerenders when:
 * - The user pins / unpins / reorders (we own those mutations).
 * - The session registry notifies us of a status / unread change.
 * - The user opens or closes a project (changes which pin is "current").
 *
 * Rendering is intentionally cheap: we keep the joined list in `useState`
 * and recompute only when one of the sources changes.
 *
 * @module hooks/usePinnedProjects
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listPinnedProjects,
  pinProject as pinProjectApi,
  unpinProject as unpinProjectApi,
  reorderPins as reorderPinsApi,
} from '../lib/pins';
import {
  sessionRegistry,
  type SessionSnapshot,
  type SessionStatus,
  type AgentActivityStatus,
} from '../lib/sessionRegistry';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';
import { getProjectId } from '../lib/projectIdentity';

/** A pinned project as the rail wants to render it. */
export interface PinnedProjectRow {
  /** Absolute project path (the stable identifier). */
  projectPath: string;
  /** Final segment of the path, used as a display name when no project
   *  metadata is loaded. The rail can override with a real name. */
  fallbackName: string;
  /** Live session status. `'inactive'` means pinned but not currently
   *  registered in the session registry (e.g. on app launch before resume). */
  status: SessionStatus | 'inactive';
  /** Live agent activity (idle/thinking/waiting). `'idle'` if no session. */
  agentStatus: AgentActivityStatus;
  /** Unread badge count. Always 0 if no session. */
  unreadCount: number;
  /** Last known memory usage in bytes. 0 if no session. */
  memoryBytes: number;
  /** Whether this pin matches the currently focused project (drives the
   *  "you are here" highlight). */
  isCurrent: boolean;
}

export interface UsePinnedProjectsReturn {
  /** Ordered rows for the rail. */
  rows: PinnedProjectRow[];
  /** Set of pinned project paths (for O(1) "is this pinned?" checks). */
  pinnedSet: ReadonlySet<string>;
  /** True while the initial fetch is in flight. */
  isLoading: boolean;
  /** True when at least one pin exists. */
  hasPins: boolean;
  /** Add a project to the rail. Idempotent. */
  pin: (projectPath: string) => Promise<void>;
  /** Remove a project from the rail. Idempotent. */
  unpin: (projectPath: string) => Promise<void>;
  /** Reorder the rail. The new order must contain exactly the existing pins. */
  reorder: (orderedPaths: string[]) => Promise<void>;
  /** Refetch the persisted pin list (e.g. after an external change). */
  refresh: () => Promise<void>;
}

/** Final-segment helper. Used as a display name fallback for the tooltip. */
function lastPathSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Build the rail rows by joining pinned paths with session snapshots.
 * Pure function — given the same inputs, returns equivalent output.
 */
function buildRows(
  pinnedPaths: ReadonlyArray<string>,
  snapshots: ReadonlyArray<SessionSnapshot>,
  currentProjectPath: string | null
): PinnedProjectRow[] {
  const snapshotByPath = new Map(snapshots.map((s) => [s.projectPath, s]));
  return pinnedPaths.map((projectPath) => {
    const snap = snapshotByPath.get(projectPath);
    return {
      projectPath,
      fallbackName: lastPathSegment(projectPath),
      status: snap?.status ?? 'inactive',
      agentStatus: snap?.lastAgentStatus ?? 'idle',
      unreadCount: snap?.unreadCount ?? 0,
      memoryBytes: snap?.memoryBytes ?? 0,
      isCurrent: currentProjectPath === projectPath,
    };
  });
}

/**
 * Powers the project rail. Pass `currentProjectPath` so the rail can
 * highlight the active pin; pass `null` when no project is open.
 */
export function usePinnedProjects(currentProjectPath: string | null): UsePinnedProjectsReturn {
  const [pinnedPaths, setPinnedPaths] = useState<string[]>([]);
  const [snapshots, setSnapshots] = useState<SessionSnapshot[]>(() =>
    sessionRegistry.snapshotAll()
  );
  const [isLoading, setIsLoading] = useState(true);

  // Initial fetch + subscribe to backend pin changes. There's no event from
  // the backend today (pins.json mutations come only from this app), so we
  // just refetch on demand via `refresh()`.
  const refresh = useCallback(async () => {
    try {
      const list = await listPinnedProjects();
      setPinnedPaths(list);
    } catch (err) {
      logger.warn('[usePinnedProjects] Failed to list pinned projects', { error: String(err) });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (!cancelled) setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Subscribe to the session registry so the rail re-renders on
  // status/unread/memory changes.
  useEffect(() => {
    const unsubscribe = sessionRegistry.subscribe((_changedPath, allSnapshots) => {
      setSnapshots([...allSnapshots]);
    });
    return unsubscribe;
  }, []);

  const pin = useCallback(async (projectPath: string) => {
    try {
      const updated = await pinProjectApi(projectPath);
      setPinnedPaths(updated);
      void trackEvent('project_pinned', {
        project_id: getProjectId(projectPath),
        project_name: projectPath.split('/').pop() ?? projectPath,
        pin_count: updated.length,
      });
    } catch (err) {
      logger.error('[usePinnedProjects] Failed to pin project', {
        projectPath,
        error: String(err),
      });
      throw err;
    }
  }, []);

  const unpin = useCallback(async (projectPath: string) => {
    try {
      const updated = await unpinProjectApi(projectPath);
      setPinnedPaths(updated);
      void trackEvent('project_unpinned', {
        project_id: getProjectId(projectPath),
        project_name: projectPath.split('/').pop() ?? projectPath,
        pin_count: updated.length,
      });
    } catch (err) {
      logger.error('[usePinnedProjects] Failed to unpin project', {
        projectPath,
        error: String(err),
      });
      throw err;
    }
  }, []);

  const reorder = useCallback(async (orderedPaths: string[]) => {
    try {
      const updated = await reorderPinsApi(orderedPaths);
      setPinnedPaths(updated);
      void trackEvent('pins_reordered', { pin_count: updated.length });
    } catch (err) {
      logger.error('[usePinnedProjects] Failed to reorder pins', { error: String(err) });
      throw err;
    }
  }, []);

  const rows = useMemo(
    () => buildRows(pinnedPaths, snapshots, currentProjectPath),
    [pinnedPaths, snapshots, currentProjectPath]
  );

  const pinnedSet = useMemo(() => new Set(pinnedPaths), [pinnedPaths]);

  return {
    rows,
    pinnedSet,
    isLoading,
    hasPins: pinnedPaths.length > 0,
    pin,
    unpin,
    reorder,
    refresh,
  };
}
