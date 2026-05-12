/**
 * Vertical drag handles between split panes. Renders N-1 dividers at the
 * cumulative boundaries between adjacent panes. Dragging adjusts the two
 * neighbouring panes' percentages without affecting the rest.
 *
 * Mirrors `SplitPane.tsx`'s drag pattern: mousedown captures starting
 * percentages and pointer X, mousemove diffs against container width and
 * pushes the new percentages via `onResize`, mouseup ends the drag and
 * fires a window resize so xterm refits.
 *
 * @module components/TerminalSplitDividers
 */

import { useCallback } from 'react';

/** Minimum pane width as a percentage. Must match the hook's clamp. */
const MIN_PANE_PERCENT = 12;

interface TerminalSplitDividersProps {
  /** Current pane sizes (percent, sum to 100). */
  sizes: number[];
  /** Called with new sizes when the user drags. */
  onResize: (sizes: number[]) => void;
}

export function TerminalSplitDividers({ sizes, onResize }: TerminalSplitDividersProps) {
  // Both move + up handlers are created inside mousedown so they share a
  // closure over the starting state and can reference each other for
  // teardown — avoids a useCallback cycle.
  const handleMouseDown = useCallback(
    (boundaryIndex: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      const container = (e.currentTarget as HTMLElement).parentElement;
      const containerWidth = container?.clientWidth ?? 0;
      if (containerWidth === 0) return;
      const startX = e.clientX;
      const startSizes = [...sizes];

      const onMove = (ev: MouseEvent) => {
        const deltaPx = ev.clientX - startX;
        const deltaPct = (deltaPx / containerWidth) * 100;
        const a = startSizes[boundaryIndex] + deltaPct;
        const b = startSizes[boundaryIndex + 1] - deltaPct;
        if (a < MIN_PANE_PERCENT || b < MIN_PANE_PERCENT) return;
        const next = [...startSizes];
        next[boundaryIndex] = a;
        next[boundaryIndex + 1] = b;
        onResize(next);
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Refit xterm to the final widths.
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sizes, onResize]
  );

  // Cumulative boundary positions: between pane i and i+1, boundary is at
  // sum(sizes[0..i]). The 8px-wide handle is centered on the boundary, so
  // its left edge sits at `boundary% - 4px`.
  const boundaries: number[] = [];
  let cum = 0;
  for (let i = 0; i < sizes.length - 1; i++) {
    cum += sizes[i];
    boundaries.push(cum);
  }

  return (
    <>
      {boundaries.map((pct, i) => (
        <div
          key={i}
          className="terminal-split-handle"
          style={{ left: `calc(${pct}% - 4px)` }}
          onMouseDown={handleMouseDown(i)}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize between pane ${i + 1} and pane ${i + 2}`}
        >
          <div className="terminal-split-handle-bar" />
        </div>
      ))}
    </>
  );
}
