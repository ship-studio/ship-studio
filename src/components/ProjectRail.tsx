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

import { useEffect, useRef, useState, useLayoutEffect } from 'react';
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
  /** Reorder handler — receives the new ordered list of project paths.
   *  Must contain exactly the same set as `rows` (no adds/removes). */
  onReorder?: (orderedPaths: string[]) => void;
}

/**
 * Tiny in-memory cache for thumbnails so the rail doesn't refetch them on
 * every snapshot change. Keyed by projectPath. `undefined` means
 * "not yet attempted"; `null` means "fetched but no thumbnail exists".
 */
const thumbnailCache = new Map<string, string | null>();

export function ProjectRail({ rows, onPinClick, onUnpin, onReorder }: ProjectRailProps) {
  // Drag state lives on the rail, not the item — only one drag is active at
  // a time, and the drop target's visual feedback depends on the dragged item.
  const [dragSource, setDragSource] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // While a drag is active, disable pointer events on the preview iframe so
  // the user doesn't accidentally start text selection inside the preview
  // when dragging across it. Toggled via a body class so any iframe
  // (including future plugin-managed ones) gets the same treatment.
  // useLayoutEffect so the class lands before the next paint.
  useLayoutEffect(() => {
    const cls = 'rail-drag-active';
    if (dragSource) {
      document.body.classList.add(cls);
    } else {
      document.body.classList.remove(cls);
    }
    return () => {
      document.body.classList.remove(cls);
    };
  }, [dragSource]);

  const handleDragStart = (projectPath: string) => {
    setDragSource(projectPath);
  };

  const handleDragEnd = () => {
    setDragSource(null);
    setDropTarget(null);
  };

  const handleDragOver = (projectPath: string, e: React.DragEvent) => {
    if (!dragSource || dragSource === projectPath) return;
    e.preventDefault(); // required for drop to fire
    e.dataTransfer.dropEffect = 'move';
    if (dropTarget !== projectPath) setDropTarget(projectPath);
  };

  const handleDrop = (targetPath: string) => {
    if (!onReorder || !dragSource || dragSource === targetPath) {
      handleDragEnd();
      return;
    }
    const currentOrder = rows.map((r) => r.projectPath);
    const sourceIdx = currentOrder.indexOf(dragSource);
    const targetIdx = currentOrder.indexOf(targetPath);
    if (sourceIdx === -1 || targetIdx === -1) {
      handleDragEnd();
      return;
    }
    // Compute the target's index AFTER removing the source. When source
    // appeared before target, removing it shifts target down by one. We
    // insert at the post-removal target index, which puts source where
    // target was — the standard "drop on item X = take X's slot, X shifts
    // out of the way" UX. Without this adjustment, dragging an item past
    // another lands it on the wrong side.
    const reordered = [...currentOrder];
    reordered.splice(sourceIdx, 1);
    const insertAt = sourceIdx < targetIdx ? targetIdx - 1 : targetIdx;
    reordered.splice(insertAt, 0, dragSource);
    onReorder(reordered);
    handleDragEnd();
  };

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
          <RailItem
            key={row.projectPath}
            row={row}
            onClick={onPinClick}
            onUnpin={onUnpin}
            isDragging={dragSource === row.projectPath}
            isDropTarget={dropTarget === row.projectPath && dragSource !== row.projectPath}
            draggable={onReorder !== undefined}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          />
        ))}
      </ul>
    </div>
  );
}

interface RailItemProps {
  row: PinnedProjectRow;
  onClick: (projectPath: string) => void;
  onUnpin: (projectPath: string) => void;
  isDragging: boolean;
  isDropTarget: boolean;
  draggable: boolean;
  onDragStart: (projectPath: string) => void;
  onDragEnd: () => void;
  onDragOver: (projectPath: string, e: React.DragEvent) => void;
  onDrop: (projectPath: string) => void;
}

function RailItem({
  row,
  onClick,
  onUnpin,
  isDragging,
  isDropTarget,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: RailItemProps) {
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

  // IMPORTANT: drag events go on the element that's the actual mouse
  // target. WebKit (Tauri's renderer on macOS) is strict — putting
  // `draggable` on a parent <li> with an interactive <button> child fails
  // because the button captures mousedown and the drag never starts.
  // We use a single `<div role="button">` element that owns BOTH the
  // click/keyboard semantics AND the drag, instead of a real <button>.
  const wrapperClassName = [
    'project-rail-item-wrapper',
    isDragging ? 'is-dragging' : '',
    isDropTarget ? 'is-drop-target' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const itemClassName = [
    'project-rail-item',
    row.isCurrent ? 'is-current' : '',
    `status-${row.status}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li ref={itemRef} className={wrapperClassName}>
      <div
        className={itemClassName}
        title={tooltip}
        aria-label={tooltip}
        role="button"
        tabIndex={0}
        draggable={draggable}
        onClick={() => onClick(row.projectPath)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick(row.projectPath);
          }
        }}
        onContextMenu={handleContextMenu}
        onDragStart={(e) => {
          // Required for the drag to actually start in WebKit / Firefox.
          // The data value itself is unused — rail tracks source via state.
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.projectPath);
          onDragStart(row.projectPath);
        }}
        onDragEnd={onDragEnd}
        onDragOver={(e) => onDragOver(row.projectPath, e)}
        onDrop={(e) => {
          e.preventDefault();
          onDrop(row.projectPath);
        }}
      >
        <span className="project-rail-thumb">
          {thumbnail ? (
            <img src={thumbnail} alt="" draggable={false} />
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
      </div>
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
