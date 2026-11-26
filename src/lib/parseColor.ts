/**
 * The only way app code should turn a string into a culori color.
 *
 * culori's `parse` is documented to return `undefined` for anything that is not
 * a color, and every caller here relies on that. It does not always: culori
 * 4.0.2's tokenizer pushes `undefined` into its token list for a dimension that
 * is not an angle (`4px`, `1rem`), and the modern-syntax reader then dereferences
 * that token. So any function-shaped value carrying a length, such as
 * `translateY(-4px)`, `blur(4px)` or `rgb(10px 0 0)`, throws a TypeError instead
 * of returning `undefined`.
 *
 * The visual editor feeds this function every CSS custom property on the page
 * to find out which ones are colors, and a project with one
 * `--lift: translateY(-4px)` took the whole app down when a color swatch was
 * clicked (#1211 / #1212). "Not a color" is the correct answer for all of these,
 * so this restores the contract the callers were written against.
 *
 * `pnpm lint` forbids importing `parse` from culori directly.
 */

import { parse, type Color } from 'culori';

export function parseColor(value: string): Color | undefined {
  try {
    return parse(value);
  } catch {
    return undefined;
  }
}
