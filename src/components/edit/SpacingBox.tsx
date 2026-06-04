/**
 * Webflow-style box-model spacing editor: an outer margin box wrapping an inner
 * padding box, each with an editable value on all four sides. Reads the current
 * per-side value via the Tailwind cascade (side > axis > all) and writes an
 * absolute side value on change/scroll. Live preview + write-back are handled by
 * the hook's `setBoxSide`.
 */

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { boxSideValue, type BoxType, type Side } from '../../lib/edit';

interface FieldProps {
  value: number | null;
  onSet: (n: number) => void;
  label: string;
  className: string;
}

/** Pixels of drag per 1-unit change. */
const DRAG_SENSITIVITY = 5;

/**
 * One side value. Three ways to change it:
 *  - drag (right/up increases, left/down decreases) — like a design tool,
 *  - scroll to scrub,
 *  - click (selects all) then type to replace.
 */
function SideField({ value, onSet, label, className }: FieldProps) {
  const v = value ?? 0;
  const drag = useRef<{ x: number; y: number; start: number; moved: boolean } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLInputElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, start: v, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLInputElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    d.moved = true;
    e.preventDefault();
    // Right and up both increase; the input no longer takes a caret mid-drag.
    const next = Math.max(0, d.start + Math.round((dx - dy) / DRAG_SENSITIVITY));
    if (next !== v) onSet(next);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLInputElement>) => {
    const wasDrag = drag.current?.moved;
    drag.current = null;
    // After a scrub, drop focus so we don't leave a blinking caret/selection.
    if (wasDrag) e.currentTarget.blur();
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
