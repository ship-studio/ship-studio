import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { PanelResizeHandle } from './PanelResizeHandle';

interface Point {
  left: number;
  top: number;
}

interface Size {
  width: number;
  height: number;
}

interface DockablePanelProps {
  children: ReactNode;
  docked: boolean;
  visible?: boolean;
  ariaLabel: string;
  positionKey: string;
  sizeKey: string;
  floatingSize: Size;
  minFloatingSize?: Size;
  initialPosition: () => Point;
  placeholderClassName?: string;
  /** Bump when the dock slot can move without changing its dimensions. */
  dockLayoutKey?: string | number;
  surfaceClassName?: string;
  placeholderRef?: RefObject<HTMLDivElement | null>;
  /** Floating panels such as the colour picker can be movable without being resizable. */
  resizable?: boolean;
  /** Keep compact floating tools fully visible after moves and viewport changes. */
  keepWithinViewport?: boolean;
  /** Optional layer override for a docked, body-portaled surface. */
  dockedZIndex?: CSSProperties['zIndex'];
}

const VIEWPORT_GUTTER = 8;
const MIN_VISIBLE_HEADER = 40;
const DEFAULT_MIN_FLOATING_SIZE = { width: 240, height: 180 };
const KEYBOARD_RESIZE_STEP = 10;
// Floating panels must remain beneath the modal overlay and portaled menus
// (which use the tooltip layer), regardless of how long the app stays open.
const MAX_FLOATING_PANEL_STACK_ORDER = 49;
let nextFloatingPanelOrder = 0;

function readPosition(key: string, fallback: () => Point): Point {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '') as Partial<Point>;
    if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      return { left: saved.left as number, top: saved.top as number };
    }
  } catch {
    // A stale or malformed preference should not prevent the panel rendering.
  }
  return fallback();
}

function readSize(key: string): Size | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '') as Partial<Size>;
    if (
      Number.isFinite(saved.width) &&
      Number.isFinite(saved.height) &&
      (saved.width as number) > 0 &&
      (saved.height as number) > 0
    ) {
      return { width: saved.width as number, height: saved.height as number };
    }
  } catch {
    // A stale or malformed preference should not prevent the panel rendering.
  }
  return null;
}

function clampPosition(point: Point, size: Size, contain = false): Point {
  const next = {
    left: Math.max(
      VIEWPORT_GUTTER,
      Math.min(
        point.left,
        window.innerWidth -
          (contain ? size.width + VIEWPORT_GUTTER : Math.min(size.width, MIN_VISIBLE_HEADER))
      )
    ),
    top: Math.max(
      VIEWPORT_GUTTER,
      Math.min(
        point.top,
        window.innerHeight - (contain ? size.height + VIEWPORT_GUTTER : MIN_VISIBLE_HEADER)
      )
    ),
  };
  return next.left === point.left && next.top === point.top ? point : next;
}

/**
 * Keeps panel contents mounted in a stable body portal while switching between
 * a measured dock slot and a draggable floating rectangle. This is important
 * for stateful children such as xterm terminals, which must not remount merely
 * because their presentation changes.
 *
 * Add `data-dockable-drag-handle` to a child header to make it the floating
 * drag affordance. Interactive controls inside that header are excluded.
 */
