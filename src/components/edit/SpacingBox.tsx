/**
 * Webflow-style box-model spacing editor: an outer margin box wrapping an inner
 * padding box, each with an editable value on all four sides. Reads the current
 * per-side value via the Tailwind cascade (side > axis > all) and writes an
 * absolute side value on change/scroll. Live preview + write-back are handled by
 * the hook's `setBoxSide`.
 */

import { boxSideValue, type BoxType, type Side } from '../../lib/edit';

interface FieldProps {
  value: number | null;
  onSet: (n: number) => void;
  label: string;
  className: string;
}

/** One side value: type a number or scroll to scrub. Empty/“—” means 0. */
function SideField({ value, onSet, label, className }: FieldProps) {
  const v = value ?? 0;
  return (
    <input
      className={`ss-box__field ${className}`}
      aria-label={label}
      title={`${label} (scroll to adjust)`}
      inputMode="numeric"
      value={String(v)}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        if (!Number.isNaN(n) && n >= 0) onSet(n);
      }}
      onWheel={(e) => onSet(Math.max(0, v + (e.deltaY < 0 ? 1 : -1)))}
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
