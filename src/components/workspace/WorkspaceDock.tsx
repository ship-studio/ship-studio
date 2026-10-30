/** The workspace rail: a horizontal row of panel columns and the preview. */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { PanelResizeHandle } from '../primitives/PanelResizeHandle';
import {
  useDefaultWidth,
  useDockDrag,
  usePanelDock,
  usePresentPanels,
} from '../../contexts/PanelDockContext';
import type { RailBounds, RailGeometry, RailPanelRect, RailColumnRect } from '../../lib/dockDrag';
import {
  PANEL_IDS,
  PANEL_META,
  columnWidthOf,
  columnWidthBounds,
  isDocked,
  sideOf,
  type PanelColumn,
  type PanelId,
  type PanelPlacement,
} from '../../lib/workspaceLayout';

const MAX_DOCKED_FRACTION = 0.75;

interface WorkspaceDockProps {
  preview: ReactNode;
  previewHidden?: boolean;
  children?: ReactNode;
}

interface RenderPanelColumn {
  sourceIndex: number;
  column: PanelColumn;
  panels: PanelPlacement[];
}

export function WorkspaceDock({ preview, previewHidden = false, children }: WorkspaceDockProps) {
  const { layout, measureRef, previewFullscreen, setFocusMode, slots } = usePanelDock();
  const present = usePresentPanels();
  const railRef = useRef<HTMLDivElement>(null);
  const presentSet = new Set(present);
  if (previewHidden) presentSet.add('agent');

  useLayoutEffect(() => {
    setFocusMode(previewHidden);
    return () => setFocusMode(false);
  }, [previewHidden, setFocusMode]);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    // Docked panel surfaces are portaled to the document body and positioned
    // from their rail slots. A sidebar collapse can move the whole rail while
    // leaving each slot's size unchanged, so the panel-local ResizeObservers
    // have nothing to report. Observe the rail's available geometry and tell
    // every surface to remeasure when its containing workspace moves.
    const observer = new ResizeObserver(() => slots.pingGeometry());
    observer.observe(rail);
    return () => observer.disconnect();
  }, [slots]);

  const renderColumns: (RenderPanelColumn | { sourceIndex: number; preview: true })[] = [];
  for (const [sourceIndex, column] of layout.columns.entries()) {
    if (column.kind === 'preview') {
      if (!previewHidden) renderColumns.push({ sourceIndex, preview: true });
      continue;
    }
    if (previewHidden && !column.panels.some((placement) => placement.panel === 'agent')) continue;
    const panels = column.panels.filter(
      (placement) =>
        presentSet.has(placement.panel) &&
        (previewHidden ? placement.panel === 'agent' : isDocked(layout, placement.panel))
    );
    if (panels.length > 0) renderColumns.push({ sourceIndex, column, panels });
  }

  useEffect(() => {
    measureRef.current = () => {
      const rail = railRef.current;
      const railRect = rail?.getBoundingClientRect();
      const bounds: RailBounds = railRect
        ? { left: railRect.left, right: railRect.right, top: railRect.top, bottom: railRect.bottom }
        : { left: 0, right: 0, top: 0, bottom: 0 };
      const columns: RailColumnRect[] = [];
      const panels: RailPanelRect[] = [];
      for (const node of rail?.querySelectorAll<HTMLElement>('[data-rail-column]') ?? []) {
        const sourceIndex = Number(node.dataset.columnIndex);
        if (!Number.isInteger(sourceIndex)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const preview = node.dataset.preview === 'true';
        columns.push({
          columnIndex: sourceIndex,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          preview,
        });
        if (preview) continue;
        for (const panelNode of node.querySelectorAll<HTMLElement>('[data-rail-panel]')) {
          const panel = panelNode.dataset.railPanel as PanelId | undefined;
          const panelIndex = Number(panelNode.dataset.panelIndex);
          if (!panel || !Number.isInteger(panelIndex)) continue;
          const panelRect = panelNode.getBoundingClientRect();
          if (panelRect.width <= 0 || panelRect.height <= 0) continue;
          panels.push({
            panel,
            columnIndex: sourceIndex,
            panelIndex,
            left: panelRect.left,
            right: panelRect.right,
            top: panelRect.top,
            bottom: panelRect.bottom,
          });
        }
      }
      columns.sort((a, b) => a.left - b.left);
      return { columns, panels, bounds } satisfies RailGeometry;
    };
    return () => {
      measureRef.current = null;
    };
  }, [measureRef, renderColumns.length]);

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

  const panelColumns = renderColumns
    .filter((column): column is RenderPanelColumn => !('preview' in column))
    .sort((left, right) => {
      const leftPanel = left.panels[0]?.panel;
      const rightPanel = right.panels[0]?.panel;
      return PANEL_IDS.indexOf(leftPanel) - PANEL_IDS.indexOf(rightPanel);
    });
  const previewColumn = renderColumns.find((column) => 'preview' in column);
  const dockedColumnCount = panelColumns.length;

  return (
    <div
      ref={railRef}
      className="workspace-dock"
      data-fullscreen={previewFullscreen ? 'true' : undefined}
      style={
        previewFullscreen
          ? ({ '--dock-fullscreen-top': `${chromeTop}px` } as CSSProperties)
          : undefined
      }
    >
      {/* Keep panel columns in a deterministic DOM order. The preview wrapper
          is always the next sibling, even when its visual flex order changes;
          this protects an iframe from being physically reparented/reloaded. */}
      {panelColumns.map((column) => (
        <WorkspaceDockColumn
          key={`column-${column.sourceIndex}`}
          sourceIndex={column.sourceIndex}
          column={column.column}
          panels={column.panels}
          dockedColumnCount={dockedColumnCount}
          stretch={previewHidden && column.panels.some((placement) => placement.panel === 'agent')}
        />
      ))}
      <div
        key="preview"
        className="workspace-dock__center"
        data-rail-column
        data-column-index={
          previewColumn && 'preview' in previewColumn ? previewColumn.sourceIndex : -1
        }
        data-preview="true"
        hidden={previewHidden}
        style={{
          order: previewColumn && 'preview' in previewColumn ? previewColumn.sourceIndex : 0,
        }}
      >
        {preview}
      </div>
      {children}
      <DockDropIndicator />
    </div>
  );
}

