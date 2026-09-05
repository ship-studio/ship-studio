/**
 * Text + background color controls. Each is a swatch that opens a popover with
 * the full ColorPicker (HEX/RGB/HSL/HSB/OKLCH). The picked colour is written
 * back as an arbitrary Tailwind value in the format selected in the picker and
 * previewed live via inline color/background-color.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import {
  arbitraryColorRaw,
  colorClassToken,
  colorResetSpec,
  readLayer,
  type ColorPrefix,
  type InheritedProp,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';
import {
  COLOR_PICKER_GUTTER,
  COLOR_PICKER_HEIGHT,
  COLOR_PICKER_POSITION_KEY,
  COLOR_PICKER_SIZE_KEY,
  COLOR_PICKER_WIDTH,
  hasColorTransparency,
  rgbaToCss,
  toHex,
  toRgba,
  visibleHex,
} from '../../lib/color';
import { ColorPicker } from './ColorPicker';
import { ResettableLabel } from './ResettableLabel';
import { DockablePanel } from '../primitives/DockablePanel';
import {
  parseValueFieldVariable,
  ValueField,
  type ValueFieldVariable,
} from '../primitives/ValueField';
import { toCss, toFormat, type ColorFormat } from '../../lib/color';

interface Props {
  currentClass: string;
  /** Active breakpoint layer — the explicit color is read across the cascade. */
  layer: LayerContext;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  /** Clear a color at the active breakpoint. */
  onReset: (spec: ResetSpec) => void;
  /** Rendered colors from getComputedStyle, keyed by CSS property ('color',
   *  'background-color'), used to seed the picker when there's no explicit
   *  arbitrary value in the class. */
  computed?: Record<string, string | undefined>;
  variables?: ValueFieldVariable[];
  /** Ancestor-defined value for this color (text color inherits). */
  inherited?: InheritedProp | null;
  projectPath?: string;
  onOpenInCode?: (file: string, line: number) => void;
}

function formatForValue(value: string): ColorFormat {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith('oklch')) return 'oklch';
  if (normalized.startsWith('hsl')) return 'hsl';
  if (normalized.startsWith('rgb')) return 'rgb';
  return 'hex';
}

/** Resolve a simple color custom-property reference from the Variables panel's
 * authoritative source values. Aliases are followed recursively and cycles fail
 * closed so an unresolved token never becomes a misleading black swatch. */
export function resolveVariableColor(
  value: string,
  variables: ValueFieldVariable[] | undefined
): string | null {
  let current = value.trim();
  const seen = new Set<string>();

  while (true) {
    const name = parseValueFieldVariable(current);
    if (!name) return toHex(current) ? current : null;
    if (seen.has(name)) return null;
    seen.add(name);
    const resolved = variables?.find((variable) => variable.name === name)?.value?.trim();
    if (!resolved) return null;
    current = resolved;
  }
}

/** One color control (text / background / border …): a swatch + popover picker.
 *  Exported so the control registry can place each color in its own section. */
