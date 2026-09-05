/**
 * Webflow-style box-model spacing editor: an outer margin box wrapping an inner
 * padding box, each with an editable value on all four sides. The position
 * variant reuses that inner four-sided surface for top/right/bottom/left
 * offsets. Reads the current per-side value via the Tailwind cascade
 * (side > axis > all) and writes it on
 * change/scroll/drag. Values can be a Tailwind scale step (a bare integer) or any
 * valid CSS length (`10rem`, `50%`, `clamp(…)`). Manual entry happens in the
 * shared value-field popup so the compact box stays easy to scan. Live preview
 * + write-back are handled by the hook's `setBoxSide` / `setPositionSide`
 * callbacks.
 */

import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { SpacingValuePopover } from './SpacingValuePopover';
import { parseValueFieldVariable, type ValueFieldVariable } from '../primitives/ValueField';
import {
  boxSide,
  boxSideResetSpec,
  positionSide,
  positionSideResetSpec,
  readLayer,
  spacingDisplay,
  type BoxType,
  type ResetSpec,
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
type BoxControlType = BoxType | 'position';

interface FieldProps {
  value: SpacingValue | null;
  display: string;
  onSet: (v: SpacingValue) => void;
  label: string;
  className: string;
  dir: { axis: 'x' | 'y'; sign: 1 | -1 };
  allowNegative: boolean;
  /** Cascade state for the value tag. */
  state: 'default' | 'inherited' | 'modified' | 'variable';
  onReset?: () => void;
}

/** The numeric magnitude a drag/scroll scrubs, plus how to rebuild a value from a
 *  new magnitude. Null when the value can't be stepped (e.g. `calc(…)`). */
function dragBaseOf(
  value: SpacingValue | null,
  allowNegative: boolean
): { magnitude: number; build: (m: number) => SpacingValue } | null {
  if (!value || value.kind === 'scale') {
    const mag = value?.kind === 'scale' ? value.n : 0;
    return {
      magnitude: mag,
      build: (m) => ({
        kind: 'scale',
        n: allowNegative ? Math.round(m) : Math.max(0, Math.round(m)),
      }),
    };
  }
  if (value.kind === 'theme') {
    const match = /^(-?\d*\.?\d+)(.*)$/.exec(value.raw.trim());
    if (!match) return null;
    const unit = match[2];
    return {
      magnitude: parseFloat(match[1]),
      build: (m) => ({
        kind: 'arbitrary',
        raw: `${allowNegative ? m : Math.max(0, m)}${unit}`,
      }),
    };
  }
  const match = /^(-?\d*\.?\d+)(.*)$/.exec(value.raw.trim());
  if (!match) return null;
  const unit = match[2];
  return {
    magnitude: parseFloat(match[1]),
    build: (m) => ({ kind: 'arbitrary', raw: `${allowNegative ? m : Math.max(0, m)}${unit}` }),
  };
}

function useSpacingDrag<T extends HTMLElement>(
  value: SpacingValue | null,
  onSet: (v: SpacingValue) => void,
  dir: FieldProps['dir'],
  allowNegative: boolean,
  onClick: (target: T, altKey: boolean) => void
) {
  const drag = useRef<{ x: number; y: number; base: ReturnType<typeof dragBaseOf> } | null>(null);
  const dragged = useRef(false);
  const suppressClick = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<T>) => {
    if (e.button !== 0) return;
    suppressClick.current = false;
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, base: dragBaseOf(value, allowNegative) };
    dragged.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<T>) => {
    const d = drag.current;
    if (!d || !d.base) return;
    const along = dir.axis === 'x' ? e.clientX - d.x : e.clientY - d.y;
    if (!dragged.current && Math.abs(along) < 3) return;
    dragged.current = true;
    const next = d.base.magnitude + dir.sign * Math.round(along / DRAG_SENSITIVITY);
    onSet(d.base.build(next));
  };

  const onPointerUp = (e: ReactPointerEvent<T>) => {
    const wasClick = drag.current && !dragged.current;
    drag.current = null;
    if (wasClick) {
      // Pointerdown prevents the browser's default focus/click path so a click
      // can be distinguished from a scrub. Ignore the synthetic click when an
      // engine still dispatches one, while leaving keyboard clicks available.
      suppressClick.current = true;
      onClick(e.currentTarget, e.altKey);
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
  };

  const onPointerCancel = () => {
    drag.current = null;
    suppressClick.current = false;
  };

  const handleClick = (e: ReactMouseEvent<T>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onClick(e.currentTarget, e.altKey);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick: handleClick };
}

