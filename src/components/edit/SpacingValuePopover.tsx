import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import {
  parseSpacingInput,
  spacingDisplay,
  stepSpacingValue,
  type Side,
  type SpacingValue,
} from '../../lib/edit';
import { ValueField, type ValueFieldVariable } from '../primitives/ValueField';

/* The reference surface is sized as a proportion of the box behind it. Keep
   that relationship tied to the measured box rather than screenshot pixels. */
const SPACING_POPOVER_WIDTH_RATIO = 0.78;
const SPACING_POPOVER_HEIGHT_RATIO = 0.37;
const SPACING_POPOVER_FIELD_WIDTH_RATIO = 0.33;
const SPACING_POPOVER_FIELD_HEIGHT_RATIO = 0.215;
const SPACING_POPOVER_GUTTER = 8;

interface Position {
  top: number;
  left: number;
  width: number;
  height: number;
  fieldWidth: number;
  fieldHeight: number;
}

interface Props {
  anchor: HTMLElement;
  label: string;
  cssProp: string;
  side: Side;
  value: SpacingValue | null;
  /** Empty display for properties whose CSS initial value is not 0 (e.g. offsets). */
  emptyValue?: string;
  /** Project CSS custom properties offered by the value field picker. */
  variables?: ValueFieldVariable[];
  onSet: (value: SpacingValue) => void;
  onClose: () => void;
}

/** The value sent to ValueField. Scale values keep their compact numeric
 * display in the input and use px as the popup's explicit editing unit. */
function fieldValue(value: SpacingValue | null, emptyValue: string): string {
  return value?.kind === 'arbitrary'
    ? value.raw
    : value?.kind === 'theme'
      ? value.raw
      : value
        ? `${spacingDisplay(value)}px`
        : emptyValue;
}

