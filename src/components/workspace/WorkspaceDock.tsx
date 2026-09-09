/**
 * The rail: every docked panel and the preview, in the order the user chose.
 *
 * This component knows nothing about what any panel *contains*. It renders one
 * empty, measured slot per docked panel and registers it; each panel's
 * `DockablePanel` finds the slot that matches its id and portals its
 * placeholder there, then positions its real surface over it. So a panel and
 * its position are completely decoupled — which is what makes reordering safe
 * for an xterm terminal and a live preview iframe alike.
 *
 * ## Two rules that are load-bearing
 *
 * **The children are always in the same DOM order.** Position comes from the
 * flex `order` property, computed from the layout. Reordering is therefore a
 * style change and never a tree change: nothing is unmounted, remounted or
 * reparented, and the preview iframe — which reloads if it is moved in the DOM
 * — never moves.
 *
 * **A resize is local until it is released.** The slot holds its own width
 * while you drag its edge and commits to the layout on release. Writing every
 * pointer move into the shared layout would re-render the whole workspace at
 * the display refresh rate, for a value only one element uses.
 *
 * @module components/workspace/WorkspaceDock
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PanelResizeHandle } from '../primitives/PanelResizeHandle';
import {
  useDefaultWidth,
  useDockDrag,
  usePanelDock,
  usePresentPanels,
} from '../../contexts/PanelDockContext';
import type { RailBounds, RailSlotRect } from '../../lib/dockDrag';
import {
  PANEL_IDS,
  PANEL_META,
  PREVIEW,
  dockedPanels,
  indexOf,
  sideOf,
  widthOf,
  type PanelId,
  type RailItem,
} from '../../lib/workspaceLayout';

/**
 * The most of the rail every docked panel may take between them.
 *
 * The preview keeps the rest. Without a ceiling, four panels dragged wide leave
 * the canvas a sliver — and the preview toolbar, which lives in that column,
 * collapses into overlapping controls long before the canvas becomes useless.
 */
const MAX_DOCKED_FRACTION = 0.75;

interface WorkspaceDockProps {
  /** The preview pane. Always the centre; never portaled, never moved. */
  preview: ReactNode;
  /**
   * Focus mode: the preview is put away and the agent takes the room.
   *
   * The centre keeps its place in the order — this is a temporary collapse, not
   * a rearrangement — so leaving focus mode restores the arrangement exactly.
   */
  previewHidden?: boolean;
  /**
   * Panels rendered here for tidiness rather than for position. Where a panel
   * sits in this tree has no bearing on where it appears: its placeholder is
   * portaled into whichever slot the layout gives it.
   */
  children?: ReactNode;
}

