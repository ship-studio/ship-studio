/**
 * Conservative string surgery for an element's opening tag — set, update, or remove a
 * single attribute without disturbing the rest of the markup. Used by the Settings tab
 * to edit attributes; the result is written back via `apply_element_html` (drift-guarded).
 */

/** Index of the top-level `>` that closes the opening tag (quote-aware), or -1. */
function openTagEnd(html: string): number {
  if (html[0] !== '<') return -1;
  let quote = '';
  for (let i = 1; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') return i;
  }
  return -1;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return `html` with attribute `name` set to `value` (added if absent, updated if
 * present), or removed when `value === null`. Returns null if the opening tag can't be
 * parsed. Quote-aware; preserves the rest of the element verbatim.
 */
export function setAttribute(html: string, name: string, value: string | null): string | null {
  const gt = openTagEnd(html);
  if (gt < 0) return null;
  const selfClose = html[gt - 1] === '/';
  // The opening tag's interior (tag name + attrs), without `<`, `>`, or a `/`.
  const inner = html.slice(1, selfClose ? gt - 1 : gt);
  const tail = html.slice(gt + 1);
  // ` name` or ` name=<value>` (value quoted or bare). Leading whitespace is required so
  // we never match inside the tag name.
  const attrRe = new RegExp(
    `\\s+${escapeRegExp(name)}(\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`,
    'i'
  );

  let nextInner: string;
  if (value === null) {
    nextInner = inner.replace(attrRe, '').replace(/\s+$/, '');
  } else {
    const attrStr = `${name}="${value.replace(/"/g, '&quot;')}"`;
    nextInner = attrRe.test(inner)
      ? inner.replace(attrRe, ` ${attrStr}`)
      : `${inner.replace(/\s+$/, '')} ${attrStr}`;
  }
  return `<${nextInner}${selfClose ? ' />' : '>'}${tail}`;
}