export function SpacingValuePopover({
  anchor,
  label,
  cssProp,
  side,
  value,
  emptyValue = '0px',
  variables,
  onSet,
  onClose,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const initialValue = fieldValue(value, emptyValue);
  const latestValueRef = useRef(initialValue);
  const [position, setPosition] = useState<Position | null>(null);
  const allowNegative =
    cssProp === 'margin' || ['top', 'right', 'bottom', 'left'].includes(cssProp);

  useEffect(() => {
    latestValueRef.current = initialValue;
  }, [initialValue]);

  const commit = useCallback(
    (next: string) => {
      const normalized = next.trim();
      // Avoid turning an untouched scale utility into an arbitrary px utility,
      // and leave an unset side unset when the user simply dismisses the popup.
      if (normalized === initialValue) return true;
      if (value?.kind === 'scale' || value === null) {
        const scale = /^(-?\d+(?:\.\d+)?)px$/i.exec(normalized);
        if (scale && (allowNegative || Number(scale[1]) >= 0)) {
          onSet({ kind: 'scale', n: Number(scale[1]) });
          return true;
        }
      }
      const parsed = parseSpacingInput(normalized, cssProp, { allowNegative });
      if (parsed.kind === 'invalid') return false;
      onSet(parsed);
      return true;
    },
    [allowNegative, cssProp, initialValue, onSet, value]
  );

  const dismiss = useCallback(() => {
    commit(latestValueRef.current);
    onClose();
  }, [commit, onClose]);

  const reposition = useCallback(() => {
    const rect = anchor.getBoundingClientRect();
    const boxRect = anchor.closest<HTMLElement>('.ss-box')?.getBoundingClientRect() ?? rect;
    const width = Math.min(
      boxRect.width * SPACING_POPOVER_WIDTH_RATIO,
      Math.max(1, window.innerWidth - SPACING_POPOVER_GUTTER * 2)
    );
    const height = Math.min(
      boxRect.height * SPACING_POPOVER_HEIGHT_RATIO,
      Math.max(1, window.innerHeight - SPACING_POPOVER_GUTTER * 2)
    );
    const fieldWidth = boxRect.width * SPACING_POPOVER_FIELD_WIDTH_RATIO;
    const fieldHeight = boxRect.height * SPACING_POPOVER_FIELD_HEIGHT_RATIO;
    const maxLeft = Math.max(
      SPACING_POPOVER_GUTTER,
      window.innerWidth - width - SPACING_POPOVER_GUTTER
    );
    const maxTop = Math.max(
      SPACING_POPOVER_GUTTER,
      window.innerHeight - height - SPACING_POPOVER_GUTTER
    );
    const centeredLeft = Math.max(
      SPACING_POPOVER_GUTTER,
      Math.min(boxRect.left + boxRect.width / 2 - width / 2, maxLeft)
    );
    const centeredTop = Math.max(
      SPACING_POPOVER_GUTTER,
      Math.min(boxRect.top + boxRect.height / 2 - height / 2, maxTop)
    );
    const above = { top: boxRect.top - height - SPACING_POPOVER_GUTTER, left: centeredLeft };
    const below = { top: boxRect.bottom + SPACING_POPOVER_GUTTER, left: centeredLeft };
    const right = { top: centeredTop, left: boxRect.right + SPACING_POPOVER_GUTTER };
    const left = { top: centeredTop, left: boxRect.left - width - SPACING_POPOVER_GUTTER };
    const candidates =
      side === 'top'
        ? [above, below, right, left]
        : side === 'bottom'
          ? [below, above, right, left]
          : side === 'right'
            ? [right, left, above, below]
            : [left, right, above, below];
    const clearsBox = (candidate: (typeof candidates)[number]) =>
      candidate.left + width <= boxRect.left - SPACING_POPOVER_GUTTER ||
      candidate.left >= boxRect.right + SPACING_POPOVER_GUTTER ||
      candidate.top + height <= boxRect.top - SPACING_POPOVER_GUTTER ||
      candidate.top >= boxRect.bottom + SPACING_POPOVER_GUTTER;
    const fitsViewport = (candidate: (typeof candidates)[number]) =>
      candidate.left >= SPACING_POPOVER_GUTTER &&
      candidate.left + width <= window.innerWidth - SPACING_POPOVER_GUTTER &&
      candidate.top >= SPACING_POPOVER_GUTTER &&
      candidate.top + height <= window.innerHeight - SPACING_POPOVER_GUTTER;
    // Prefer the side associated with the clicked value, but fall back to the
    // first visible collision-free side. If the viewport is too short, keep a
    // collision-free off-screen placement rather than covering the box.
    const placement =
      candidates.find((candidate) => clearsBox(candidate) && fitsViewport(candidate)) ??
      candidates.find(clearsBox) ??
      above;
    setPosition({
      top: placement.top,
      left: placement.left,
      width,
      height,
      fieldWidth,
      fieldHeight,
    });
  }, [anchor, side]);

  useLayoutEffect(() => {
    // The fixed portal needs its anchor coordinates before the first paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronous geometry measurement for a fixed popover
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [reposition]);

  useDismissOnOutsidePointer(true, popoverRef, dismiss, {
    event: 'mousedown',
    isOutside: (target) => {
      if (anchor.contains(target)) return false;
      if (popoverRef.current?.contains(target)) return false;
      // ValueField's unit/variable menus are portaled siblings of this popup.
      return !(target as HTMLElement).closest?.('.value-field__menu');
    },
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dismiss]);

  if (!position) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className="ss-box__popover"
      role="dialog"
      aria-label={label}
      style={
        {
          top: position.top,
          left: position.left,
          width: position.width,
          height: position.height,
        } as CSSProperties
      }
    >
      <span className="ss-box__popover-label">{label}</span>
      <ValueField
        autoFocus
        className="ss-box__popover-value"
        style={{ width: position.fieldWidth, height: position.fieldHeight }}
        aria-label={label}
        variant="length"
        value={initialValue}
        variables={variables}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          const fine = value?.kind === 'arbitrary' ? 0.1 : 1;
          const step = event.shiftKey ? 10 : event.altKey ? fine : 1;
          onSet(stepSpacingValue(value, event.key === 'ArrowUp' ? step : -step, allowNegative));
        }}
        onValueChange={(next) => {
          latestValueRef.current = next;
        }}
        onCommit={commit}
        title={label}
      />
    </div>,
    document.body
  );
}
