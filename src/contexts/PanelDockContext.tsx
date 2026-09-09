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
  type RailBounds,
  type RailSlotRect,
} from '../lib/dockDrag';
import {
  PANEL_META,
  PREVIEW,
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
  readProjectLayout,
  writeDefaultLayout,
  writeProjectLayout,
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
  layout: WorkspaceLayout;
  /** True once this project has an arrangement of its own, rather than following the default. */
  isCustomised: boolean;
  /** Whether this project's layout differs from the saved default. */
  differsFromDefault: boolean;

  setLayout: (next: WorkspaceLayout) => void;
  nudge: (panel: PanelId, direction: -1 | 1) => void;
  setDocked: (panel: PanelId, docked: boolean) => void;
  setWidth: (panel: PanelId, width: number) => void;
  applyPreset: (preset: LayoutPreset) => void;
  saveAsDefault: () => void;
  resetToDefault: () => void;

  slots: SlotRegistry;
  presence: PresenceStore;
  defaultWidths: DefaultWidthStore;
  /** Reported by `WorkspaceDock` so a drag can be resolved against real geometry. */
  measureRef: React.MutableRefObject<(() => { slots: RailSlotRect[]; bounds: RailBounds }) | null>;
  drag: DragStore;
  beginDrag: (panel: PanelId, point: Point) => void;
  updateDrag: (point: Point) => void;
  endDrag: (point: Point) => void;
  cancelDrag: () => void;

  /** The preview is filling the window, so the rail goes with it. */
  previewFullscreen: boolean;
  setPreviewFullscreen: (fullscreen: boolean) => void;
}

const PanelDockContext = createContext<PanelDockValue | null>(null);

export function labelOfRailItem(item: RailItem): string {
  return item === PREVIEW ? 'Preview' : PANEL_META[item].label;
}

export function PanelDockProvider({
  projectPath,
  children,
}: {
  projectPath: string;
  children: ReactNode;
}) {
  const [layout, setLayoutState] = useState<WorkspaceLayout>(() => readProjectLayout(projectPath));
  const [defaultLayout, setDefaultLayout] = useState<WorkspaceLayout>(readDefaultLayout);
  const [isCustomised, setIsCustomised] = useState(() => hasProjectLayout(projectPath));
  const [previewFullscreen, setPreviewFullscreen] = useState(false);

  // Re-read when the project changes, with React's "adjust state during render"
  // pattern rather than an effect: an effect renders one frame of the previous
  // project's arrangement first, which is a visible flash of the wrong layout.
  const [pathOfLayout, setPathOfLayout] = useState(projectPath);
  if (pathOfLayout !== projectPath) {
    setPathOfLayout(projectPath);
    setLayoutState(readProjectLayout(projectPath));
    setIsCustomised(hasProjectLayout(projectPath));
  }

  const slots = useMemo(() => new SlotRegistry(), []);
  const presence = useMemo(() => new PresenceStore(), []);
  const defaultWidths = useMemo(() => new DefaultWidthStore(), []);
  const drag = useMemo(() => new DragStore(), []);
  const measureRef = useRef<(() => { slots: RailSlotRect[]; bounds: RailBounds }) | null>(null);

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
      writeProjectLayout(projectPath, normalized);
      setIsCustomised(true);
    },
    [layout, projectPath]
  );

  const nudge = useCallback(
    (panel: PanelId, direction: -1 | 1) => setLayout(nudgePanel(layout, panel, direction)),
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

  const applyPreset = useCallback((preset: LayoutPreset) => setLayout(preset.layout), [setLayout]);

  const saveAsDefault = useCallback(() => {
    writeDefaultLayout(layout);
    setDefaultLayout(normalizeLayout(layout));
  }, [layout]);

  /**
   * Give the project back to the default.
   *
   * Deletes the project's entry rather than writing today's default into it, so
   * it resumes *following* — change your default later and this project moves
   * with it, which is what "reset" should mean.
   */
  const resetToDefault = useCallback(() => {
    clearProjectLayout(projectPath);
    setLayoutState(readDefaultLayout());
    setIsCustomised(false);
  }, [projectPath]);

  // ---- Drag ----

  const resolve = useCallback((point: Point): DropTarget => {
    const geometry = measureRef.current?.();
    if (!geometry) return { kind: 'float' };
    return dropTargetAt(geometry.slots, geometry.bounds, point);
  }, []);

  const beginDrag = useCallback(
    (panel: PanelId, point: Point) => {
      const target = resolve(point);
      drag.set({ panel, point, target, hint: describeDrop(target, labelOfRailItem) });
    },
    [drag, resolve]
  );

  const updateDrag = useCallback(
    (point: Point) => {
      const current = drag.get();
      if (!current) return;
      const target = resolve(point);
      drag.set({ ...current, point, target, hint: describeDrop(target, labelOfRailItem) });
    },
    [drag, resolve]
  );

  const endDrag = useCallback(
    (point: Point) => {
      const current = drag.get();
      drag.set(null);
      if (!current) return;
      setLayout(applyDrop(layout, current.panel, resolve(point)));
    },
    [drag, layout, resolve, setLayout]
  );

  const cancelDrag = useCallback(() => drag.set(null), [drag]);

  const value = useMemo<PanelDockValue>(
    () => ({
      layout,
      isCustomised,
      differsFromDefault: !layoutsEqual(layout, defaultLayout),
      setLayout,
      nudge,
      setDocked,
      setWidth,
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
      previewFullscreen,
      setPreviewFullscreen,
    }),
    [
      layout,
      isCustomised,
      defaultLayout,
      setLayout,
      nudge,
      setDocked,
      setWidth,
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
  const onDragEnd = useCallback((point: Point) => context?.endDrag(point), [context]);
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
    ? `${context.layout.order.join('|')}/${context.layout.floating.join('|')}`
    : '';

  return useMemo(
    () =>
      context && id
        ? {
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
  /** Where to portal the placeholder, or null to leave it inline. */
  slotElement: HTMLElement | null;
  /** Changes whenever the arrangement does, so a moved slot is re-measured. */
  layoutKey: string;
  onDragStart: (point: Point) => void;
  onDragMove: (point: Point) => void;
  onDragEnd: (point: Point) => void;
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
