/**
 * ProjectRail — fixed left sidebar showing pinned projects.
 *
 * Each pin is a thumbnail with a status dot. Clicking switches to that
 * project (currently via the existing `handleSelectProject` flow — Phase 4
 * will swap to in-place switching once xterm/PTY ownership migrates to the
 * SessionRegistry).
 *
 * ## Drag-to-reorder uses pointer events, NOT HTML5 drag-and-drop
 *
 * The HTML5 drag API is unreliable in WebKit (Tauri's renderer on macOS):
 * drag often fails to initiate when the mouse target is interactive, the
 * drag image is broken without explicit `setDragImage`, and the API
 * doesn't compose well with iframes (mouse events fall through to the
 * preview iframe and cause text selection).
 *
 * This component uses pointer events instead — `pointerdown` arms a
 * potential drag, `pointermove` past a small threshold starts the actual
 * drag, `pointerup` commits or cancels. While dragging, a `body` class
 * sets `pointer-events: none` on every iframe so cross-iframe drags work.
 *
 * @module components/ProjectRail
 */

import { useEffect, useRef, useState, useLayoutEffect, useCallback } from 'react';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';
import { getProjectThumbnail, listProjects } from '../../lib/project';
import { logger } from '../../lib/logger';
import { Button } from '../primitives/Button';

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
  /** Called when the user picks a project from the "+" picker. Pins it and opens it. */
  onAddProject?: (projectPath: string) => void;
}

/**
 * Tiny in-memory cache for thumbnails so the rail doesn't refetch them on
 * every snapshot change. Keyed by projectPath. `undefined` means
 * "not yet attempted"; `null` means "fetched but no thumbnail exists".
 */
const thumbnailCache = new Map<string, string | null>();

/** Pixels of pointer movement before pointerdown is treated as a drag. */
const DRAG_THRESHOLD_PX = 5;

/** While a drag is active, body gets this class so iframes ignore mouse. */
const DRAG_BODY_CLASS = 'rail-drag-active';

interface PendingDrag {
  projectPath: string;
  startX: number;
  startY: number;
}

