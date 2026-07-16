/**
 * Webflow-style box-model spacing editor: an outer margin box wrapping an inner
 * padding box, each with an editable value on all four sides. Reads the current
 * per-side value via the Tailwind cascade (side > axis > all) and writes it on
 * change/scroll/drag. Values can be a Tailwind scale step (a bare integer) or any
 * valid CSS length (`10rem`, `50%`, `clamp(…)`); invalid input flags the field.
 * Live preview + write-back are handled by the hook's `setBoxSide`.
 */

import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  boxSide,
  readLayer,
  spacingDisplay,
  parseSpacingInput,
  type BoxType,
  type Side,
  type LayerContext,
  type SpacingValue,
} from '../../lib/edit';

/** Drag axis + direction per side: a bar only scrubs along its own orientation,
 *  pulling outward to grow (top↑, bottom↓, left←, right→) — like Webflow. */
const SIDE_DRAG: Record<Side, { axis: 'x' | 'y'; sign: 1 | -1 }> = {
  top: { axis: 'y', sign: -1 },
  bottom: { axis: 'y', sign: 1 },
  left: { axis: 'x', sign: -1 },
  right: { axis: 'x', sign: 1 },
};

/** Pixels of drag per 1-unit change. */
const DRAG_SENSITIVITY = 5;

interface FieldProps {
  value: SpacingValue | null;
  onSet: (v: SpacingValue) => void;
  /** CSS property the typed value is validated against (`padding` / `margin`). */
  cssProp: string;
  label: string;
  className: string;
  dir: { axis: 'x' | 'y'; sign: 1 | -1 };
  /** True when the shown value is inherited from a smaller breakpoint (not set
   *  at the active one) — the field is rendered muted to signal that. */
  inherited?: boolean;
}

/** The numeric magnitude a drag/scroll scrubs, plus how to rebuild a value from a
 *  new magnitude. Null when the value can't be stepped (e.g. `calc(…)`). */
function dragBaseOf(
  value: SpacingValue | null
): { magnitude: number; build: (m: number) => SpacingValue } | null {
  if (!value || value.kind === 'scale') {
    const mag = value?.kind === 'scale' ? value.n : 0;
    return { magnitude: mag, build: (m) => ({ kind: 'scale', n: Math.max(0, Math.round(m)) }) };
  }
  const match = /^(-?\d*\.?\d+)(.*)$/.exec(value.raw.trim());
  if (!match) return null;
  const unit = match[2];
  return {
    magnitude: parseFloat(match[1]),
    build: (m) => ({ kind: 'arbitrary', raw: `${Math.max(0, m)}${unit}` }),
  };
}

/**
 * One side value. Four ways to change it:
 *  - drag along the bar's own axis (pulls outward to grow) — like a design tool,
 *  - scroll to scrub,
 *  - ArrowUp/Down to step (Shift ×10, Alt fine),
 *  - click (selects all) then type a value or unit (10rem, 50%); Enter/blur applies.
 * Bad input (`40xyz`) marks the field invalid and isn't applied.
 */
function SideField({ value, onSet, cssProp, label, className, dir, inherited }: FieldProps) {
  const display = spacingDisplay(value);
  const [text, setText] = useState(display);
  const [lastDisplay, setLastDisplay] = useState(display);
  const [invalid, setInvalid] = useState(false);
  // Sync the field when the value changes externally (steppers, reselect) — but
  // not while the user is mid-edit with unsaved invalid text.
  if (display !== lastDisplay && !invalid) {
    setLastDisplay(display);
    setText(display);
  }

  const drag = useRef<{ x: number; y: number; base: ReturnType<typeof dragBaseOf> } | null>(null);
  const dragged = useRef(false);

  /** Parse + apply the typed text; on bad input, mark invalid (keep the text). */
  const commit = () => {
    const parsed = parseSpacingInput(text, cssProp);
    if (parsed.kind === 'invalid') {
      setInvalid(true);
      return false;
    }
    setInvalid(false);
    onSet(parsed);
    return true;
  };

  /** One keyboard step: ArrowUp/Down = one drag tick, Shift ×10, Alt = fine
   *  (÷10 on unit values; the Tailwind scale stays on whole steps). Steps the
   *  typed text when it parses, else the live value — same commit path as drag. */
  const onArrowStep = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const parsed = parseSpacingInput(text, cssProp);
    const cur = parsed.kind === 'invalid' ? value : parsed;
    const base = dragBaseOf(cur);
    if (!base) return; // non-numeric (calc(…)) — leave the caret alone
    e.preventDefault();
    const fine = cur?.kind === 'arbitrary' ? 0.1 : 1;
    const step = e.shiftKey ? 10 : e.altKey ? fine : 1;
    const dir = e.key === 'ArrowUp' ? 1 : -1;
    onSet(base.build(Math.round((base.magnitude + dir * step) * 100) / 100));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLInputElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, base: dragBaseOf(value) };
    dragged.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLInputElement>) => {
    const d = drag.current;
    if (!d || !d.base) return;
    const along = dir.axis === 'x' ? e.clientX - d.x : e.clientY - d.y;
    if (!dragged.current && Math.abs(along) < 3) return;
    dragged.current = true;
    const next = d.base.magnitude + dir.sign * Math.round(along / DRAG_SENSITIVITY);
    onSet(d.base.build(next));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLInputElement>) => {
    const wasClick = drag.current && !dragged.current;
    drag.current = null;
    if (wasClick) e.currentTarget.focus();
  };

  return (
    <input
      className={`ss-box__field ${className}${inherited ? ' ss-box__field--inherited' : ''}${
        invalid ? ' ss-box__field--invalid' : ''
      }`}
      aria-label={label}
      aria-invalid={invalid}
      title={
        invalid
          ? 'Use a valid value or unit (e.g. 8, 10rem, 50%)'
          : `${label} (drag, scroll, or type)`
      }
      inputMode="text"
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
      spellCheck={false}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (invalid) setInvalid(false);
      }}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') onArrowStep(e);
      }}
      onBlur={() => {
        // Apply if valid; otherwise drop the bad text back to the live value.
        if (!commit()) {
          setText(display);
          setInvalid(false);
        }
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

interface Props {
  currentClass: string;
  /** Active breakpoint layer — sides read their effective value across the cascade. */
  layer: LayerContext;
  onSetSide: (type: BoxType, side: Side, value: SpacingValue) => void;
}

export function SpacingBox({ currentClass, layer, onSetSide }: Props) {
  const field = (type: BoxType, side: Side, edge: string) => {
    const { value, definedAt } = readLayer(currentClass, layer, (s) => boxSide(s, type, side));
    return (
      <SideField
        value={value}
        onSet={(v) => onSetSide(type, side, v)}
        cssProp={type}
        label={`${type === 'padding' ? 'Padding' : 'Margin'} ${side}`}
        className={`ss-box__edge--${edge}`}
        dir={SIDE_DRAG[side]}
        inherited={definedAt !== null && definedAt.name !== layer.bp.name}
      />
    );
  };

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