export function ColorField({
  label,
  css,
  prefix,
  currentClass,
  layer,
  onApplyEnum,
  onReset,
  computed,
  variables,
  inherited = null,
  projectPath,
  onOpenInCode,
}: {
  label: string;
  css: string;
  prefix: ColorPrefix;
} & Props) {
  // Explicit arbitrary value at the active breakpoint; otherwise fall back to
  // the element's rendered color for display/seeding.
  const { value: explicit, definedAt } = readLayer(currentClass, layer, (s) =>
    arbitraryColorRaw(s, prefix, layer.utilityPrefix)
  );
  const computedRaw = computed?.[css];
  const resolvedExplicit = explicit ? resolveVariableColor(explicit, variables) : null;
  const seed = resolvedExplicit ?? computedRaw ?? '#000000';
  // A parent-renderable color for the chip (alpha-aware): the explicit value if
  // parseable or resolvable through project variables, else the element's visible
  // computed color.
  const renderable =
    resolvedExplicit ?? (computedRaw && visibleHex(computedRaw) ? computedRaw : null);
  const swatch = renderable ? rgbaToCss(toRgba(renderable)) : null;
  const hasValue = explicit !== null || Boolean(computedRaw?.trim());
  const showCheckerboard = !hasValue || Boolean(renderable && hasColorTransparency(renderable));
  const chipClassName = [
    'ss-color-swatch__chip',
    showCheckerboard ? 'ss-color-swatch__chip--checkerboard' : null,
  ]
    .filter(Boolean)
    .join(' ');
  const [format, setFormat] = useState<ColorFormat>(() => formatForValue(seed));

  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = COLOR_PICKER_WIDTH;
    const H = COLOR_PICKER_HEIGHT;
    const M = COLOR_PICKER_GUTTER;
    // Prefer opening to the LEFT of the swatch (panel hugs the right edge); fall
    // back to the right, then clamp fully inside the viewport on both axes.
    let left = r.left - W - M;
    if (left < M) left = r.right + M;
    left = Math.min(Math.max(M, left), Math.max(M, window.innerWidth - W - M));
    const maxTop = Math.max(M, window.innerHeight - H - M);
    const top = Math.min(Math.max(M, r.top), maxTop);
    setRect({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  useDismissOnOutsidePointer(open, popRef, () => setOpen(false), {
    isOutside: (t) =>
      !triggerRef.current?.contains(t) &&
      !popRef.current?.contains(t) &&
      !(t as HTMLElement).closest?.('.ss-color-picker__format-menu'),
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.ss-color-picker__format-menu')) return;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const handlePick = useCallback(
    (cssColor: string) => {
      onApplyEnum(colorClassToken(prefix, cssColor), { [css]: cssColor });
    },
    [prefix, css, onApplyEnum]
  );

  // "Set here explicitly": prefer the attributed palette token (`text-red-500`);
  // without one, write the actual color as an arbitrary value via the picker path.
  const adopt = inherited
    ? () => {
        if (inherited.token) onApplyEnum(inherited.token, { [css]: inherited.cssValue });
        else handlePick(inherited.cssValue);
      }
    : undefined;

  const handleTextCommit = useCallback(
    (next: string) => {
      const raw = next.trim();
      if (!raw) return false;
      const parsed = toCss(raw);
      if (!parsed && !/^var\(/i.test(raw)) return false;
      handlePick(parsed ? toFormat(raw, format) : raw);
      return true;
    },
    [format, handlePick]
  );

  // Switching HEX/RGB/HSL/OKLCH only changes how the current value is DISPLAYED
  // and how the next committed value is written. It must never apply a color:
  // with no explicit value that would write the `#000000` fallback into source,
  // and with only a computed value it would silently promote the browser's
  // rendered color into an explicit class the user never chose.
  const handleFormatChange = useCallback((next: string) => {
    setFormat(next as ColorFormat);
  }, []);

  // The field shows the current value re-rendered in the selected format —
  // purely cosmetic until the user actually commits something.
  const fieldValue = useMemo(() => {
    const raw = (explicit ?? computedRaw ?? '').trim();
    if (!raw || /^var\(/i.test(raw)) return raw;
    return toCss(raw) ? toFormat(raw, format) : raw;
  }, [computedRaw, explicit, format]);

  return (
    <div className="ss-edit-panel__control">
      <ResettableLabel
        label={label}
        definedAt={definedAt}
        active={layer.bp}
        onReset={() => onReset(colorResetSpec(prefix, css, layer.utilityPrefix))}
        inherited={inherited}
        onAdopt={adopt}
        projectPath={projectPath}
        onOpenInCode={onOpenInCode}
      />
      <div className="ss-color-field">
        <ValueField
          className="ss-edit-panel__text ss-color-field__value"
          variant="color"
          value={fieldValue}
          variables={variables}
          format={format}
          onFormatChange={handleFormatChange}
          onCommit={handleTextCommit}
          aria-label={`${label} value`}
          placeholder="#000000"
          title={`${label} value`}
          leading={
            <button
              ref={triggerRef}
              type="button"
              className="ss-color-swatch ss-color-swatch--embedded"
              title={`${label} color picker`}
              aria-label={`${label} color`}
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <span className={chipClassName} aria-hidden="true">
                {swatch && (
                  <span className="ss-color-swatch__color" style={{ backgroundColor: swatch }} />
                )}
              </span>
            </button>
          }
        />
      </div>
      {open && rect && (
        <DockablePanel
          docked={false}
          ariaLabel="Color picker"
          positionKey={COLOR_PICKER_POSITION_KEY}
          sizeKey={COLOR_PICKER_SIZE_KEY}
          floatingSize={{ width: COLOR_PICKER_WIDTH, height: COLOR_PICKER_HEIGHT }}
          initialPosition={() => ({ left: rect.left, top: rect.top })}
          resizable={false}
          surfaceClassName="ss-color-picker__floating-surface"
        >
          <div ref={popRef} className="ss-color-picker__floating-content">
            <ColorPicker
              value={seed}
              onChange={handlePick}
              onClose={() => {
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }}
            />
          </div>
        </DockablePanel>
      )}
    </div>
  );
}
