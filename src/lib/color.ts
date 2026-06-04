/**
 * Color conversion for the visual editor's picker, built on `culori` (which,
 * unlike react-colorful, understands OKLCH). The picker surface works in hex;
 * these helpers convert to/from the format the user is viewing or that the
 * source already uses.
 */

import { converter, formatHex, formatHex8, formatHsl, formatRgb, parse } from 'culori';

export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'oklch';

export const COLOR_FORMATS: { id: ColorFormat; label: string }[] = [
  { id: 'hex', label: 'HEX' },
  { id: 'rgb', label: 'RGB' },
  { id: 'hsl', label: 'HSL' },
  { id: 'oklch', label: 'OKLCH' },
];

/** react-colorful's RGBA shape (r/g/b 0–255, a 0–1). */
export type Rgba = { r: number; g: number; b: number; a: number };

const toOklch = converter('oklch');
const toRgb = converter('rgb');
const round = (n: number, p: number) => {
  const f = 10 ** p;
  return Math.round((n + Number.EPSILON) * f) / f;
};
const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const hasAlpha = (a: number | undefined) => a !== undefined && a < 1;

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

/** Any CSS color → react-colorful's {r,g,b,a}, falling back to opaque black. */
export function toRgba(color: string): Rgba {
  const c = parse(color);
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  const r = toRgb(c);
  return {
    r: clamp255((r.r ?? 0) * 255),
    g: clamp255((r.g ?? 0) * 255),
    b: clamp255((r.b ?? 0) * 255),
    a: r.alpha ?? 1,
  };
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
  const o = toOklch(c);
  const base = `${round(o.l ?? 0, 3)} ${round(o.c ?? 0, 3)} ${round(o.h ?? 0, 1)}`;
  return hasAlpha(a) ? `oklch(${base} / ${round(a ?? 1, 3)})` : `oklch(${base})`;
}
