/**
 * Color conversion for the visual editor's picker, built on `culori` (which,
 * unlike react-colorful, understands OKLCH). The picker surface works in hex;
 * these helpers convert to/from the format the user is viewing or that the
 * source already uses.
 */

import { converter, formatHex, formatHex8, formatHsl, formatRgb, parse } from 'culori';

export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'hsb' | 'oklch';

export const COLOR_FORMATS: { id: ColorFormat; label: string }[] = [
  { id: 'hex', label: 'Hex' },
  { id: 'rgb', label: 'RGB' },
  { id: 'hsl', label: 'HSL' },
  { id: 'hsb', label: 'HSB' },
  { id: 'oklch', label: 'OKLCH' },
];

/** Fixed dimensions used by all three colour-picker entry points. */
export const COLOR_PICKER_WIDTH = 320;
export const COLOR_PICKER_HEIGHT = 510;
export const COLOR_PICKER_GUTTER = 8;
export const COLOR_PICKER_POSITION_KEY = 'colorPickerFloatingPosition';
export const COLOR_PICKER_SIZE_KEY = 'colorPickerFloatingSize';

/** react-colorful's RGBA shape (r/g/b 0–255, a 0–1). */
export type Rgba = { r: number; g: number; b: number; a: number };

/** react-colorful's HSVA shape. H is 0–360; S and V are percentages. */
export type Hsva = { h: number; s: number; v: number; a: number };

const toOklch = converter('oklch');
const toHsv = converter('hsv');
const toRgb = converter('rgb');
const round = (n: number, p: number) => {
  const f = 10 ** p;
  return Math.round((n + Number.EPSILON) * f) / f;
};
const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const normalizeHue = (n: number) => {
  const normalized = n % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};
const hasAlpha = (a: number | undefined) => a !== undefined && a < 1;

function rgbaFromRgb(color: { r?: number; g?: number; b?: number; alpha?: number }): Rgba {
  return {
    r: clamp255((color.r ?? 0) * 255),
    g: clamp255((color.g ?? 0) * 255),
    b: clamp255((color.b ?? 0) * 255),
    a: clamp01(color.alpha ?? 1),
  };
}

/** Normalize any CSS color string to 6-digit hex, or null if unparseable
 *  (e.g. a `var(--x)` reference the picker can't resolve to a swatch). */
export function toHex(color: string): string | null {
  const c = parse(color);
  return c ? formatHex(c) : null;
}

/** Hex for a color, or null if unparseable OR fully transparent (so an unset/
 *  transparent computed background doesn't seed a misleading black swatch). */
export function visibleHex(color: string): string | null {
  const c = parse(color);
  if (!c || c.alpha === 0) return null;
  return formatHex(c);
}

/** Whether a parseable CSS color has any transparency. Unresolved values such
 *  as `var(--x)` return false because their rendered alpha is not known here. */
export function hasColorTransparency(color: string): boolean {
  const c = parse(color);
  return Boolean(c && (c.alpha ?? 1) < 1);
}

/** Any CSS color → react-colorful's {r,g,b,a}, falling back to opaque black. */
export function toRgba(color: string): Rgba {
  const c = parse(color);
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  return rgbaFromRgb(toRgb(c));
}

/** RGBA ↔ HSV conversion used by the HSB editor surface. */
export function rgbaToHsva(rgba: Rgba): Hsva {
  const hsv = toHsv({
    mode: 'rgb',
    r: clamp01(rgba.r / 255),
    g: clamp01(rgba.g / 255),
    b: clamp01(rgba.b / 255),
    alpha: clamp01(rgba.a),
  });

  return {
    h: normalizeHue(hsv.h ?? 0),
    s: clamp01(hsv.s ?? 0) * 100,
    v: clamp01(hsv.v ?? 0) * 100,
    a: clamp01(hsv.alpha ?? rgba.a),
  };
}

export function hsvaToRgba(hsva: Hsva): Rgba {
  const rgb = toRgb({
    mode: 'hsv',
    h: normalizeHue(hsva.h),
    s: clamp01(hsva.s / 100),
    v: clamp01(hsva.v / 100),
    alpha: clamp01(hsva.a),
  });
  return rgbaFromRgb(rgb);
}

/** Any CSS color → HSVA, falling back to opaque black when unresolved. */
export function toHsva(color: string): Hsva {
  return rgbaToHsva(toRgba(color));
}

/** HSVA → the canonical CSS representation used by preview and CSS writers. */
export function hsvaToCss(hsva: Hsva): string {
  return rgbaToCss(hsvaToRgba(hsva));
}

/** Clamp and normalize one HSVA channel without changing the other channels. */
export function updateHsvaChannel(hsva: Hsva, channel: keyof Hsva, value: number): Hsva {
  if (!Number.isFinite(value)) return hsva;
  if (channel === 'h') return { ...hsva, h: normalizeHue(value) };
  if (channel === 'a') return { ...hsva, a: clamp01(value) };
  return { ...hsva, [channel]: Math.max(0, Math.min(100, value)) };
}

/** {r,g,b,a} → a lossless `rgb()`/`rgba()` string the rest of the pipeline parses. */
export function rgbaToCss({ r, g, b, a }: Rgba): string {
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${round(a, 3)})` : `rgb(${r}, ${g}, ${b})`;
}

/** Normalize a typed/parsed color to a canonical `rgb()/rgba()` string (alpha
 *  preserved), or null if it can't be parsed. */
export function toCss(color: string): string | null {
  return parse(color) ? rgbaToCss(toRgba(color)) : null;
}

/** Format any CSS color into the given format, alpha-aware. Returns the input
 *  unchanged if it can't be parsed, so partial typing never wipes the picker. */
export function toFormat(color: string, fmt: ColorFormat): string {
  const c = parse(color);
  if (!c) return color;
  const a = c.alpha;
  if (fmt === 'hex') return hasAlpha(a) ? formatHex8(c) : formatHex(c);
  if (fmt === 'rgb') return formatRgb(c);
  if (fmt === 'hsl') return formatHsl(c);
  // HSB is an editor-only representation: never hand non-standard HSV syntax
  // to a consumer that may write this value into CSS or a Tailwind class.
  if (fmt === 'hsb') return hsvaToCss(toHsva(color));
  const o = toOklch(c);
  const base = `${round(o.l ?? 0, 3)} ${round(o.c ?? 0, 3)} ${round(o.h ?? 0, 1)}`;
  return hasAlpha(a) ? `oklch(${base} / ${round(a ?? 1, 3)})` : `oklch(${base})`;
}
