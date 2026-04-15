/**
 * ProjectRail — fixed left sidebar showing pinned projects.
 *
 * Each pin is a thumbnail with a status dot. Clicking switches to that
 * project (currently via the existing `handleSelectProject` flow — Phase 4
 * will swap to in-place switching once xterm/PTY ownership migrates to the
 * SessionRegistry).
 *
 * The rail is shown in both the projects grid and the workspace. The empty
 * rail (no pins) renders an unobtrusive hint pointing the user to the
 * project card menu.
 *
 * @module components/ProjectRail
 */

import { useEffect, useRef, useState } from 'react';
import type { PinnedProjectRow } from '../hooks/usePinnedProjects';
import { getProjectThumbnail } from '../lib/project';
import { logger } from '../lib/logger';

interface ProjectRailProps {
  /** Joined pin + session rows from `usePinnedProjects`. */
  rows: PinnedProjectRow[];
  /** Click handler — wired to the existing project-open flow today. */
  onPinClick: (projectPath: string) => void;
  /** Right-click handler. Phase 3 surfaces only "Unpin"; later phases add
   *  Reveal in Finder, Open in IDE, Suspend, etc. */
  onUnpin: (projectPath: string) => void;
}

/**
 * Tiny in-memory cache for thumbnails so the rail doesn't refetch them on
 * every snapshot change. Keyed by projectPath. `undefined` means
 * "not yet attempted"; `null` means "fetched but no thumbnail exists".
 */
const thumbnailCache = new Map<string, string | null>();

export function ProjectRail({ rows, onPinClick, onUnpin }: ProjectRailProps) {
  // Don't render anything if there are no pins. Reduces visual noise for
  // users who haven't discovered the feature yet — they only see the rail
  // after pinning their first project.
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="project-rail" role="navigation" aria-label="Pinned projects">
      <ul className="project-rail-list">
        {rows.map((row) => (
          <RailItem key={row.projectPath} row={row} onClick={onPinClick} onUnpin={onUnpin} />
        ))}
      </ul>
    </div>
  );
}

interface RailItemProps {
  row: PinnedProjectRow;
  onClick: (projectPath: string) => void;
  onUnpin: (projectPath: string) => void;
}

function RailItem({ row, onClick, onUnpin }: RailItemProps) {
  // Lazy-init from the in-memory cache so the cache hit doesn't require a
  // setState inside an effect (which the project's lint flags as an
  // anti-pattern). On a cache miss the effect below fetches and updates.
  const [thumbnail, setThumbnail] = useState<string | null>(
    () => thumbnailCache.get(row.projectPath) ?? null
  );
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const itemRef = useRef<HTMLLIElement>(null);

  // Cache miss → fetch and cache. Cache hit was already handled by the
  // useState initializer above, so the effect skips it entirely.
  useEffect(() => {
    if (thumbnailCache.has(row.projectPath)) {
      return;
    }
    let cancelled = false;
    void getProjectThumbnail(row.projectPath)
      .then((data) => {
        thumbnailCache.set(row.projectPath, data);
        if (!cancelled) setThumbnail(data);
      })
      .catch((err) => {
        thumbnailCache.set(row.projectPath, null);
        logger.debug('[ProjectRail] No thumbnail for pin', {
          projectPath: row.projectPath,
          error: String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [row.projectPath]);

  // Close context menu on outside click / escape.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const tooltip = buildTooltip(row);
  const dotClass = statusDotClassName(row);

  return (
    <li ref={itemRef} className="project-rail-item-wrapper">
      <button
        className={`project-rail-item ${row.isCurrent ? 'is-current' : ''} status-${row.status}`}
        title={tooltip}
        aria-label={tooltip}
        onClick={() => onClick(row.projectPath)}
        onContextMenu={handleContextMenu}
      >
        <span className="project-rail-thumb">
          {thumbnail ? (
            <img src={thumbnail} alt="" />
          ) : (
            <span className="project-rail-placeholder" aria-hidden="true">
              {row.fallbackName.charAt(0).toUpperCase()}
            </span>
          )}
        </span>
        <span className={`project-rail-dot ${dotClass}`} aria-hidden="true" />
        {row.unreadCount > 0 && (
          <span className="project-rail-badge" aria-label={`${row.unreadCount} unread`}>
            {row.unreadCount > 9 ? '9+' : row.unreadCount}
          </span>
        )}
      </button>
      {contextMenu && (
        <div
          className="project-rail-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <button
            className="project-rail-menu-item danger"
            onClick={() => {
              setContextMenu(null);
              onUnpin(row.projectPath);
            }}
          >
            Unpin from sidebar
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Maps the joined session state to a CSS class for the status dot.
 *
 * - `inactive` → gray (pinned but no live session, e.g. on app launch)
 * - `suspended` → gray (manually suspended by user)
 * - `error` → red
 * - `active` + `thinking` → yellow
 * - `active` + `waiting` → blue
 * - `active` + `idle` → green
 */
function statusDotClassName(row: PinnedProjectRow): string {
  if (row.status === 'inactive' || row.status === 'suspended') return 'dot-inactive';
  if (row.status === 'error') return 'dot-error';
  if (row.agentStatus === 'thinking') return 'dot-thinking';
  if (row.agentStatus === 'waiting') return 'dot-waiting';
  return 'dot-idle';
}

/** Tooltip text. Includes name, status, and memory if available. */
function buildTooltip(row: PinnedProjectRow): string {
  const parts: string[] = [row.fallbackName];
  if (row.status === 'inactive') {
    parts.push('— suspended (click to resume)');
  } else if (row.status === 'suspended') {
    parts.push('— suspended');
  } else if (row.status === 'error') {
    parts.push('— error');
  } else if (row.agentStatus === 'thinking') {
    parts.push('— thinking');
  } else if (row.agentStatus === 'waiting') {
    parts.push('— waiting for input');
  } else {
    parts.push('— idle');
  }
  if (row.memoryBytes > 0) {
    const mb = Math.round(row.memoryBytes / (1024 * 1024));
    parts.push(`(${mb} MB)`);
  }
  return parts.join(' ');
}
