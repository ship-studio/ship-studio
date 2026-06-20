/**
 * Text + background color controls. Each is a swatch that opens a popover with
 * the full ColorPicker (HEX/RGB/HSL/OKLCH). The picked color is written back as
 * an arbitrary Tailwind value in the SAME format the element already used
 * (match-existing) — OKLCH stays OKLCH, everything else defaults to hex — and
 * previewed live via inline color/background-color.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  arbitraryColorRaw,
  colorClassToken,
  colorFormatOf,
  colorResetSpec,
  readLayer,
  type ColorPrefix,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';
import { rgbaToCss, toFormat, toHex, toRgba, visibleHex } from '../../lib/color';
import { ColorPicker } from './ColorPicker';
import { ResettableLabel } from './ResettableLabel';

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
}: {
  label: string;
  css: string;
  prefix: ColorPrefix;
} & Props) {
  // Explicit arbitrary value at the active breakpoint (drives match-existing format
  // on save); otherwise fall back to the element's rendered color for display/seeding.
  const { value: explicit, definedAt } = readLayer(currentClass, layer, (s) =>
    arbitraryColorRaw(s, prefix)
  );
  const computedRaw = computed?.[css];
  const raw = explicit;
  const seed = explicit ?? computedRaw ?? '#000000';
  // A parent-renderable color for the chip (alpha-aware): the explicit value if
  // parseable (a `var()` isn't), else the element's visible computed color.
  const renderable =
    (explicit && toHex(explicit) ? explicit : null) ??
    (computedRaw && visibleHex(computedRaw) ? computedRaw : null);
  const swatch = renderable ? rgbaToCss(toRgba(renderable)) : null;

  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = 216;
    const H = 250;
    const M = 8;
    // Prefer opening to the LEFT of the swatch (panel hugs the right edge); fall
    // back to the right, then clamp fully inside the viewport on both axes.
    let left = r.left - W - M;
    if (left < M) left = r.right + M;
    left = Math.min(Math.max(M, left), window.innerWidth - W - M);
    const top = Math.min(Math.max(M, r.top), window.innerHeight - H - M);
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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handlePick = useCallback(
    (hex: string) => {
      // Match-existing: keep the element's current color format, else default hex.
      const fmt = raw ? colorFormatOf(raw) : 'hex';
      const cssColor = toFormat(hex, fmt);
      onApplyEnum(colorClassToken(prefix, cssColor), { [css]: cssColor });
    },
    [raw, prefix, css, onApplyEnum]
  );

  return (
    <div className="ss-edit-panel__control">
      <ResettableLabel
        label={label}
        definedAt={definedAt}
        active={layer.bp}
        onReset={() => onReset(colorResetSpec(prefix, css))}
      />
      <button
        ref={triggerRef}
        type="button"
        className="ss-color-swatch"
        title={`${label} color`}
        aria-label={`${label} color`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {swatch ? (
          <span className="ss-color-swatch__chip" style={{ background: swatch }} />
        ) : (
          <span className="ss-color-swatch__empty">—</span>
        )}
      </button>
      {open &&
        rect &&
        createPortal(
          <div ref={popRef} className="ss-color-popover" style={{ top: rect.top, left: rect.left }}>
            <ColorPicker value={seed} onChange={handlePick} />
          </div>,
          document.body
        )}
    </div>
  );
}
