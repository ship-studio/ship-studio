import { useCallback, useEffect, useRef } from 'react';

interface PanelResizeHandleProps {
  value: number;
  min: number;
  max: number;
  label: string;
  /** Viewport coordinate on the resize axis (X for vertical, Y for horizontal). */
  onResize: (clientPosition: number) => void;
  onResizeBy: (delta: number) => void;
  orientation?: 'vertical' | 'horizontal';
  onDragChange?: (isDragging: boolean) => void;
  className?: string;
}

const KEYBOARD_RESIZE_STEP = 10;

/**
 * Shared separator for resizable panels.
 *
 * The owning panel translates the pointer's viewport coordinate on the resize
 * axis into its local size, keeping this handle independent of surrounding layout.
 */
export function PanelResizeHandle({
  value,
  min,
  max,
  label,
  onResize,
  onResizeBy,
  orientation = 'vertical',
  onDragChange,
  className,
}: PanelResizeHandleProps) {
  const isDragging = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const latestClientPositionRef = useRef(0);

  const resetDragStyles = useCallback(() => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const applyLatestPosition = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    onResize(latestClientPositionRef.current);
  }, [onResize]);

  const finishDrag = useCallback(
    (event?: React.PointerEvent<HTMLDivElement>, applyFinalPosition = true) => {
      if (!isDragging.current) return;
      if (event && pointerIdRef.current !== event.pointerId) return;

      if (applyFinalPosition) applyLatestPosition();
      else if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }

      isDragging.current = false;
      const pointerId = pointerIdRef.current;
      pointerIdRef.current = null;
      if (pointerId !== null && event?.currentTarget.hasPointerCapture?.(pointerId)) {
        event.currentTarget.releasePointerCapture(pointerId);
      }
      resetDragStyles();
      onDragChange?.(false);
    },
    [applyLatestPosition, onDragChange, resetDragStyles]
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      isDragging.current = true;
      pointerIdRef.current = event.pointerId;
      latestClientPositionRef.current = orientation === 'vertical' ? event.clientX : event.clientY;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      onDragChange?.(true);
      document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [onDragChange, orientation]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging.current || pointerIdRef.current !== event.pointerId) return;
      latestClientPositionRef.current = orientation === 'vertical' ? event.clientX : event.clientY;
      if (animationFrameRef.current !== null) return;

      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null;
        if (isDragging.current) onResize(latestClientPositionRef.current);
      });
    },
    [onResize, orientation]
  );

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      resetDragStyles();
    },
    [resetDragStyles]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const previousKey = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
      const nextKey = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
      if (event.key !== previousKey && event.key !== nextKey) return;
      event.preventDefault();
      onResizeBy(event.key === previousKey ? -KEYBOARD_RESIZE_STEP : KEYBOARD_RESIZE_STEP);
    },
    [onResizeBy, orientation]
  );

  return (
    <div
      className={`panel-resize-handle panel-resize-handle--${orientation}${
        className ? ` ${className}` : ''
      }`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={(event) => finishDrag(event, false)}
      onLostPointerCapture={(event) => finishDrag(event, false)}
      onKeyDown={handleKeyDown}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
    />
  );
}