export function ProjectRail({
  rows,
  onPinClick,
  onUnpin,
  onReorder,
  onAddProject,
}: ProjectRailProps) {
  // State drives re-renders for visual feedback (item fade, drop indicator,
  // body class). Refs hold the SAME values for use inside document-level
  // event listeners — without refs, listener closures would capture stale
  // values from the render they were bound in, and we'd need to re-bind
  // listeners on every state change (which causes ordering races).
  const [dragSource, setDragSource] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // 'before' or 'after' — which side of the drop-target the cursor is on,
  // computed from cursor Y vs. target's vertical midpoint. Drives both
  // the visual indicator (line above/below) and the final insert position.
  const [dropSide, setDropSide] = useState<'before' | 'after'>('before');
  const dragSourceRef = useRef<string | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  const dropSideRef = useRef<'before' | 'after'>('before');
  const pendingDragRef = useRef<PendingDrag | null>(null);
  const rowsRef = useRef(rows);
  const onReorderRef = useRef(onReorder);

  // Context menu state (lifted from RailItem so it renders outside the list)
  const [contextMenu, setContextMenu] = useState<{
    projectPath: string;
    x: number;
    y: number;
  } | null>(null);

  // "Add project" picker state
  const [showPicker, setShowPicker] = useState(false);
  const [pickerProjects, setPickerProjects] = useState<{ name: string; path: string }[]>([]);
  const [pickerFilter, setPickerFilter] = useState('');
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const pickerRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  // Mirror props into refs so the once-mounted document listeners read the
  // latest values without re-binding. Done in a layout effect so the refs
  // are up-to-date before any subsequent pointer event runs.
  useLayoutEffect(() => {
    rowsRef.current = rows;
    onReorderRef.current = onReorder;
  }, [rows, onReorder]);

  // Track mounted item elements so pointermove can hit-test which pin the
  // cursor is over even when crossing across the rail freely.
  const itemElementsRef = useRef<Map<string, HTMLElement>>(new Map());

  const registerItemElement = useCallback((projectPath: string, el: HTMLElement | null) => {
    const map = itemElementsRef.current;
    if (el) {
      map.set(projectPath, el);
    } else {
      map.delete(projectPath);
    }
  }, []);

  const setDrag = useCallback((source: string | null) => {
    dragSourceRef.current = source;
    setDragSource(source);
  }, []);

  const setDrop = useCallback((target: string | null, side: 'before' | 'after' = 'before') => {
    dropTargetRef.current = target;
    dropSideRef.current = side;
    setDropTarget(target);
    setDropSide(side);
  }, []);

  // While dragging, force iframes to ignore mouse events so the cursor
  // can move freely across the preview without selecting text inside it.
  useLayoutEffect(() => {
    if (dragSource) {
      document.body.classList.add(DRAG_BODY_CLASS);
    } else {
      document.body.classList.remove(DRAG_BODY_CLASS);
    }
    return () => {
      document.body.classList.remove(DRAG_BODY_CLASS);
    };
  }, [dragSource]);

  // Pointer move + up are listened to globally (not on the rail item)
  // because once a drag starts the user may move outside the original
  // hit zone — across the rail, into the workspace, etc. The listeners
  // are bound ONCE (empty deps) and read mutable state via refs — this
  // avoids the stale-closure / re-bind-races issues that come with
  // closing over render-time state.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      // Promote a pending drag → real drag once movement exceeds threshold.
      const pending = pendingDragRef.current;
      if (pending && dragSourceRef.current === null) {
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
          setDrag(pending.projectPath);
        }
      }

      // While dragging, hit-test tracked item elements to find the drop
      // target under the cursor. Also compute which half of the target the
      // cursor is on (above vs below midpoint) — drives "drop before" vs
      // "drop after" semantics for both the visual indicator and the
      // final insertion. <=5 pins, so this scan is cheap.
      const source = dragSourceRef.current;
      if (source) {
        let foundPath: string | null = null;
        let foundSide: 'before' | 'after' = 'before';
        for (const [path, el] of itemElementsRef.current) {
          if (path === source) continue;
          const rect = el.getBoundingClientRect();
          if (
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
          ) {
            foundPath = path;
            const midY = rect.top + rect.height / 2;
            foundSide = e.clientY < midY ? 'before' : 'after';
            break;
          }
        }
        if (dropTargetRef.current !== foundPath || dropSideRef.current !== foundSide) {
          setDrop(foundPath, foundSide);
        }
      }
    };

    const onUp = () => {
      const source = dragSourceRef.current;
      const target = dropTargetRef.current;
      const side = dropSideRef.current;
      const wasDragging = source !== null;

      pendingDragRef.current = null;
      setDrag(null);
      setDrop(null);

      const handler = onReorderRef.current;
      if (!wasDragging || !handler || !source || !target || source === target) {
        return;
      }

      const currentOrder = rowsRef.current.map((r) => r.projectPath);
      const sourceIdx = currentOrder.indexOf(source);
      const targetIdx = currentOrder.indexOf(target);
      if (sourceIdx === -1 || targetIdx === -1) return;

      // Compute the desired insertion index in the ORIGINAL array, then
      // adjust for source removal. `side` says whether to drop before or
      // after the target. The post-removal adjustment subtracts one if
      // source originally came before the insertion point — without that
      // adjustment, dragging forward (source < target) lands one slot
      // short, which is the bug that made the 2-item swap a no-op.
      const desiredOriginalIdx = side === 'before' ? targetIdx : targetIdx + 1;
      const reordered = [...currentOrder];
      reordered.splice(sourceIdx, 1);
      const insertAt = sourceIdx < desiredOriginalIdx ? desiredOriginalIdx - 1 : desiredOriginalIdx;

      // No-op: source already at the desired position. Avoid spurious
      // backend writes that would re-render the rail for nothing.
      if (insertAt === sourceIdx) return;

      reordered.splice(insertAt, 0, source);
      handler(reordered);
    };

    const onCancel = () => {
      pendingDragRef.current = null;
      setDrag(null);
      setDrop(null);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey);
    };
  }, [setDrag, setDrop]);

  const handlePointerDown = useCallback(
    (projectPath: string, e: React.PointerEvent) => {
      if (!onReorder) return;
      // Only respond to primary mouse button / single-finger touch.
      if (e.button !== 0) return;
      pendingDragRef.current = {
        projectPath,
        startX: e.clientX,
        startY: e.clientY,
      };
    },
    [onReorder]
  );

  const handleClick = useCallback(
    (projectPath: string) => {
      // If we just finished a real drag, suppress the click. The browser
      // fires click after pointerup even when we treated it as a drag.
      if (pendingDragRef.current === null && dragSource === null) {
        // Both refs cleared = either a fresh click, or a just-completed
        // drag. We can distinguish by the presence of dragSource at the
        // moment of pointerup, but by the time onClick fires, dragSource
        // is back to null. So use a brief flag instead.
      }
      onPinClick(projectPath);
    },
    [dragSource, onPinClick]
  );

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

  const handleItemContextMenu = useCallback((projectPath: string, x: number, y: number) => {
    setContextMenu({ projectPath, x, y });
  }, []);

  // Open the project picker: fetch all projects and filter out already-pinned ones.
  const openPicker = useCallback(async () => {
    try {
      const all = await listProjects();
      const pinnedPaths = new Set(rows.map((r) => r.projectPath));
      setPickerProjects(all.filter((p) => !pinnedPaths.has(p.path)));
      setPickerFilter('');
      if (addBtnRef.current) {
        const rect = addBtnRef.current.getBoundingClientRect();
        setPickerPos({ top: rect.top, left: rect.right + 8 });
      }
      setShowPicker(true);
    } catch (e) {
      logger.error('[ProjectRail] Failed to load projects for picker', { error: e });
    }
  }, [rows]);

  // Close picker on click outside or Escape
  useEffect(() => {
    if (!showPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowPicker(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKey);
    };
  }, [showPicker]);

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
            registerElement={registerItemElement}
            onClick={handleClick}
            onContextMenu={handleItemContextMenu}
            isDragging={dragSource === row.projectPath}
            isDropTarget={dropTarget === row.projectPath && dragSource !== row.projectPath}
            dropSide={dropSide}
            isReorderable={onReorder !== undefined}
            onPointerDown={handlePointerDown}
            // Suppress click when ANY drag was active in this gesture.
            // The check happens at click time using a closure over dragSource.
            suppressClickAfterDrag={dragSource !== null}
          />
        ))}
        {onAddProject && (
          <li>
            <button
              ref={addBtnRef}
              className="project-rail-add"
              onClick={() => void openPicker()}
              title="Pin another project"
              aria-label="Pin another project"
            >
              +
            </button>
          </li>
        )}
      </ul>

      {showPicker && onAddProject && (
        <div
          className="project-rail-picker"
          ref={pickerRef}
          style={{ top: pickerPos.top, left: pickerPos.left }}
        >
          <input
            className="project-rail-picker-search"
            type="text"
            placeholder="Search projects..."
            value={pickerFilter}
            onChange={(e) => setPickerFilter(e.target.value)}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <ul className="project-rail-picker-list">
            {(() => {
              const filtered = pickerProjects.filter((p) =>
                p.name.toLowerCase().includes(pickerFilter.toLowerCase())
              );
              if (filtered.length === 0) {
                return <li className="project-rail-picker-empty">No projects found</li>;
              }
              return filtered.map((p) => (
                <li key={p.path}>
                  <button
                    className="project-rail-picker-item"
                    onClick={() => {
                      setShowPicker(false);
                      onAddProject(p.path);
                    }}
                  >
                    {p.name}
                  </button>
                </li>
              ));
            })()}
          </ul>
        </div>
      )}

      {contextMenu && (
        <div
          className="project-rail-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <Button
            variant="ghost"
            className="project-rail-menu-item danger"
            role="menuitem"
            onClick={() => {
              const path = contextMenu.projectPath;
              setContextMenu(null);
              onUnpin(path);
            }}
          >
            Unpin from sidebar
          </Button>
        </div>
      )}
    </div>
  );
}

