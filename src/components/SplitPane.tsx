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

import { useState, useRef, useCallback, ReactNode, useEffect } from 'react';

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
  /** Minimum width for right pane as percentage (default: 20) */
  minRight?: number;
  /** Whether the right pane is collapsed */
  rightCollapsed?: boolean;
}

export function SplitPane({
  left,
  right,
  defaultSplit = 50,
  minLeft = 20,
  minRight = 20,
  rightCollapsed = false,
}: SplitPaneProps) {
  const [split, setSplit] = useState(defaultSplit);
  const savedSplitRef = useRef(defaultSplit);
  const prevCollapsedRef = useRef(rightCollapsed);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Store drag listeners in ref for cleanup on unmount
  const dragListenersRef = useRef<{
    move: ((e: MouseEvent) => void) | null;
    up: (() => void) | null;
  }>({ move: null, up: null });

  // Cleanup drag listeners on unmount
  useEffect(() => {
    return () => {
      const { move, up } = dragListenersRef.current;
      if (move) document.removeEventListener('mousemove', move);
      if (up) document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  // Handle collapse/expand of right pane
  useEffect(() => {
    // Only act on actual state changes, not initial mount
    if (rightCollapsed !== prevCollapsedRef.current) {
      if (rightCollapsed) {
        // Save current split before collapsing
        savedSplitRef.current = split;
      } else {
        // Restore saved split when expanding
        setSplit(savedSplitRef.current);
      }
      prevCollapsedRef.current = rightCollapsed;
      // Trigger resize event for terminals to recalculate
      setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
  }, [rightCollapsed, split]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const handleMouseMove = (e: MouseEvent) => {
        if (!containerRef.current) return;

        const rect = containerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = (x / rect.width) * 100;

        // Clamp to min/max
        const clamped = Math.max(minLeft, Math.min(100 - minRight, percentage));
        setSplit(clamped);

        // Trigger resize event for terminals to recalculate
        window.dispatchEvent(new Event('resize'));
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        dragListenersRef.current = { move: null, up: null };
      };

      // Store listeners for cleanup
      dragListenersRef.current = { move: handleMouseMove, up: handleMouseUp };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [minLeft, minRight]
  );

  return (
    <div ref={containerRef} className={`split-pane ${rightCollapsed ? 'right-collapsed' : ''}`}>
      {/* Overlay to capture mouse events during drag (prevents iframe from stealing events) */}
      {isDragging && <div className="split-pane-overlay" />}
      <div className="split-pane-left" style={{ width: rightCollapsed ? '100%' : `${split}%` }}>
        {left}
      </div>
      {!rightCollapsed && (
        <>
          <div className="split-pane-handle" onMouseDown={handleMouseDown}>
            <div className="split-pane-handle-bar" />
          </div>
          <div className="split-pane-right" style={{ width: `${100 - split}%` }}>
            {right}
          </div>
        </>
      )}
    </div>
  );
}