export function DockablePanel({
  children,
  docked,
  visible = true,
  ariaLabel,
  positionKey,
  sizeKey,
  floatingSize,
  minFloatingSize = DEFAULT_MIN_FLOATING_SIZE,
  initialPosition,
  placeholderClassName,
  dockLayoutKey,
  surfaceClassName,
  placeholderRef,
  resizable = true,
  keepWithinViewport = false,
  dockedZIndex,
}: DockablePanelProps) {
  const internalPlaceholderRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [initialSavedSize] = useState(() => readSize(sizeKey));
  const savedSizeRef = useRef(initialSavedSize);
  const [dockStyle, setDockStyle] = useState<CSSProperties>();
  const [position, setPosition] = useState<Point>(() =>
    clampPosition(readPosition(positionKey, initialPosition), floatingSize, keepWithinViewport)
  );
  const [stackOrder, setStackOrder] = useState(0);
  const [floatingPanelSize, setFloatingPanelSize] = useState<Size>(
    () => initialSavedSize ?? floatingSize
  );
  const floatingPanelSizeRef = useRef(floatingPanelSize);
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);
  const cornerResizePointerRef = useRef<number | null>(null);

  const updateFloatingSize = useCallback((next: Size) => {
    floatingPanelSizeRef.current = next;
    setFloatingPanelSize(next);
  }, []);

  const assignPlaceholderRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalPlaceholderRef.current = node;
      if (placeholderRef) placeholderRef.current = node;
      const rect = node?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        setDockStyle({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        });
        if (!savedSizeRef.current) {
          updateFloatingSize({ width: rect.width, height: rect.height });
        }
      }
    },
    [placeholderRef, updateFloatingSize]
  );

  const measureDock = useCallback(() => {
    const rect = internalPlaceholderRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    setDockStyle({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    if (docked && !savedSizeRef.current) {
      updateFloatingSize({ width: rect.width, height: rect.height });
    }
  }, [docked, updateFloatingSize]);

  useLayoutEffect(() => {
    const placeholder = internalPlaceholderRef.current;
    if (!placeholder) return;
    // A dock slot can move without changing size when another panel is added
    // before it in the grid. Measure immediately after that class-driven
    // layout change so the body-portaled surface cannot remain over the old
    // slot until a later resize or window event.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- this is a synchronous layout measurement required to keep the portal aligned before paint.
    measureDock();
    const observer = new ResizeObserver(measureDock);
    observer.observe(placeholder);
    // The dock slot can keep the same dimensions while its containing pane
    // moves (for example, when the project sidebar is resized). Observing the
    // container makes the fixed, body-portaled surface remeasure its viewport
    // position as the surrounding workspace layout changes.
    if (placeholder.parentElement) observer.observe(placeholder.parentElement);
    window.addEventListener('resize', measureDock);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measureDock);
    };
  }, [measureDock, placeholderClassName, dockLayoutKey]);

  useEffect(() => {
    if (!docked) return;
    const animationFrame = requestAnimationFrame(measureDock);
    return () => cancelAnimationFrame(animationFrame);
  }, [docked, measureDock]);

  useEffect(() => {
    if (docked || savedSizeRef.current) return;
    const initialSize = floatingPanelSizeRef.current;
    savedSizeRef.current = initialSize;
    localStorage.setItem(sizeKey, JSON.stringify(initialSize));
  }, [docked, sizeKey]);

  useEffect(() => {
    if (!docked && savedSizeRef.current) {
      localStorage.setItem(sizeKey, JSON.stringify(floatingPanelSize));
    }
  }, [docked, floatingPanelSize, sizeKey]);

  useEffect(() => {
    const handleResize = () =>
      setPosition((current) => clampPosition(current, floatingSize, keepWithinViewport));
    if (keepWithinViewport) handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [floatingSize, keepWithinViewport]);

  const bringToFront = useCallback(() => {
    nextFloatingPanelOrder = (nextFloatingPanelOrder % MAX_FLOATING_PANEL_STACK_ORDER) + 1;
    setStackOrder(nextFloatingPanelOrder);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (docked) return;
      const target = event.target as HTMLElement;
      // Portaled panels can still be React descendants of another panel (the
      // Variables colour picker is one example). React bubbles those pointer
      // events through the component tree even though the surfaces are DOM
      // siblings, so only the closest surface may claim this gesture.
      if (target.closest('.dockable-panel__surface') !== event.currentTarget) return;
      bringToFront();
      if (!target.closest('[data-dockable-drag-handle]')) return;
      if (target.closest('button, a, input, select, [role="button"], [role="tablist"]')) return;
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragRef.current = {
        pointerId: event.pointerId,
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
      };
      surfaceRef.current?.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    },
    [bringToFront, docked]
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest('.dockable-panel__surface') !== event.currentTarget) return;
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      setPosition(
        clampPosition(
          { left: event.clientX - drag.dx, top: event.clientY - drag.dy },
          floatingSize,
          keepWithinViewport
        )
      );
    },
    [floatingSize, keepWithinViewport]
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest('.dockable-panel__surface') !== event.currentTarget) return;
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      surfaceRef.current?.releasePointerCapture?.(event.pointerId);
      setPosition((current) => {
        localStorage.setItem(positionKey, JSON.stringify(current));
        return current;
      });
    },
    [positionKey]
  );

  const maxFloatingWidth = Math.max(
    minFloatingSize.width,
    window.innerWidth - position.left - VIEWPORT_GUTTER
  );
  const maxFloatingHeight = Math.max(
    minFloatingSize.height,
    window.innerHeight - position.top - VIEWPORT_GUTTER
  );
  // Moving a floating panel can place part of it beyond the viewport. Keep its
  // size unchanged in that case; the resize handles are the only interaction
  // that should change the panel dimensions.
  const renderedFloatingSize = {
    width: resizable
      ? Math.max(minFloatingSize.width, floatingPanelSize.width)
      : floatingSize.width,
    height: resizable
      ? Math.max(minFloatingSize.height, floatingPanelSize.height)
      : floatingSize.height,
  };

  const resizeFloatingWidth = useCallback(
    (width: number) => {
      updateFloatingSize({
        width: Math.max(
          minFloatingSize.width,
          Math.min(width, window.innerWidth - position.left - VIEWPORT_GUTTER)
        ),
        height: floatingPanelSizeRef.current.height,
      });
    },
    [minFloatingSize.width, position.left, updateFloatingSize]
  );

  const resizeFloatingHeight = useCallback(
    (height: number) => {
      updateFloatingSize({
        width: floatingPanelSizeRef.current.width,
        height: Math.max(
          minFloatingSize.height,
          Math.min(height, window.innerHeight - position.top - VIEWPORT_GUTTER)
        ),
      });
    },
    [minFloatingSize.height, position.top, updateFloatingSize]
  );

  const resizeFloatingBoth = useCallback(
    (width: number, height: number) => {
      updateFloatingSize({
        width: Math.max(
          minFloatingSize.width,
          Math.min(width, window.innerWidth - position.left - VIEWPORT_GUTTER)
        ),
        height: Math.max(
          minFloatingSize.height,
          Math.min(height, window.innerHeight - position.top - VIEWPORT_GUTTER)
        ),
      });
    },
    [minFloatingSize, position, updateFloatingSize]
  );

  const persistFloatingSize = useCallback(
    (isDragging: boolean) => {
      if (isDragging) return;
      const next = floatingPanelSizeRef.current;
      savedSizeRef.current = next;
      localStorage.setItem(sizeKey, JSON.stringify(next));
      window.dispatchEvent(new Event('resize'));
    },
    [sizeKey]
  );

  const handleCornerResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    cornerResizePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleCornerResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (cornerResizePointerRef.current !== event.pointerId) return;
      resizeFloatingBoth(event.clientX - position.left, event.clientY - position.top);
    },
    [position, resizeFloatingBoth]
  );

  const finishCornerResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, applyFinalPosition = true) => {
      if (cornerResizePointerRef.current !== event.pointerId) return;
      if (applyFinalPosition) {
        resizeFloatingBoth(event.clientX - position.left, event.clientY - position.top);
      }
      cornerResizePointerRef.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persistFloatingSize(false);
    },
    [persistFloatingSize, position, resizeFloatingBoth]
  );

  const handleCornerResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const { width, height } = floatingPanelSizeRef.current;
      if (event.key === 'ArrowLeft') {
        resizeFloatingBoth(width - KEYBOARD_RESIZE_STEP, height);
      } else if (event.key === 'ArrowRight') {
        resizeFloatingBoth(width + KEYBOARD_RESIZE_STEP, height);
      } else if (event.key === 'ArrowUp') {
        resizeFloatingBoth(width, height - KEYBOARD_RESIZE_STEP);
      } else if (event.key === 'ArrowDown') {
        resizeFloatingBoth(width, height + KEYBOARD_RESIZE_STEP);
      } else {
        return;
      }
      event.preventDefault();
    },
    [resizeFloatingBoth]
  );

  useEffect(
    () => () => {
      if (cornerResizePointerRef.current !== null) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    },
    []
  );

  const floatingStyle: CSSProperties = {
    left: position.left,
    top: position.top,
    width: renderedFloatingSize.width,
    height: renderedFloatingSize.height,
    zIndex: `calc(var(--z-floating-panel) + ${stackOrder})`,
  };
  // Keep layer ownership tied to the panel's actual presentation state.
  // Feature classes such as `--preview` must never promote a docked panel
  // above a floating one merely because both surfaces share that feature.
  const surfaceStyle: CSSProperties = docked
    ? { ...dockStyle, zIndex: dockedZIndex ?? 'var(--z-dropdown)' }
    : floatingStyle;

  return (
    <>
      <div
        ref={assignPlaceholderRef}
        className={`dockable-panel__placeholder dockable-panel__placeholder--${
          docked ? 'docked' : 'floating'
        }${placeholderClassName ? ` ${placeholderClassName}` : ''}`}
        aria-hidden
      />
      {createPortal(
        <div
          ref={surfaceRef}
          className={`dockable-panel__surface ${
            docked ? 'dockable-panel__surface--docked' : 'dockable-panel__surface--floating'
          }${!visible ? ' is-hidden' : ''}${surfaceClassName ? ` ${surfaceClassName}` : ''}`}
          style={surfaceStyle}
          aria-label={ariaLabel}
          aria-hidden={!visible}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {children}
          {!docked && resizable && (
            <>
              <PanelResizeHandle
                value={renderedFloatingSize.width}
                min={minFloatingSize.width}
                max={maxFloatingWidth}
                label={`Resize ${ariaLabel} width`}
                className="dockable-panel__resize-handle dockable-panel__resize-handle--width"
                onResize={(clientX) => resizeFloatingWidth(clientX - position.left)}
                onResizeBy={(delta) =>
                  resizeFloatingWidth(floatingPanelSizeRef.current.width + delta)
                }
                onDragChange={persistFloatingSize}
              />
              <PanelResizeHandle
                value={renderedFloatingSize.height}
                min={minFloatingSize.height}
                max={maxFloatingHeight}
                label={`Resize ${ariaLabel} height`}
                orientation="horizontal"
                className="dockable-panel__resize-handle dockable-panel__resize-handle--height"
                onResize={(clientY) => resizeFloatingHeight(clientY - position.top)}
                onResizeBy={(delta) =>
                  resizeFloatingHeight(floatingPanelSizeRef.current.height + delta)
                }
                onDragChange={persistFloatingSize}
              />
              <div
                className="dockable-panel__resize-corner"
                role="button"
                tabIndex={0}
                aria-label={`Resize ${ariaLabel} width and height`}
                onPointerDown={handleCornerResizeStart}
                onPointerMove={handleCornerResizeMove}
                onPointerUp={finishCornerResize}
                onPointerCancel={(event) => finishCornerResize(event, false)}
                onLostPointerCapture={(event) => finishCornerResize(event, false)}
                onKeyDown={handleCornerResizeKeyDown}
              />
            </>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
