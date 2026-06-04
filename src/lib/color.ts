/**
 * Color conversion for the visual editor's picker, built on `culori` (which,
 * unlike react-colorful, understands OKLCH). The picker surface works in hex;
 * these helpers convert to/from the format the user is viewing or that the
 * source already uses.
 */

import { converter, formatHex, formatHsl, formatRgb, parse } from 'culori';

export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'oklch';

export const COLOR_FORMATS: { id: ColorFormat; label: string }[] = [
  { id: 'hex', label: 'HEX' },
  { id: 'rgb', label: 'RGB' },
  { id: 'hsl', label: 'HSL' },
  { id: 'oklch', label: 'OKLCH' },
];

const toOklch = converter('oklch');
const round = (n: number, p: number) => {
  const f = 10 ** p;
  return Math.round((n + Number.EPSILON) * f) / f;
};

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

/** Format any CSS color into the given format. Returns the input unchanged if it
 *  can't be parsed, so a partial value while typing never wipes the picker. */
export function toFormat(color: string, fmt: ColorFormat): string {
  const c = parse(color);
  if (!c) return color;
  if (fmt === 'hex') return formatHex(c);
  if (fmt === 'rgb') return formatRgb(c);
  if (fmt === 'hsl') return formatHsl(c);
  const o = toOklch(c);
  return `oklch(${round(o.l ?? 0, 3)} ${round(o.c ?? 0, 3)} ${round(o.h ?? 0, 1)})`;
}