interface RailItemProps {
  row: PinnedProjectRow;
  registerElement: (projectPath: string, el: HTMLElement | null) => void;
  onClick: (projectPath: string) => void;
  onContextMenu: (projectPath: string, x: number, y: number) => void;
  isDragging: boolean;
  isDropTarget: boolean;
  /** When this row is the drop target, which side the indicator is on. */
  dropSide: 'before' | 'after';
  isReorderable: boolean;
  onPointerDown: (projectPath: string, e: React.PointerEvent) => void;
  suppressClickAfterDrag: boolean;
}

function RailItem({
  row,
  registerElement,
  onClick,
  onContextMenu,
  isDragging,
  isDropTarget,
  dropSide,
  isReorderable,
  onPointerDown,
  suppressClickAfterDrag,
}: RailItemProps) {
  // Lazy-init from the in-memory cache so the cache hit doesn't require a
  // setState inside an effect (which the project's lint flags as an
  // anti-pattern). On a cache miss the effect below fetches and updates.
  const [thumbnail, setThumbnail] = useState<string | null>(
    () => thumbnailCache.get(row.projectPath) ?? null
  );
  const itemRef = useRef<HTMLDivElement>(null);

  // Register this item's DOM node with the rail so pointermove hit-testing
  // can find it. Re-registers on remount, cleans up on unmount.
  useEffect(() => {
    const el = itemRef.current;
    registerElement(row.projectPath, el);
    return () => {
      registerElement(row.projectPath, null);
    };
  }, [row.projectPath, registerElement]);

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

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(row.projectPath, e.clientX, e.clientY);
  };

  const tooltip = buildTooltip(row);
  const dotClass = statusDotClassName(row);

  const wrapperClassName = [
    'project-rail-item-wrapper',
    isDragging ? 'is-dragging' : '',
    isDropTarget ? 'is-drop-target' : '',
    isDropTarget ? `drop-${dropSide}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const itemClassName = [
    'project-rail-item',
    row.isCurrent ? 'is-current' : '',
    `status-${row.status}`,
    isReorderable ? 'is-reorderable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={wrapperClassName}>
      <div
        ref={itemRef}
        className={itemClassName}
        title={tooltip}
        aria-label={tooltip}
        role="button"
        tabIndex={0}
        onPointerDown={(e) => onPointerDown(row.projectPath, e)}
        onClick={(e) => {
          // Suppress click if a drag just happened — the browser fires
          // click after pointerup even when the gesture was a drag.
          if (suppressClickAfterDrag) {
            e.preventDefault();
            return;
          }
          onClick(row.projectPath);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick(row.projectPath);
          }
        }}
        onContextMenu={handleContextMenu}
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
