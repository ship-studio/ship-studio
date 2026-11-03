/**
 * The workspace rail, as a context.
 *
 * Three things live here because they are one thing — a panel's *place*:
 *
 * 1. **The layout** for the open project, and every change to it.
 * 2. **The slot registry**: which DOM element a docked panel's placeholder
 *    should be portaled into. This is the seam that makes reordering free —
 *    `WorkspaceDock` renders empty measured slots, `DockablePanel` puts its
 *    placeholder in the one that matches, and no panel's *contents* ever move.
 * 3. **The drag**, while one is happening.
 *
 * ## Why the registry and the drag are stores rather than state
 *
 * The provider wraps the entire workspace. A pointer drag fires at the display
 * refresh rate, so holding its position in provider state would re-render the
 * workspace — the agent terminals, the preview chrome, all of it — sixty times
 * a second for the length of the gesture. Both are therefore tiny external
 * stores that only the components which actually need them subscribe to: the
 * drop indicator, and each panel's own placeholder. The provider does not
 * re-render during a drag at all.
 *
 * @module contexts/PanelDockContext
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  applyDrop,
  describeDrop,
  dropTargetAt,
  type DropTarget,
  type RailGeometry,
} from '../lib/dockDrag';
import {
  PANEL_META,
  PREVIEW,
  moveColumn as moveColumnInLayout,
  moveColumnToGap as moveColumnToGapInLayout,
  movePanelToColumnGap,
  reorderPanelInStack,
  setColumnWidth,
  setPanelWeights,
  stackPanel as stackPanelInLayout,
  layoutsEqual,
  normalizeLayout,
  nudgePanel,
  setFloating,
  setPanelWidth,
  type LayoutPreset,
  type PanelId,
  type RailItem,
  type WorkspaceLayout,
} from '../lib/workspaceLayout';
import {
  clearProjectLayout,
  hasProjectLayout,
  readDefaultLayout,
  readLayoutScope,
  readProjectLayout,
  writeDefaultLayout,
  writeLayoutScope,
  writeProjectLayout,
  type LayoutScope,
} from '../lib/workspaceLayoutStore';

export interface Point {
  x: number;
  y: number;
}

/** What a drag looks like from the outside, for the indicator and the chip. */
export interface DockDragState {
  panel: PanelId;
  /** Where the pointer is, so the chip can follow it. */
  point: Point;
  target: DropTarget;
  /** One line saying what releasing now would do. */
  hint: string;
}

// ============ The two stores ============

type Listener = () => void;

/**
 * Which element each docked panel's placeholder belongs in, and a channel for
 * "the rail's geometry moved".
 *
 * The geometry channel exists because a docked panel's surface is positioned
 * over its placeholder, and a `ResizeObserver` on that placeholder only fires
 * when the placeholder itself changes *size*. Dragging one panel's edge, or
 * reordering the rail, moves every other panel without resizing any of them —
 * so each one has to be told rather than left to notice.
 */
class SlotRegistry {
  private elements = new Map<string, HTMLElement>();
  private listeners = new Map<string, Set<Listener>>();
  private geometryListeners = new Set<Listener>();

  pingGeometry(): void {
    for (const listener of this.geometryListeners) listener();
  }

  subscribeGeometry = (listener: Listener): (() => void) => {
    this.geometryListeners.add(listener);
    return () => this.geometryListeners.delete(listener);
  };

  set(id: string, element: HTMLElement | null): void {
    const current = this.elements.get(id) ?? null;
    if (current === element) return;
    if (element) this.elements.set(id, element);
    else this.elements.delete(id);
    for (const listener of this.listeners.get(id) ?? []) listener();
  }

  get(id: string): HTMLElement | null {
    return this.elements.get(id) ?? null;
  }

  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
}

/**
 * A panel's preferred width when nobody has dragged its edge.
 *
 * Only the panel knows this: the Navigator wants a wider column in its Code
 * view than in its tree view, and the rail cannot know which it is showing. An
 * explicit width in the layout always wins — a preference the person expressed
 * outranks one the panel would like.
 */
class DefaultWidthStore {
  private widths = new Map<string, number>();
  private listeners = new Set<Listener>();
  private version = 0;