/**
 * One side value. Four ways to change it:
 *  - drag along the bar's own axis (pulls outward to grow) — like a design tool,
 *  - scroll to scrub,
 *  - ArrowUp/Down to step (Shift ×10, Alt fine),
 *  - click to open the full value editor popup.
 */
function SideField({
  value,
  display,
  label,
  className,
  dir,
  allowNegative,
  state,
  onSet,
  onReset,
  open,
  onOpen,
}: FieldProps & { open: boolean; onOpen: (target: HTMLButtonElement) => void }) {
  const dragHandlers = useSpacingDrag<HTMLButtonElement>(
    value,
    onSet,
    dir,
    allowNegative,
    (target, altKey) => {
      if (altKey && onReset) {
        onReset();
        return;
      }
      onOpen(target);
    }
  );

  return (
    <button
      type="button"
      className={`ss-box__field ${className} ss-box__field--${state}${
        open ? ' ss-box__field--open' : ''
      }`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={`${label} (drag or click to edit${onReset ? ', Alt-click to reset' : ''})`}
      {...dragHandlers}
    >
      {display}
    </button>
  );
}

interface BandProps {
  type: BoxControlType;
  side: Side;
  value: SpacingValue | null;
  onSet: (v: SpacingValue) => void;
  onOpen: (target: HTMLDivElement) => void;
}

function PanelBand({ type, side, value, onSet, onOpen }: BandProps) {
  const dragHandlers = useSpacingDrag<HTMLDivElement>(
    value,
    onSet,
    SIDE_DRAG[side],
    type === 'position' || type === 'margin',
    onOpen
  );

  return (
    <div
      className={`ss-box__band ss-box__band--${side}`}
      aria-hidden="true"
      data-box-type={type}
      data-box-side={side}
      {...dragHandlers}
    />
  );
}

interface Props {
  currentClass: string;
  /** Active breakpoint layer — sides read their effective value across the cascade. */
  layer: LayerContext;
  onSetSide: (type: BoxType, side: Side, value: SpacingValue) => void;
  onReset: (spec: ResetSpec) => void;
  /** Position variant uses the same four-sided interaction model with top/right/bottom/left. */
  variant?: 'spacing' | 'position';
  onSetPositionSide?: (side: Side, value: SpacingValue) => void;
  /** Project CSS custom properties offered by the popup value fields. */
  variables?: ValueFieldVariable[];
}

interface OpenField {
  type: BoxControlType;
  side: Side;
  anchor: HTMLElement;
}

function sideLabel(type: BoxType, side: Side): string {
  return `${type === 'padding' ? 'Padding' : 'Margin'} ${side}`;
}

function positionSideLabel(side: Side): string {
  return side.replace(/^./, (letter) => letter.toUpperCase());
}

function variableName(value: SpacingValue | null): string | null {
  return value?.kind === 'arbitrary' ? parseValueFieldVariable(value.raw) : null;
}

function spacingFieldDisplay(value: SpacingValue | null): string {
  return variableName(value) ?? spacingDisplay(value);
}

function positionDisplay(value: SpacingValue | null): string {
  if (!value || (value.kind === 'arbitrary' && value.raw.toLowerCase() === 'auto')) return 'Auto';
  return spacingFieldDisplay(value);
}

function sideResetSpec(type: BoxControlType, side: Side, layer: LayerContext): ResetSpec {
  return type === 'position'
    ? positionSideResetSpec(side, layer.utilityPrefix, layer)
    : boxSideResetSpec(type, side, layer.utilityPrefix);
}

function popoverLabel(type: BoxControlType, side: Side): string {
  const label = type === 'position' ? positionSideLabel(side) : sideLabel(type, side);
  return label.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function SpacingBox({
  currentClass,
  layer,
  onSetSide,
  onReset,
  variant = 'spacing',
  onSetPositionSide,
  variables,
}: Props) {
  const [openField, setOpenField] = useState<OpenField | null>(null);
  const isPosition = variant === 'position';
  const sideData = (type: BoxControlType, side: Side) =>
    readLayer(currentClass, layer, (s) =>
      type === 'position' ? positionSide(s, side, layer) : boxSide(s, type, side, layer)
    );
  const setSide = (type: BoxControlType, side: Side, value: SpacingValue) => {
    if (type === 'position') {
      onSetPositionSide?.(side, value);
      return;
    }
    onSetSide(type, side, value);
  };

  const field = (type: BoxControlType, side: Side, edge: string) => {
    const { value, definedAt } = sideData(type, side);
    const modified = definedAt?.name === layer.bp.name;
    const state = variableName(value)
      ? 'variable'
      : definedAt === null
        ? 'default'
        : modified
          ? 'modified'
          : 'inherited';
    return (
      <SideField
        value={value}
        display={type === 'position' ? positionDisplay(value) : spacingFieldDisplay(value)}
        onSet={(next) => setSide(type, side, next)}
        label={type === 'position' ? positionSideLabel(side) : sideLabel(type, side)}
        className={`ss-box__edge--${edge}`}
        dir={SIDE_DRAG[side]}
        allowNegative={type === 'position' || type === 'margin'}
        state={state}
        onReset={modified ? () => onReset(sideResetSpec(type, side, layer)) : undefined}
        open={openField?.type === type && openField.side === side}
        onOpen={(anchor) => setOpenField({ type, side, anchor })}
      />
    );
  };

  const band = (type: BoxControlType, side: Side) => {
    const { value } = sideData(type, side);
    return (
      <PanelBand
        type={type}
        side={side}
        value={value}
        onSet={(next) => setSide(type, side, next)}
        onOpen={(anchor) => setOpenField({ type, side, anchor })}
      />
    );
  };

  return (
    <div
      className={`ss-box${isPosition ? ' ss-box--position' : ''}`}
      data-testid={isPosition ? 'position-box' : 'spacing-box'}
    >
      {isPosition ? (
        <>
          <div className="ss-box__padding" aria-hidden="true">
            {band('position', 'top')}
            {band('position', 'right')}
            {band('position', 'bottom')}
            {band('position', 'left')}
          </div>
          {field('position', 'top', 't')}
          {field('position', 'bottom', 'b')}
          {field('position', 'left', 'l')}
          {field('position', 'right', 'r')}
          <div className="ss-box__core" />
        </>
      ) : (
        <>
          <span className="ss-box__tag">MARGIN</span>
          <div className="ss-box__margin" aria-hidden="true">
            {band('margin', 'top')}
            {band('margin', 'right')}
            {band('margin', 'bottom')}
            {band('margin', 'left')}
          </div>
          {field('margin', 'top', 't')}
          {field('margin', 'bottom', 'b')}
          {field('margin', 'left', 'l')}
          {field('margin', 'right', 'r')}

          <div className="ss-box__inner">
            <span className="ss-box__tag">PADDING</span>
            <div className="ss-box__padding" aria-hidden="true">
              {band('padding', 'top')}
              {band('padding', 'right')}
              {band('padding', 'bottom')}
              {band('padding', 'left')}
            </div>
            {field('padding', 'top', 't')}
            {field('padding', 'bottom', 'b')}
            {field('padding', 'left', 'l')}
            {field('padding', 'right', 'r')}
            <div className="ss-box__core" />
          </div>
        </>
      )}

      {openField && (
        <SpacingValuePopover
          key={`${openField.type}-${openField.side}`}
          anchor={openField.anchor}
          label={popoverLabel(openField.type, openField.side)}
          cssProp={openField.type === 'position' ? openField.side : openField.type}
          emptyValue={openField.type === 'position' ? 'auto' : '0px'}
          side={openField.side}
          value={sideData(openField.type, openField.side).value}
          variables={variables}
          onSet={(next) => setSide(openField.type, openField.side, next)}
          onClose={() =>
            setOpenField((current) =>
              current?.type === openField.type && current.side === openField.side ? null : current
            )
          }
        />
      )}
    </div>
  );
}
