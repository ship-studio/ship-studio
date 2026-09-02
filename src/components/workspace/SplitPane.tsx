/**
 * SplitPane component that provides a resizable two-pane layout.
 *
 * Creates a horizontal split view with a draggable divider. The divider
 * can be dragged to resize the panes while respecting minimum size constraints.
 * Automatically triggers window resize events when dragged so child components
 * (like terminals) can recalculate their dimensions.
 *
 * @module components/SplitPane
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PanelResizeHandle } from '../primitives/PanelResizeHandle';

/** Props for the SplitPane component */
interface SplitPaneProps {
  /** Content for the left pane */
  left: ReactNode;
  /** Content for the right pane */
  right: ReactNode;
  /** Initial split position as percentage (0-100, default: 50) */
  defaultSplit?: number;
  /** Minimum width for left pane as percentage (default: 20) */
  minLeft?: number;
  /** Optional pixel minimum for the left pane; takes precedence over minLeft. */
  minLeftWidthPx?: number;
  /** Minimum width for right pane as percentage (default: 20) */
  minRight?: number;
  /** Whether the right pane is collapsed */
  rightCollapsed?: boolean;
  /** Whether the left pane is collapsed */
  leftCollapsed?: boolean;
  /** Optional localStorage key used to restore the user's split ratio. */
  persistenceKey?: string;
}

