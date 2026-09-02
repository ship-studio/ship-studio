/**
 * Opacity control: a 0–100 slider that writes the Tailwind `opacity-N` utility at
 * the active breakpoint. Reads the effective value across the cascade so it shows
 * the inherited/overridden value at the current layer.
 */

import {
  scaleValue,
  spacingResetSpec,
  readLayer,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';
import { ResettableLabel } from './ResettableLabel';
import { ValueField } from '../primitives/ValueField';

interface Props {
  currentClass: string;
  layer: LayerContext;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onReset: (spec: ResetSpec) => void;
}

const ARBITRARY_OPACITY = /^opacity-\[(\d*\.?\d+)\]$/;

/** Opacity 0–100 from a class string: the `opacity-N` scale token, or the
 *  arbitrary `opacity-[0.375]` form an off-scale value is written as. */
export function opacityPercent(className: string): number | null {
  const scale = scaleValue(className, 'opacity');
  if (scale !== null) return scale;
  for (const token of className.split(/\s+/)) {
    const match = ARBITRARY_OPACITY.exec(token);
    if (!match) continue;
    const percent = Number(match[1]) * 100;
    if (Number.isFinite(percent)) return Math.round(percent * 100) / 100;
  }
  return null;
}

/** The class for an opacity percentage. Tailwind only generates `opacity-N` for
 *  whole numbers — `opacity-37.5` is never emitted, so the style would silently
 *  disappear on save. Off-scale values go through the arbitrary-value form. */
export function opacityToken(percent: number): string {
  if (Number.isInteger(percent)) return `opacity-${percent}`;
  return `opacity-[${Number((percent / 100).toFixed(4))}]`;
}

export function OpacityControl({ currentClass, layer, onApplyEnum, onReset }: Props) {
  const opacity = readLayer(currentClass, layer, opacityPercent);
  return (
    <div className="ss-edit-panel__control">
      <ResettableLabel
        label="Opacity"
        definedAt={opacity.definedAt}
        active={layer.bp}
        onReset={() => onReset(spacingResetSpec('opacity', 'opacity'))}
      />
      <div className="ss-edit-panel__range-value">
        <input
          type="range"
          className="ss-edit-panel__slider"
          aria-label="Opacity"
          min={0}
          max={100}
          step={5}
          value={opacity.value ?? 100}
          onChange={(e) => {
            const n = Number(e.target.value);
            onApplyEnum(opacityToken(n), { opacity: String(n / 100) });
          }}
        />
        <ValueField
          className="ss-edit-panel__text ss-edit-panel__opacity-value"
          variant="number"
          value={String(opacity.value ?? 100)}
          aria-label="Opacity value"
          inputMode="decimal"
          min={0}
          max={100}
          onCommit={(next) => {
            const n = Number(next.trim());
            if (!Number.isFinite(n) || n < 0 || n > 100) return false;
            onApplyEnum(opacityToken(n), { opacity: String(n / 100) });
            return true;
          }}
        />
      </div>
    </div>
  );
}