  set(id: string, width: number | undefined): void {
    const current = this.widths.get(id);
    if (current === width) return;
    if (width === undefined) this.widths.delete(id);
    else this.widths.set(id, width);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  get(id: string): number | undefined {
    return this.widths.get(id);
  }

  getVersion = (): number => this.version;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

class DragStore {
  private state: DockDragState | null = null;
  private listeners = new Set<Listener>();

  get(): DockDragState | null {
    return this.state;
  }

  set(next: DockDragState | null): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/**
 * Which panels currently exist and want a column.
 *
 * A docked panel that is closed must not leave an empty band of workspace
 * behind it, and the workspace cannot answer "is the visual editor open" —
 * that lives inside the preview. So each panel announces itself: mounting a
 * `DockablePanel` with a rail binding *is* the announcement, and its `visible`
 * prop is the answer.
 */
class PresenceStore {
  private present = new Set<string>();
  private listeners = new Set<Listener>();
  private snapshot: readonly string[] = [];

  set(id: string, present: boolean): void {
    if (present === this.present.has(id)) return;
    if (present) this.present.add(id);
    else this.present.delete(id);
    // A frozen array so `useSyncExternalStore` can compare by identity; a fresh
    // one per read would re-render on every tick of anything else.
    this.snapshot = Object.freeze([...this.present]);
    for (const listener of this.listeners) listener();
  }

  get = (): readonly string[] => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

// ============ The context ============

interface PanelDockValue {
  /** Project scope for per-project dock and Focus preferences. */
  projectPath: string;
  layout: WorkspaceLayout;
  /** Temporary topbar Focus projection; it never changes the saved layout. */
  focusMode: boolean;
  /** Whether layout edits belong to this project or every project. */
  layoutScope: LayoutScope;
  /** True once this project has an arrangement of its own, rather than following the default. */
  isCustomised: boolean;
  /** Whether this project's layout differs from the saved default. */
  differsFromDefault: boolean;

  setLayout: (next: WorkspaceLayout) => void;
  setLayoutScope: (scope: LayoutScope) => void;
  /** Compatibility projection for the legacy layout menu. */
  setOrder: (order: readonly RailItem[]) => void;
  nudge: (panel: PanelId, direction: -1 | 1) => void;
  setDocked: (panel: PanelId, docked: boolean) => void;
  setWidth: (panel: PanelId, width: number) => void;
  setColumnWidth: (columnIndex: number, width: number) => void;
  setPanelWeights: (columnIndex: number, weights: Partial<Record<PanelId, number>>) => void;
  movePanelToColumnGap: (panel: PanelId, columnIndex: number) => void;
  moveColumn: (
    columnIndex: number,
    targetColumnIndex: number,
    position: 'before' | 'after'
  ) => void;
  moveColumnToGap: (columnIndex: number, columnGap: number) => void;
  /** Menu-facing stack operation: destination is a column and index is an insertion index. */
  stackPanel: (panel: PanelId, columnIndex: number, index?: number) => void;
  movePanelWithinStack: (panel: PanelId, direction: -1 | 1) => void;
  setFloating: (panel: PanelId, floating: boolean) => void;
  applyPreset: (preset: LayoutPreset) => void;
  saveAsDefault: () => void;
  resetToDefault: () => void;

  slots: SlotRegistry;
  presence: PresenceStore;
  defaultWidths: DefaultWidthStore;
  /** Reported by `WorkspaceDock` so a drag can be resolved against real geometry. */
  measureRef: React.MutableRefObject<(() => RailGeometry) | null>;
  drag: DragStore;
  beginDrag: (panel: PanelId, point: Point) => void;
  updateDrag: (point: Point) => void;
  /** Resolve the drop and report whether the panel was left floating. */
  endDrag: (point: Point) => boolean;
  cancelDrag: () => void;
  /** Temporarily suppress layout drags while focus mode projects the agent. */
  setDragDisabled: (disabled: boolean) => void;

  /** The preview is filling the window, so the rail goes with it. */
  previewFullscreen: boolean;
  setPreviewFullscreen: (fullscreen: boolean) => void;
}

const PanelDockContext = createContext<PanelDockValue | null>(null);

export function labelOfRailItem(item: RailItem): string {
  return item === PREVIEW ? 'Preview' : PANEL_META[item].label;
}

function columnHint(layout: WorkspaceLayout, columnIndex: number | null): string {
  if (columnIndex === null) return 'at the far right';
  const column = layout.columns[columnIndex];
  if (!column) return 'here';
  if (column.kind === 'preview') return 'left of Preview';
  const panel = column.panels[0]?.panel;
  return panel ? `before ${PANEL_META[panel].label}` : 'here';
}

export function PanelDockProvider({
  projectPath,
  focusMode = false,
  children,
}: {
  projectPath: string;
  focusMode?: boolean;
  children: ReactNode;
}) {
  const [layoutScope, setLayoutScopeState] = useState<LayoutScope>(readLayoutScope);
  const [layout, setLayoutState] = useState<WorkspaceLayout>(() =>
    layoutScope === 'global' ? readDefaultLayout() : readProjectLayout(projectPath)
  );
  const [defaultLayout, setDefaultLayout] = useState<WorkspaceLayout>(readDefaultLayout);
  const [isCustomised, setIsCustomised] = useState(
    () => layoutScope === 'project' && hasProjectLayout(projectPath)
  );
  const [previewFullscreen, setPreviewFullscreen] = useState(false);

  // Re-read when the project changes, with React's "adjust state during render"
  // pattern rather than an effect: an effect renders one frame of the previous
  // project's arrangement first, which is a visible flash of the wrong layout.
  const [pathOfLayout, setPathOfLayout] = useState(projectPath);
  if (pathOfLayout !== projectPath) {
    setPathOfLayout(projectPath);
    setLayoutState(layoutScope === 'global' ? readDefaultLayout() : readProjectLayout(projectPath));
    setIsCustomised(layoutScope === 'project' && hasProjectLayout(projectPath));
  }

  const slots = useMemo(() => new SlotRegistry(), []);
  const presence = useMemo(() => new PresenceStore(), []);
  const defaultWidths = useMemo(() => new DefaultWidthStore(), []);
  const drag = useMemo(() => new DragStore(), []);
  const dragDisabledRef = useRef(false);
  const measureRef = useRef<(() => RailGeometry) | null>(null);

  /**
   * Every change goes through here, and every change writes.
   *
   * Arranging a project is what gives it an arrangement — there is no separate
   * save. The alternative, a project that follows the default until you press
   * something, means the drag you just did is undone by the next launch.
   */
  const setLayout = useCallback(
    (next: WorkspaceLayout) => {
      const normalized = normalizeLayout(next);
      if (layoutsEqual(layout, normalized)) return;
      setLayoutState(normalized);
      if (layoutScope === 'global') {
        writeDefaultLayout(normalized);
        setDefaultLayout(normalized);
        setIsCustomised(false);
      } else {
        writeProjectLayout(projectPath, normalized);
        setIsCustomised(true);
      }
    },
    [layout, layoutScope, projectPath]
  );

  /**
   * Change where future layout edits are persisted while keeping the visible
   * arrangement exactly as it is. Existing project overrides are deliberately
   * retained when entering global mode, but ignored until project mode is
   * selected again.
   */
  const setLayoutScope = useCallback(
    (nextScope: LayoutScope) => {
      if (nextScope === layoutScope) return;
      const visible = normalizeLayout(layout);
      if (nextScope === 'global') {
        // Promote what the user is looking at, rather than whichever stale
        // shared default may have been saved before this project was opened.
        writeDefaultLayout(visible);
        setDefaultLayout(visible);
        setIsCustomised(false);
      } else {
        // Overwrite a stale project override so switching scope is not visible
        // as a jump when this project becomes project-scoped again.
        writeProjectLayout(projectPath, visible);
        setIsCustomised(true);
        setDefaultLayout(readDefaultLayout());
      }
      setLayoutState(visible);
      writeLayoutScope(nextScope);
      setLayoutScopeState(nextScope);
    },
    [layout, layoutScope, projectPath]
  );

  const nudge = useCallback(
    (panel: PanelId, direction: -1 | 1) => setLayout(nudgePanel(layout, panel, direction)),
    [layout, setLayout]
  );

  const setOrder = useCallback(
    (order: readonly RailItem[]) =>
      setLayout({
        ...layout,
        columns: order.map((item) => {
          if (item === PREVIEW) return { kind: 'preview' as const };
          const existing = layout.columns.find(
            (column) =>
              column.kind === 'panels' &&
              column.panels.length === 1 &&
              column.panels[0].panel === item
          );
          if (existing?.kind === 'panels' && existing.width !== undefined) {
            return {
              kind: 'panels' as const,
              panels: [{ panel: item, weight: 1 }],
              width: existing.width,
            };
          }
          return {
            kind: 'panels' as const,
            panels: [{ panel: item, weight: 1 }],
          };
        }),
      }),
    [layout, setLayout]
  );

  const setDocked = useCallback(
    (panel: PanelId, docked: boolean) => setLayout(setFloating(layout, panel, !docked)),
    [layout, setLayout]
  );

  const setWidth = useCallback(
    (panel: PanelId, width: number) => setLayout(setPanelWidth(layout, panel, width)),
    [layout, setLayout]
  );

  const setColumnWidthValue = useCallback(
    (columnIndex: number, width: number) => setLayout(setColumnWidth(layout, columnIndex, width)),
    [layout, setLayout]
  );

  const setPanelWeightsValue = useCallback(
    (columnIndex: number, weights: Partial<Record<PanelId, number>>) =>
      setLayout(setPanelWeights(layout, columnIndex, weights)),
    [layout, setLayout]
  );

  const movePanelToColumnGapValue = useCallback(
    (panel: PanelId, columnIndex: number) =>
      setLayout(movePanelToColumnGap(layout, panel, columnIndex)),
    [layout, setLayout]
  );

  const moveColumnValue = useCallback(
    (columnIndex: number, targetColumnIndex: number, position: 'before' | 'after') =>
      setLayout(moveColumnInLayout(layout, columnIndex, targetColumnIndex, position)),
    [layout, setLayout]
  );

  const moveColumnToGapValue = useCallback(
    (columnIndex: number, columnGap: number) =>
      setLayout(moveColumnToGapInLayout(layout, columnIndex, columnGap)),
    [layout, setLayout]
  );

  const stackPanelValue = useCallback(
    (panel: PanelId, columnIndex: number, index = 0) => {
      const column = layout.columns[columnIndex];
      if (column?.kind !== 'panels' || column.panels.length === 0) return;
      const targetIndex = Math.max(0, Math.min(index, column.panels.length - 1));
      const target = column.panels[targetIndex]?.panel;
      if (!target || target === panel) return;
      setLayout(
        stackPanelInLayout(layout, panel, target, index <= targetIndex ? 'before' : 'after')
      );
    },
    [layout, setLayout]
  );

  const movePanelWithinStack = useCallback(
    (panel: PanelId, direction: -1 | 1) => {
      const location = layout.columns.findIndex(
        (column) =>
          column.kind === 'panels' && column.panels.some((placement) => placement.panel === panel)
      );
      const column = layout.columns[location];
      if (location < 0 || column?.kind !== 'panels') return;
      const index = column.panels.findIndex((placement) => placement.panel === panel);
      setLayout(reorderPanelInStack(layout, panel, index + direction));
    },
    [layout, setLayout]
  );

  const setFloatingValue = useCallback(
    (panel: PanelId, floating: boolean) => setLayout(setFloating(layout, panel, floating)),
    [layout, setLayout]
  );

  const applyPreset = useCallback((preset: LayoutPreset) => setLayout(preset.layout), [setLayout]);

  const saveAsDefault = useCallback(() => {
    if (layoutScope === 'global') return;
    writeDefaultLayout(layout);
    setDefaultLayout(normalizeLayout(layout));
  }, [layout, layoutScope]);

  /**
   * Give the project back to the default.
   *
   * Deletes the project's entry rather than writing today's default into it, so
   * it resumes *following* — change your default later and this project moves
   * with it, which is what "reset" should mean.
   */
  const resetToDefault = useCallback(() => {
    if (layoutScope === 'global') return;
    clearProjectLayout(projectPath);
    setLayoutState(readDefaultLayout());
    setIsCustomised(false);
  }, [layoutScope, projectPath]);

  // ---- Drag ----

  const setDragDisabled = useCallback(
    (disabled: boolean) => {
      dragDisabledRef.current = disabled;
      if (disabled) drag.set(null);
    },
    [drag]
  );

  const resolve = useCallback((point: Point): DropTarget => {
    const geometry = measureRef.current?.();
    if (!geometry) return { kind: 'float' };
    return dropTargetAt(geometry, point);
  }, []);

  const beginDrag = useCallback(
    (panel: PanelId, point: Point) => {
      if (dragDisabledRef.current) return;
      const target = resolve(point);
      drag.set({
        panel,
        point,
        target,
        hint: describeDrop(
          target,
          (id) => PANEL_META[id].label,
          (column) => columnHint(layout, column)
        ),
      });
    },
    [drag, layout, resolve]
  );

  const updateDrag = useCallback(
    (point: Point) => {
      if (dragDisabledRef.current) return;
      const current = drag.get();
      if (!current) return;
      const target = resolve(point);
      drag.set({
        ...current,
        point,
        target,
        hint: describeDrop(
          target,
          (id) => PANEL_META[id].label,
          (column) => columnHint(layout, column)
        ),
      });
    },
    [drag, layout, resolve]
  );

  const endDrag = useCallback(
    (point: Point) => {
      const current = drag.get();
      drag.set(null);
      if (!current || dragDisabledRef.current) return false;
      const target = resolve(point);
      setLayout(applyDrop(layout, current.panel, target));
      return target.kind === 'float';
    },
    [drag, layout, resolve, setLayout]
  );

  const cancelDrag = useCallback(() => drag.set(null), [drag]);

  const value = useMemo<PanelDockValue>(
    () => ({
      projectPath,
      layout,
      focusMode,
      layoutScope,
      isCustomised,
      differsFromDefault: !layoutsEqual(layout, defaultLayout),
      setLayout,
      setLayoutScope,
      setOrder,
      nudge,
      setDocked,
      setWidth,
      setColumnWidth: setColumnWidthValue,
      setPanelWeights: setPanelWeightsValue,
      movePanelToColumnGap: movePanelToColumnGapValue,
      moveColumn: moveColumnValue,
      moveColumnToGap: moveColumnToGapValue,
      stackPanel: stackPanelValue,
      movePanelWithinStack,
      setFloating: setFloatingValue,
      applyPreset,
      saveAsDefault,
      resetToDefault,
      slots,
      presence,
      defaultWidths,
      measureRef,
      drag,
      beginDrag,
      updateDrag,
      endDrag,
      cancelDrag,
      setDragDisabled,
      previewFullscreen,
      setPreviewFullscreen,
    }),
    [
      projectPath,
      layout,
      focusMode,
      layoutScope,
      isCustomised,
      defaultLayout,
      setLayout,
      setLayoutScope,
      setOrder,
      nudge,
      setDocked,
      setWidth,
      setColumnWidthValue,
      setPanelWeightsValue,
      movePanelToColumnGapValue,
      moveColumnValue,
      moveColumnToGapValue,
      stackPanelValue,
      movePanelWithinStack,
      setFloatingValue,
      applyPreset,
      saveAsDefault,
      resetToDefault,
      slots,
      presence,
      defaultWidths,
      drag,
      beginDrag,
      updateDrag,
      endDrag,
      cancelDrag,
      setDragDisabled,
      previewFullscreen,
    ]
  );

  return <PanelDockContext.Provider value={value}>{children}</PanelDockContext.Provider>;
}

/**
 * The rail, from inside it.
 *
 * Throws when there is no provider, because every caller is a workspace panel
 * and a missing provider is a wiring mistake rather than a state to render.
 * Panels that must also work outside a workspace use `usePanelDockBinding`,
 * which is optional by design.
 */
export function usePanelDock(): PanelDockValue {
  const value = useContext(PanelDockContext);
  if (!value) throw new Error('usePanelDock must be used inside a PanelDockProvider');
  return value;
}

/** The live drag, for the indicator and the chip. Null when nothing is moving. */
export function useDockDrag(): DockDragState | null {
  const context = useContext(PanelDockContext);
  const subscribe = context?.drag.subscribe ?? noopSubscribe;
  const get = useCallback(() => context?.drag.get() ?? null, [context]);
  return useSyncExternalStore(subscribe, get, () => null);
}

const noopSubscribe = () => () => undefined;

/**
 * Everything a panel needs to sit in the rail, or nothing if it is not in one.
 *
 * Optional on purpose. `DockablePanel` is a primitive used by the colour picker
 * and other floating tools that have no place in the workspace rail; those pass
 * no binding and behave exactly as they always did.
 */
export function usePanelDockBinding(
  panel: PanelId | null | undefined
): PanelDockBinding | undefined {
  const context = useContext(PanelDockContext);
  const id = panel ?? null;

  const subscribe = useCallback(
    (listener: () => void) =>
      context && id ? context.slots.subscribe(id, listener) : noopSubscribe(),
    [context, id]
  );
  const getSlot = useCallback(() => (context && id ? context.slots.get(id) : null), [context, id]);
  const slotElement = useSyncExternalStore(subscribe, getSlot, () => null);

  const onDragStart = useCallback(
    (point: Point) => id && context?.beginDrag(id, point),
    [context, id]
  );
  const onDragMove = useCallback((point: Point) => context?.updateDrag(point), [context]);
  const onDragEnd = useCallback((point: Point) => context?.endDrag(point) ?? false, [context]);
  const onDragCancel = useCallback(() => context?.cancelDrag(), [context]);
  const setPresent = useCallback(
    (present: boolean) => id && context?.presence.set(id, present),
    [context, id]
  );
  const subscribeGeometry = context?.slots.subscribeGeometry;
  const setDefaultWidth = useCallback(
    (width: number | undefined) => id && context?.defaultWidths.set(id, width),
    [context, id]
  );

  /**
   * Fullscreen puts the rail above everything at `--z-preview-fullscreen`, so a
   * docked surface at the ordinary tier would be behind the very thing it is
   * docked into. Answered here rather than by each panel, which is where it used
   * to live and where three of them had to remember it.
   */
  const dockedZIndex = context?.previewFullscreen ? 'var(--z-floating-panel)' : undefined;

  // Changes whenever the rail's arrangement does, so a panel re-measures after
  // a reorder — which moves its slot without changing its size, and so is
  // invisible to a ResizeObserver.
  const layoutKey = context
    ? `${JSON.stringify(context.layout.columns)}/${context.layout.floating.join('|')}`
    : '';

  return useMemo(
    () =>
      context && id
        ? {
            panel: id,
            focusMode: context.focusMode,
            slotElement,
            layoutKey,
            onDragStart,
            onDragMove,
            onDragEnd,
            onDragCancel,
            setPresent,
            subscribeGeometry,
            setDefaultWidth,
            dockedZIndex,
          }
        : undefined,
    [
      context,
      id,
      slotElement,
      layoutKey,
      onDragStart,
      onDragMove,
      onDragEnd,
      onDragCancel,
      setPresent,
      subscribeGeometry,
      setDefaultWidth,
      dockedZIndex,
    ]
  );
}

/** What `DockablePanel` accepts to take part in a rail. */
export interface PanelDockBinding {
  /** Which workspace panel this binding represents. */
  panel: PanelId;
  /** Whether temporary topbar Focus is projecting the workspace rail. */
  focusMode: boolean;
  /** Where to portal the placeholder, or null to leave it inline. */
  slotElement: HTMLElement | null;
  /** Changes whenever the arrangement does, so a moved slot is re-measured. */
  layoutKey: string;
  onDragStart: (point: Point) => void;
  onDragMove: (point: Point) => void;
  /** Resolve the drop and report whether the panel was left floating. */
  onDragEnd: (point: Point) => boolean;
  onDragCancel: () => void;
  /** Claim or release this panel's column. Mounting and `visible` decide it. */
  setPresent: (present: boolean) => void;
  /** Fires while a neighbour is being resized, so this panel keeps up with it. */
  subscribeGeometry?: (listener: () => void) => () => void;
  /** Ask for a width when the layout has none of its own for this panel. */
  setDefaultWidth: (width: number | undefined) => void;
  /** The layer a docked surface belongs on, which fullscreen changes. */
  dockedZIndex?: string;
}

/** The rail if there is one. Panels that also render outside a workspace use this. */
export function useOptionalPanelDock(): PanelDockValue | null {
  return useContext(PanelDockContext);
}

/** A panel's requested default width, and a version that changes when any does. */
export function useDefaultWidth(panel: PanelId): number | undefined {
  const context = useContext(PanelDockContext);
  const subscribe = context?.defaultWidths.subscribe ?? noopSubscribe;
  const version = useSyncExternalStore(
    subscribe,
    () => context?.defaultWidths.getVersion() ?? 0,
    () => 0
  );
  void version;
  return context?.defaultWidths.get(panel);
}

/** The docked panels that currently want a column, for `WorkspaceDock`. */
export function usePresentPanels(): readonly string[] {
  const context = useContext(PanelDockContext);
  const subscribe = context?.presence.subscribe ?? noopSubscribe;
  const get = useCallback(() => context?.presence.get() ?? EMPTY, [context]);
  return useSyncExternalStore(subscribe, get, () => EMPTY);
}

const EMPTY: readonly string[] = Object.freeze([]);
