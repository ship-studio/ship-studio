/**
 * Webflow-style box-model spacing editor: an outer margin box wrapping an inner
 * padding box, each with an editable value on all four sides. Reads the current
 * per-side value via the Tailwind cascade (side > axis > all) and writes an
 * absolute side value on change/scroll. Live preview + write-back are handled by
 * the hook's `setBoxSide`.
 */

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { boxSideValue, type BoxType, type Side } from '../../lib/edit';

/** Drag axis + direction per side: a bar only scrubs along its own orientation,
 *  pulling outward to grow (top↑, bottom↓, left←, right→) — like Webflow. */
const SIDE_DRAG: Record<Side, { axis: 'x' | 'y'; sign: 1 | -1 }> = {
  top: { axis: 'y', sign: -1 },
  bottom: { axis: 'y', sign: 1 },
  left: { axis: 'x', sign: -1 },
  right: { axis: 'x', sign: 1 },
};

interface FieldProps {
  value: number | null;
  onSet: (n: number) => void;
  label: string;
  className: string;
  dir: { axis: 'x' | 'y'; sign: 1 | -1 };
}

/** Pixels of drag per 1-unit change. */
const DRAG_SENSITIVITY = 5;

/**
 * One side value. Three ways to change it:
 *  - drag along the bar's own axis (pulls outward to grow) — like a design tool,
 *  - scroll to scrub,
 *  - click (selects all) then type to replace.
 */
function SideField({ value, onSet, label, className, dir }: FieldProps) {
  const v = value ?? 0;
  const drag = useRef<{ x: number; y: number; start: number } | null>(null);
  const dragged = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLInputElement>) => {
    if (e.button !== 0) return;
    // Prevent the default focus/caret on press so a drag scrubs cleanly (no
    // selection fighting the drag); we focus explicitly on a click in pointerup.
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, start: v };
    dragged.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLInputElement>) => {
    const d = drag.current;
    if (!d) return;
    // Only this bar's own axis moves it (horizontal bars scrub vertically, etc.).
    const along = dir.axis === 'x' ? e.clientX - d.x : e.clientY - d.y;
    if (!dragged.current && Math.abs(along) < 3) return;
    dragged.current = true;
    const next = Math.max(0, d.start + dir.sign * Math.round(along / DRAG_SENSITIVITY));
    if (next !== v) onSet(next);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLInputElement>) => {
    const wasClick = drag.current && !dragged.current;
    drag.current = null;
    // A click (no drag) focuses + selects so you can type a replacement; because
    // we suppressed focus on press, nothing clears the selection on release.
    if (wasClick) e.currentTarget.focus();
  };

  return (
    <input
      className={`ss-box__field ${className}`}
      aria-label={label}
      title={`${label} (drag or scroll to adjust)`}
      inputMode="numeric"
      value={String(v)}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        if (!Number.isNaN(n) && n >= 0) onSet(n);
      }}
      onWheel={(e) => onSet(Math.max(0, v + (e.deltaY < 0 ? 1 : -1)))}
      onFocus={(e) => e.target.select()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

interface Props {
  currentClass: string;
  onSetSide: (type: BoxType, side: Side, n: number) => void;
}

export function SpacingBox({ currentClass, onSetSide }: Props) {
  const field = (type: BoxType, side: Side, edge: string) => (
    <SideField
      value={boxSideValue(currentClass, type, side)}
      onSet={(n) => onSetSide(type, side, n)}
      label={`${type === 'padding' ? 'Padding' : 'Margin'} ${side}`}
      className={`ss-box__edge--${edge}`}
      dir={SIDE_DRAG[side]}
    />
  );

  return (
    <div className="ss-box" data-testid="spacing-box">
      <span className="ss-box__tag">MARGIN</span>
      {field('margin', 'top', 't')}
      {field('margin', 'bottom', 'b')}
      {field('margin', 'left', 'l')}
      {field('margin', 'right', 'r')}

      <div className="ss-box__inner">
        <span className="ss-box__tag">PADDING</span>
        {field('padding', 'top', 't')}
        {field('padding', 'bottom', 'b')}
        {field('padding', 'left', 'l')}
        {field('padding', 'right', 'r')}
        <div className="ss-box__core" />
      </div>
    </div>
  );
}