interface WorkspaceDockColumnProps {
  sourceIndex: number;
  column: PanelColumn;
  panels: PanelPlacement[];
  dockedColumnCount: number;
  stretch: boolean;
}

function WorkspaceDockColumn({
  sourceIndex,
  column,
  panels,
  dockedColumnCount,
  stretch,
}: WorkspaceDockColumnProps) {
  const { layout, slots, setColumnWidth, setPanelWeights } = usePanelDock();
  const drag = useDockDrag();
  const preferredWidths = {
    agent: useDefaultWidth('agent'),
    navigator: useDefaultWidth('navigator'),
    variables: useDefaultWidth('variables'),
    editor: useDefaultWidth('editor'),
    team: useDefaultWidth('team'),
  };
  const railColumnRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef(new Map<PanelId, HTMLDivElement>());
  const signature = JSON.stringify(
    column.panels.map((placement) => [placement.panel, placement.weight])
  );
  const initialWeights = Object.fromEntries(
    column.panels.map((placement) => [placement.panel, placement.weight])
  );
  const [weights, setWeights] = useState<Record<string, number>>(() => initialWeights);
  const weightsRef = useRef(weights);
  const visiblePanelSignature = panels.map((placement) => placement.panel).join('|');
  // A floating panel keeps its structural weight so it can return to the same
  // place and size, but it must not reserve visual space while it is away.
  // Renormalise only the rendered slots; the committed layout remains intact.
  const visibleWeightTotal = Math.max(
    Number.EPSILON,
    panels.reduce((total, placement) => total + (weights[placement.panel] ?? placement.weight), 0)
  );
  useLayoutEffect(() => {
    // The structural layout is the committed source of truth. Local weights
    // are only a transient view while a divider is held.
    const next = Object.fromEntries(JSON.parse(signature) as [PanelId, number][]) as Record<
      string,
      number
    >;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWeights(next);
    weightsRef.current = next;
  }, [signature]);

  const columnBounds = columnWidthBounds(column);
  const preferredWidth = Math.max(
    columnBounds.defaultWidth,
    ...panels.map(
      (placement) => preferredWidths[placement.panel] ?? PANEL_META[placement.panel].defaultWidth
    )
  );
  const fallbackWidth = Math.max(
    columnBounds.minWidth,
    Math.min(columnBounds.maxWidth, preferredWidth)
  );
  const committedWidth = columnWidthOf(layout, sourceIndex, fallbackWidth);
  const [width, setWidth] = useState(committedWidth);
  const widthRef = useRef(committedWidth);
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWidth(committedWidth);
    widthRef.current = committedWidth;
  }, [committedWidth]);

  const setLocalWidth = useCallback((next: number) => {
    widthRef.current = next;
    setWidth(next);
  }, []);

  useLayoutEffect(() => {
    widthRef.current = committedWidth;
  }, [committedWidth]);

  useLayoutEffect(() => {
    slots.pingGeometry();
  }, [slots, width, weights, panels.length, stretch]);

  const [slotHeights, setSlotHeights] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const panelIds = visiblePanelSignature.split('|').filter(Boolean) as PanelId[];
    const next = Object.fromEntries(
      panelIds.flatMap((panel) => {
        const height = slotRefs.current.get(panel)?.getBoundingClientRect().height;
        return height && height > 0 ? [[panel, height]] : [];
      })
    );
    setSlotHeights(next);
  }, [visiblePanelSignature, weights, width, stretch]);

  const minWidth = Math.max(...panels.map((placement) => PANEL_META[placement.panel].minWidth));
  const maxWidthForColumn = Math.min(
    ...panels.map((placement) => PANEL_META[placement.panel].maxWidth)
  );
  const maxWidth = useCallback(() => {
    const railWidth = railColumnRef.current?.parentElement?.clientWidth ?? 0;
    if (railWidth <= 0) return maxWidthForColumn;
    const share = (railWidth * MAX_DOCKED_FRACTION) / Math.max(1, dockedColumnCount);
    return Math.max(minWidth, Math.min(maxWidthForColumn, share));
  }, [dockedColumnCount, maxWidthForColumn, minWidth]);
  const clampWidth = useCallback(
    (next: number) => Math.round(Math.max(minWidth, Math.min(next, maxWidth()))),
    [maxWidth, minWidth]
  );

  const resizeWidthTo = useCallback(
    (clientX: number) => {
      const rect = railColumnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next =
        sideOf(layout, panels[0].panel) === 'left' ? clientX - rect.left : rect.right - clientX;
      setLocalWidth(clampWidth(next));
    },
    [clampWidth, layout, panels, setLocalWidth]
  );
  const resizeWidthBy = useCallback(
    (delta: number) => setLocalWidth(clampWidth(widthRef.current + delta)),
    [clampWidth, setLocalWidth]
  );
  const commitWidth = useCallback(
    (dragging: boolean) => {
      if (dragging) return;
      setColumnWidth(sourceIndex, widthRef.current);
      window.dispatchEvent(new Event('resize'));
    },
    [setColumnWidth, sourceIndex]
  );

  const updatePair = useCallback(
    (before: PanelId, after: PanelId, beforePixels: number) => {
      const beforeNode = slotRefs.current.get(before);
      const afterNode = slotRefs.current.get(after);
      const columnNode = railColumnRef.current;
      if (!beforeNode || !afterNode || !columnNode) return;
      const beforeRect = beforeNode.getBoundingClientRect();
      const afterRect = afterNode.getBoundingClientRect();
      const span = Math.max(1, afterRect.bottom - beforeRect.top);
      const minBefore = PANEL_META[before].minHeight;
      const minAfter = PANEL_META[after].minHeight;
      const pixels = Math.max(minBefore, Math.min(span - minAfter, beforePixels));
      const beforeWeight = weightsRef.current[before] ?? 1;
      const afterWeight = weightsRef.current[after] ?? 1;
      const total = beforeWeight + afterWeight;
      const ratio = pixels / span;
      const next = {
        ...weightsRef.current,
        [before]: total * ratio,
        [after]: total * (1 - ratio),
      };
      weightsRef.current = next;
      setWeights(next);
    },
    [setWeights]
  );

  const renderPanel = (placement: PanelPlacement, panelIndex: number) => {
    const panel = placement.panel;
    const next = panels[panelIndex + 1]?.panel;
    const value = slotHeights[panel] ?? PANEL_META[panel].minHeight;
    const handle = next ? (
      <PanelResizeHandle
        value={value}
        min={PANEL_META[panel].minHeight}
        max={Math.max(
          PANEL_META[panel].minHeight,
          value + (slotHeights[next] ?? PANEL_META[next].minHeight) - PANEL_META[next].minHeight
        )}
        label={`Resize ${PANEL_META[panel].label} and ${PANEL_META[next].label} panels`}
        orientation="horizontal"
        onResize={(clientY) => {
          const rect = slotRefs.current.get(panel)?.getBoundingClientRect();
          if (rect) updatePair(panel, next, clientY - rect.top);
        }}
        onResizeBy={(delta) => updatePair(panel, next, value + delta)}
        onDragChange={(dragging) => {
          if (!dragging) {
            setPanelWeights(sourceIndex, weightsRef.current);
            window.dispatchEvent(new Event('resize'));
          }
        }}
        className="workspace-dock__stack-resize"
      />
    ) : null;
    return (
      <WorkspaceDockPanelSlot
        key={panel}
        panel={panel}
        panelIndex={panelIndex}
        weight={(weights[panel] ?? placement.weight) / visibleWeightTotal}
        slotRefs={slotRefs}
        slots={slots}
        dragPanel={drag?.panel === panel}
        resizeHandle={handle}
      />
    );
  };

  return (
    <div
      ref={railColumnRef}
      className="workspace-dock__column"
      data-rail-column
      data-column-index={sourceIndex}
      style={
        stretch
          ? { order: sourceIndex, flex: '1 1 auto', minWidth: 0 }
          : { order: sourceIndex, width, minWidth: width, maxWidth: width }
      }
    >
      {panels.map(renderPanel)}
      {!stretch && (
        <PanelResizeHandle
          value={width}
          min={minWidth}
          max={maxWidthForColumn}
          label={`Resize ${panels.map((placement) => PANEL_META[placement.panel].label).join(' and ')} column`}
          onResize={resizeWidthTo}
          onResizeBy={resizeWidthBy}
          onDragChange={commitWidth}
          className={`workspace-dock__resize workspace-dock__resize--${sideOf(layout, panels[0].panel)}`}
        />
      )}
    </div>
  );
}