export function SplitPane({
  left,
  right,
  defaultSplit = 50,
  minLeft = 20,
  minLeftWidthPx,
  minRight = 20,
  rightCollapsed = false,
  leftCollapsed = false,
  persistenceKey,
}: SplitPaneProps) {
  const initialSplit = (() => {
    if (!persistenceKey) return defaultSplit;
    const saved = Number(localStorage.getItem(persistenceKey));
    const savedWithinBounds = Number.isFinite(saved) && saved >= 0 && saved <= 100 - minRight;
    const savedMeetsMinimum = minLeftWidthPx !== undefined || saved >= minLeft;
    return savedWithinBounds && savedMeetsMinimum ? saved : defaultSplit;
  })();
  const [split, setSplit] = useState(initialSplit);
  const savedSplitRef = useRef(initialSplit);
  const latestSplitRef = useRef(initialSplit);
  const prevCollapsedRef = useRef(rightCollapsed);
  const prevLeftCollapsedRef = useRef(leftCollapsed);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidthRef = useRef(0);
  const [containerWidth, setContainerWidth] = useState(0);

  const getMinLeftPercentage = useCallback(
    (width: number) => {
      if (minLeftWidthPx !== undefined && width > 0) {
        return Math.min(100 - minRight, (Math.max(0, minLeftWidthPx) / width) * 100);
      }
      return minLeft;
    },
    [minLeft, minLeftWidthPx, minRight]
  );

  const clampSplit = useCallback(
    (value: number, width = containerWidthRef.current) => {
      const minimum = width > 0 ? getMinLeftPercentage(width) : minLeft;
      return Math.max(minimum, Math.min(100 - minRight, value));
    },
    [getMinLeftPercentage, minLeft, minRight]
  );

  const measureContainer = useCallback(() => {
    if (minLeftWidthPx === undefined) return;
    const width = containerRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;

    containerWidthRef.current = width;
    setContainerWidth((current) => (current === width ? current : width));

    const nextSplit = clampSplit(latestSplitRef.current, width);
    if (nextSplit !== latestSplitRef.current) {
      latestSplitRef.current = nextSplit;
      setSplit(nextSplit);
      if (persistenceKey) localStorage.setItem(persistenceKey, String(nextSplit));
      window.dispatchEvent(new Event('resize'));
    }
  }, [clampSplit, minLeftWidthPx, persistenceKey]);

  useLayoutEffect(() => {
    if (minLeftWidthPx === undefined) return;
    const container = containerRef.current;
    if (!container) return;

    // Measure before paint so a persisted split below the pixel floor never
    // flashes at the wrong width.
    measureContainer();
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measureContainer) : null;
    observer?.observe(container);
    window.addEventListener('resize', measureContainer);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureContainer);
    };
  }, [measureContainer, minLeftWidthPx]);

  // Handle collapse/expand of right pane
  useEffect(() => {
    // Only act on actual state changes, not initial mount
    if (rightCollapsed !== prevCollapsedRef.current) {
      if (rightCollapsed) {
        // Save current split before collapsing
        savedSplitRef.current = split;
      } else {
        // Restore saved split when expanding
        const restoredSplit = clampSplit(savedSplitRef.current);
        latestSplitRef.current = restoredSplit;
        setSplit(restoredSplit);
      }
      prevCollapsedRef.current = rightCollapsed;
      // Trigger resize event for terminals to recalculate
      setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
  }, [clampSplit, rightCollapsed, split]);

  useEffect(() => {
    if (leftCollapsed !== prevLeftCollapsedRef.current) {
      prevLeftCollapsedRef.current = leftCollapsed;
      // Let terminals and preview content fit their newly available width.
      setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
  }, [leftCollapsed]);

  const setSplitFromValue = useCallback(
    (value: number, width?: number) => {
      const nextSplit = clampSplit(value, width);
      latestSplitRef.current = nextSplit;
      setSplit(nextSplit);

      // Trigger resize events for terminals and preview content to recalculate.
      window.dispatchEvent(new Event('resize'));
    },
    [clampSplit]
  );

  const resizeAtClientX = useCallback(
    (clientX: number) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      setSplitFromValue(((clientX - rect.left) / rect.width) * 100, rect.width);
    },
    [setSplitFromValue]
  );

  const resizeBy = useCallback(
    (delta: number) => {
      const width = containerWidthRef.current;
      if (minLeftWidthPx !== undefined && width > 0) {
        const currentWidth = (latestSplitRef.current / 100) * width;
        setSplitFromValue(((currentWidth + delta) / width) * 100, width);
      } else {
        setSplitFromValue(latestSplitRef.current + delta);
      }
      if (persistenceKey) {
        localStorage.setItem(persistenceKey, String(latestSplitRef.current));
      }
    },
    [minLeftWidthPx, persistenceKey, setSplitFromValue]
  );

  const handleDragChange = useCallback(
    (dragging: boolean) => {
      setIsDragging(dragging);
      if (!dragging && persistenceKey) {
        localStorage.setItem(persistenceKey, String(latestSplitRef.current));
      }
    },
    [persistenceKey]
  );

  const usesPixelMinimum = minLeftWidthPx !== undefined && containerWidth > 0;
  const handleMax = usesPixelMinimum ? (containerWidth * (100 - minRight)) / 100 : 100 - minRight;
  const handleMin = usesPixelMinimum ? Math.min(Math.max(0, minLeftWidthPx), handleMax) : minLeft;
  const handleValue = usesPixelMinimum ? (split / 100) * containerWidth : split;

  return (
    <div
      ref={containerRef}
      className={`split-pane${rightCollapsed ? ' right-collapsed' : ''}${
        leftCollapsed ? ' left-collapsed' : ''
      }`}
    >
      {/* Overlay to capture mouse events during drag (prevents iframe from stealing events) */}
      {isDragging && <div className="split-pane-overlay" />}
      {/* Keep the left pane mounted while collapsed. Agent terminals own live
          session/UI state that must survive a purely visual hide/show. */}
      <div
        className="split-pane-left"
        style={{ width: leftCollapsed ? 0 : rightCollapsed ? '100%' : `${split}%` }}
        aria-hidden={leftCollapsed}
      >
        {left}
      </div>
      {!leftCollapsed && !rightCollapsed && (
        <PanelResizeHandle
          value={handleValue}
          min={handleMin}
          max={handleMax}
          label="Resize workspace panels"
          onResize={resizeAtClientX}
          onResizeBy={resizeBy}
          onDragChange={handleDragChange}
        />
      )}
      {!rightCollapsed && (
        <>
          <div
            className="split-pane-right"
            style={{ width: leftCollapsed ? '100%' : `${100 - split}%` }}
          >
            {right}
          </div>
        </>
      )}
    </div>
  );
}
