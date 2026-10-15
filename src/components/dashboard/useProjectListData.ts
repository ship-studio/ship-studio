import { useCallback, useEffect, useRef, useState } from 'react';
import { getDashboardProjects, getProjectThumbnail } from '../../lib/project';
import { listFolders, getFiledProjectPaths } from '../../lib/folders';
import type { DashboardProject } from '../../lib/project';
import type { FolderInfo } from '../../lib/folders';
import {
  asCommandError,
  formatCommandError,
  isExpectedCommandError,
  isProjectFolderGoneError,
} from '../../lib/errors';
import { TimeoutError, withTimeout } from '../../lib/withTimeout';
import { logger } from '../../lib/logger';
import { classifyThumbnailLoadFailure } from './projectThumbnailErrors';

/** Dashboard project with loaded thumbnail data */
export interface ProjectWithThumbnail extends DashboardProject {
  /** Base64-encoded thumbnail image data */
  thumbnailData: string | null;
}

/** How long either half of a dashboard load may take before it is given up on.
 *  Comfortably above the backend's own 25s ceiling, so a backend refusal still
 *  reaches the user in the backend's words and this only fires when the IPC
 *  round trip itself never returns. */
const DASHBOARD_LOAD_TIMEOUT_MS = 40_000;

/**
 * Everything the dashboard needs to fetch, and the two states it can be in
 * while it cannot show a list.
 *
 * Extracted from `ProjectList` because it is a self-contained concern the
 * component only consumes, and because it is the part that keeps being wrong:
 * this path has produced an unbounded spinner twice, most recently because only
 * one of the two calls `loadAll` awaits was given a timeout. Both are bounded
 * here, together, where it is visible that they must be.
 *
 * The setters are returned deliberately. Renames and deletions update the list
 * in place rather than re-scanning the whole projects folder.
 */
export function useProjectListData(activeAccountId: string | null | undefined) {
  const [projects, setProjects] = useState<ProjectWithThumbnail[]>([]);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [filedPaths, setFiledPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  /** Non-null when the last load failed or timed out — the list renders a
   *  retry instead of an empty grid or an endless spinner. */
  const [loadError, setLoadError] = useState<string | null>(null);

  // Monotonic token so a superseded loadAll() (e.g. the list fetched for the
  // old workspace right before a switch) neither applies its stale results nor
  // clears the loading state — preventing an empty-state flash mid-switch.
  // Only loadAll() passes a seq; bare loadProjects() refreshes apply
  // unconditionally and intentionally don't touch the token or the spinner.
  const loadSeqRef = useRef(0);

  const loadProjects = async (seq?: number) => {
    try {
      const projectList = await withTimeout(
        getDashboardProjects(),
        DASHBOARD_LOAD_TIMEOUT_MS,
        'Loading projects'
      );

      // Load thumbnails for each project
      const projectsWithThumbnails = await Promise.all(
        projectList.map(async (project) => {
          let thumbnailData: string | null = null;
          if (project.thumbnail) {
            try {
              thumbnailData = await getProjectThumbnail(project.path);
            } catch (e) {
              // `get_project_thumbnail` rejects with a plain CommandError
              // object (not an Error instance) — String() renders it as
              // "[object Object]" (issue #685). A gone project folder is a
              // by-design Expected state (canonicalize_tagged), not a bug:
              // warn locally instead of auto-filing a report.
              const message = formatCommandError(asCommandError(e));
              const { level } = classifyThumbnailLoadFailure(e);
              if (level === 'warn') {
                const label = isProjectFolderGoneError(e)
                  ? 'Thumbnail unavailable — project folder no longer exists'
                  : 'Thumbnail unavailable';
                logger.warn(label, { error: message, projectName: project.name });
              } else {
                logger.error('Failed to load thumbnail', {
                  error: message,
                  projectName: project.name,
                });
              }
            }
          }
          return { ...project, thumbnailData };
        })
      );

      // A seq'd load (from loadAll) is ignored if a newer one superseded it;
      // a bare refresh (no seq) always applies.
      if (seq === undefined || seq === loadSeqRef.current) {
        setProjects(projectsWithThumbnails);
        setLoadError(null);
      }
    } catch (error) {
      const message = formatCommandError(asCommandError(error));
      // The backend's own budget refusal (a disconnected network drive, an
      // unmounted volume) is classified Expected — an environment state, not
      // a bug, so it warns rather than auto-filing a report (issue #970).
      if (isExpectedCommandError(error)) {
        logger.warn('Failed to load projects', { error: message });
      } else {
        logger.error('Failed to load projects', { error: message });
      }
      if (seq === undefined || seq === loadSeqRef.current) {
        // A backend refusal reaches the user in the backend's own words. A
        // timeout does not: `TimeoutError`'s message is written for a log line
        // ("Loading projects timed out after 40000ms"), and this is a sentence
        // on screen. Say what was observed and name the two things that
        // actually cause it — a permissions prompt waiting for an answer is the
        // one this was watched failing on. Not "macOS": it fires on Windows too.
        setLoadError(
          error instanceof TimeoutError
            ? 'Scanning your projects folder took longer than 40 seconds. A permissions prompt ' +
                'may be waiting for an answer, or the folder may be on a drive that isn’t responding.'
            : message
        );
      }
    }
  };

  const loadFolders = async () => {
    try {
      // Bounded for the same reason the project scan is, and it is the half
      // that was missed: `loadAll` awaits both, so a folder call that never
      // settles keeps `loading` true forever — and because `loading` wins over
      // `loadError`, the user still gets an endless spinner even once the
      // project scan has timed out and set its error. Both calls hit the same
      // backend, so whatever stalls one stalls the other.
      const folderList = await withTimeout(
        listFolders(),
        DASHBOARD_LOAD_TIMEOUT_MS,
        'Loading folders'
      );
      setFolders(folderList);

      const paths = await withTimeout(
        getFiledProjectPaths(),
        DASHBOARD_LOAD_TIMEOUT_MS,
        'Loading folder contents'
      );
      setFiledPaths(new Set(paths));
    } catch (error) {
      logger.error('Failed to load folders', {
        error: formatCommandError(asCommandError(error)),
      });
    }
  };

  const loadAll = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      await Promise.all([loadProjects(seq), loadFolders()]);
    } finally {
      // Only the latest load clears the spinner — a superseded load keeps it up
      // so the list stays in its loading state until the current fetch
      // resolves. In a `finally` because a spinner nothing can clear is the
      // failure this whole path exists to prevent; both halves catch their own
      // errors today, and this makes that a belt rather than the only belt.
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  // Load on mount AND whenever the active workspace changes.
  // get_dashboard_projects is scoped to the active workspace server-side, so a
  // switch changes the result set. Keying on the resolved active-account id
  // (rather than a fired event) is deterministic — it reloads even when the
  // switch happened while this list was unmounted (the picker is a separate
  // view), which an event listener would miss.
  useEffect(() => {
    void loadAll();
  }, [loadAll, activeAccountId]);

  return {
    projects,
    setProjects,
    folders,
    setFolders,
    filedPaths,
    setFiledPaths,
    loading,
    loadError,
    loadProjects,
    loadFolders,
    loadAll,
  };
}