interface WorkspaceDockPanelSlotProps {
  panel: PanelId;
  panelIndex: number;
  weight: number;
  slotRefs: React.MutableRefObject<Map<PanelId, HTMLDivElement>>;
  slots: ReturnType<typeof usePanelDock>['slots'];
  dragPanel: boolean;
  resizeHandle: ReactNode;
}

function assignSlotNode(
  slotRefs: React.MutableRefObject<Map<PanelId, HTMLDivElement>>,
  slots: ReturnType<typeof usePanelDock>['slots'],
  panel: PanelId,
  node: HTMLDivElement | null
) {
  if (node) {
    slotRefs.current.set(panel, node);
    slots.set(panel, node);
  } else {
    slotRefs.current.delete(panel);
    slots.set(panel, null);
  }
}

function WorkspaceDockPanelSlot({
  panel,
  panelIndex,
  weight,
  slotRefs,
  slots,
  dragPanel,
  resizeHandle,
}: WorkspaceDockPanelSlotProps) {
  const assignRef = useCallback(
    (node: HTMLDivElement | null) => assignSlotNode(slotRefs, slots, panel, node),
    [panel, slotRefs, slots]
  );

  return (
    <div
      ref={assignRef}
      className={`workspace-dock__slot${dragPanel ? ' workspace-dock__slot--lifted' : ''}`}
      data-rail-panel={panel}
      data-panel={panel}
      data-panel-index={panelIndex}
      style={{ flex: `${weight} 1 0`, minHeight: PANEL_META[panel].minHeight }}
    >
      {resizeHandle}
    </div>
  );
}

function DockDropIndicator() {
  const drag = useDockDrag();
  if (!drag) return null;
  const label = PANEL_META[drag.panel].label;
  return createPortal(
    <>
      {drag.target.kind === 'column' && (
        <div
          className="workspace-dock__drop-line workspace-dock__drop-line--column"
          style={{
            left: drag.target.x,
            top: drag.target.top,
            height: drag.target.bottom - drag.target.top,
          }}
          aria-hidden
        />
      )}
      {drag.target.kind === 'stack' && (
        <div
          className="workspace-dock__drop-line workspace-dock__drop-line--stack"
          style={{
            left: drag.target.left,
            top: drag.target.y,
            width: drag.target.right - drag.target.left,
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