export function WorkspaceDock({ preview, previewHidden = false, children }: WorkspaceDockProps) {
  const { layout, measureRef, previewFullscreen } = usePanelDock();
  const present = usePresentPanels();
  const railRef = useRef<HTMLDivElement>(null);

  /**
   * Hand the drag resolver a way to read real geometry.
   *
   * Read from the DOM rather than from React state: the slots' widths are
   * whatever the last resize left them at, and mid-drag a slot may have a local
   * width the layout has not been told about yet.
   */
  useEffect(() => {
    measureRef.current = () => {
      const rail = railRef.current;
      const railRect = rail?.getBoundingClientRect();
      const bounds: RailBounds = railRect
        ? {
            left: railRect.left,
            right: railRect.right,
            top: railRect.top,
            bottom: railRect.bottom,
          }
        : { left: 0, right: 0, top: 0, bottom: 0 };

      const slots: RailSlotRect[] = [];
      for (const node of rail?.querySelectorAll<HTMLElement>('[data-rail-item]') ?? []) {
        const item = node.dataset.railItem as RailItem | undefined;
        if (!item) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0) continue;
        slots.push({ item, left: rect.left, right: rect.right });
      }
      slots.sort((a, b) => a.left - b.left);
      return { slots, bounds };
    };
    return () => {
      measureRef.current = null;
    };
  }, [measureRef]);

  /**
   * Where the workspace chrome ends, for fullscreen.
   *
   * The rail covers the window below the header rather than all of it, so the
   * project name, the navigation and the macOS traffic lights stay reachable.
   * Measured rather than tokenised because the classic layout has a second
   * toolbar row and the compact one does not.
   */
  const [chromeTop, setChromeTop] = useState(0);
  useEffect(() => {
    if (!previewFullscreen) return;
    const measure = () => {
      const header =
        document.querySelector('.workspace-header') ??
        document.querySelector('.workspace-titlebar');
      setChromeTop(header ? Math.round(header.getBoundingClientRect().bottom) : 0);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [previewFullscreen]);

  // A panel gets a column when the layout docks it *and* it is currently open.
  //
  // Focus mode is the exception: putting the preview away docks the agent
  // whatever the layout says (`WorkspaceTerminalPane` does the same), because
  // otherwise entering focus mode with a floating agent leaves an empty
  // workspace with a window over it. It takes the whole rail, which is what
  // focus mode is.
  const docked = dockedPanels(layout);
  const slotted = (
    previewHidden && !docked.includes('agent') ? [...docked, 'agent' as PanelId] : docked
  ).filter((panel) => present.includes(panel));
  const stretched = previewHidden ? (slotted.includes('agent') ? 'agent' : slotted[0]) : null;

  return (
    <div
      ref={railRef}
      className="workspace-dock"
      data-fullscreen={previewFullscreen ? 'true' : undefined}
      style={
        previewFullscreen
          ? ({ '--dock-fullscreen-top': `${chromeTop}px` } as React.CSSProperties)
          : undefined
      }
    >
      {/* Fixed DOM order — see the note at the top of this file. A floating
          panel renders no slot, but the ones around it keep their position in
          the tree, so nothing is torn down when one is pulled out. */}
      {PANEL_IDS.map((panel) =>
        slotted.includes(panel) ? (
          <WorkspaceDockSlot
            key={panel}
            panel={panel}
            order={indexOf(layout, panel)}
            side={sideOf(layout, panel)}
            dockedCount={slotted.length}
            stretch={stretched === panel}
          />
        ) : null
      )}
      <div
        className="workspace-dock__center"
        data-rail-item={previewHidden ? undefined : PREVIEW}
        hidden={previewHidden}
        style={{ order: indexOf(layout, PREVIEW) }}
      >
        {preview}
      </div>
      {children}
      <DockDropIndicator />
    </div>
  );
}

interface SlotProps {
  panel: PanelId;
  order: number;
  side: 'left' | 'right';
  dockedCount: number;
  /** Take the room the hidden preview left, instead of a fixed width. */
  stretch: boolean;
}

function WorkspaceDockSlot({ panel, order, side, dockedCount, stretch }: SlotProps) {
  const { layout, slots, setWidth } = usePanelDock();
  const drag = useDockDrag();
  const meta = PANEL_META[panel];
  const slotRef = useRef<HTMLDivElement>(null);

  // The committed width is the source of truth; this is the live one during a
  // drag of this slot's edge. Seeded from the layout and re-seeded whenever the
  // layout changes it from elsewhere (a preset, a reset, another window).
  // The panel's own preference is the fallback, not an override: a width the
  // person dragged always wins over one the panel would like.
  const preferred = useDefaultWidth(panel);
  const committed = widthOf(layout, panel, preferred);
  const [width, setWidthState] = useState(committed);
  const [committedAt, setCommittedAt] = useState(committed);
  if (committedAt !== committed) {
    setCommittedAt(committed);
    setWidthState(committed);
  }

  /**
   * The live width, readable synchronously.
   *
   * `PanelResizeHandle` applies the final pointer position and *then* reports
   * that the drag ended, both in one tick — so a `commit` reading `width` from
   * its closure reads the render before that last move and silently drops it.
   * The gap is however far the pointer travelled between the last frame and the
   * release, which on a fast drag is most of it.
   */
  const widthRef = useRef(committed);
  const setLocalWidth = useCallback((next: number) => {
    widthRef.current = next;
    setWidthState(next);
  }, []);

  // The other writer: a preset, a reset, or the panel changing its preferred
  // width. Never mid-drag, so an effect is soon enough — the drag path above
  // is the one that has to be synchronous.
  useLayoutEffect(() => {
    widthRef.current = committed;
  }, [committed]);

  useLayoutEffect(() => {
    const element = slotRef.current;
    slots.set(panel, element);
    return () => slots.set(panel, null);
  }, [panel, slots]);

  // Widening this slot moves every panel to its right. Their surfaces sit over
  // placeholders whose own size did not change, so nothing they observe would
  // tell them — say so.
  useLayoutEffect(() => {
    slots.pingGeometry();
  }, [slots, width, order, stretch]);

  /**
   * The most this panel may be, right now.
   *
   * Its own maximum, and never so wide that the docked panels together pass
   * `MAX_DOCKED_FRACTION` of the rail. The share is divided by how many panels
   * are docked so that four panels cannot each take three quarters.
   */
  const maxWidth = useCallback(() => {
    const rail = slotRef.current?.parentElement?.clientWidth ?? 0;
    if (rail <= 0) return meta.maxWidth;
    const share = (rail * MAX_DOCKED_FRACTION) / Math.max(1, dockedCount);
    return Math.max(meta.minWidth, Math.min(meta.maxWidth, share));
  }, [dockedCount, meta.maxWidth, meta.minWidth]);

  const clamp = useCallback(
    (next: number) => Math.round(Math.max(meta.minWidth, Math.min(next, maxWidth()))),
    [maxWidth, meta.minWidth]
  );

  // The pointer is on the edge facing the preview, so which direction "wider"
  // is depends on which side of it this panel sits.
  const resizeTo = useCallback(
    (clientX: number) => {
      const rect = slotRef.current?.getBoundingClientRect();
      if (!rect) return;
      setLocalWidth(clamp(side === 'left' ? clientX - rect.left : rect.right - clientX));
    },
    [clamp, setLocalWidth, side]
  );

  const resizeBy = useCallback(
    (delta: number) => setLocalWidth(clamp(widthRef.current + delta)),
    [clamp, setLocalWidth]
  );

  const commit = useCallback(
    (dragging: boolean) => {
      if (dragging) return;
      setWidth(panel, widthRef.current);
      // Terminals and the preview measure themselves off a resize; without
      // this the agent's xterm keeps the columns it had before the drag.
      window.dispatchEvent(new Event('resize'));
    },
    [panel, setWidth]
  );

  const isDragging = drag?.panel === panel;

  return (
    <div
      ref={slotRef}
      className={`workspace-dock__slot${isDragging ? ' workspace-dock__slot--lifted' : ''}`}
      data-rail-item={panel}
      data-panel={panel}
      style={
        stretch
          ? { order, flex: '1 1 auto', minWidth: 0 }
          : { order, width, minWidth: width, maxWidth: width }
      }
    >
      {!stretch && (
        <PanelResizeHandle
          value={width}
          min={meta.minWidth}
          max={meta.maxWidth}
          label={`Resize ${meta.label} panel`}
          className={`workspace-dock__resize workspace-dock__resize--${side}`}
          onResize={resizeTo}
          onResizeBy={resizeBy}
          onDragChange={commit}
        />
      )}
    </div>
  );
}

/**
 * Where the panel you are holding would land.
 *
 * A line at the seam, or — out over the canvas, where no seam is near enough —
 * the outline of the window it would become. Both carry the same chip saying it
 * in words, because an insertion line a few pixels from another one is not, on
 * its own, an answer to "which side of the preview is this going".
 */
function DockDropIndicator() {
  const drag = useDockDrag();
  if (!drag) return null;

  const label = PANEL_META[drag.panel].label;

  return createPortal(
    <>
      {drag.target.kind === 'dock' && (
        <div
          className="workspace-dock__drop-line"
          // Bounded by the rail rather than by the window: the line is fixed so
          // it can sit above the portaled panel surfaces, and a CSS `inset`
          // ran it up through the header and the titlebar.
          style={{
            left: drag.target.x,
            top: drag.target.top,
            height: drag.target.bottom - drag.target.top,
          }}
          aria-hidden
        />
      )}
      <div
        className="workspace-dock__drag-chip"
        style={{ left: drag.point.x, top: drag.point.y }}
        role="status"
        aria-live="polite"
      >
        <span className="workspace-dock__drag-chip-name">{label}</span>
        <span className="workspace-dock__drag-chip-hint">{drag.hint}</span>
      </div>
    </>,
    document.body
  );
}
