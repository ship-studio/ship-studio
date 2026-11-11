import { readLayer, tailwindUtilityParts, type LayerContext } from './edit';

/** Returns true for one complete `url(...)` image value, with no other layers. */
export function isSimpleCssBackgroundUrl(value: string): boolean {
  const source = value.trim();
  const open = /^url\s*\(/i.exec(source);
  if (!open) return false;
  let index = open[0].length;
  let quote = '';
  let depth = 1;
  while (index < source.length) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 2;
      else if (char === quote) {
        quote = '';
        index += 1;
      } else index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return (
          source.slice(open[0].length, index).trim().length > 0 &&
          source.slice(index + 1).trim() === ''
        );
      }
    }
    index += 1;
  }
  return false;
}

/** Read a Tailwind arbitrary background-image value from one breakpoint layer.
 * Complex values are returned intact so the control can preserve layered CSS. */
export function backgroundImageFromTokens(tokens: string, utilityPrefix?: string): string | null {
  for (const token of tokens.split(/\s+/)) {
    const parts = tailwindUtilityParts(token, utilityPrefix);
    if (!parts || parts.negative) continue;
    if (parts.base === 'bg-none') return 'none';
    if (!parts.base.startsWith('bg-[') || !parts.base.endsWith(']')) continue;

    let value = parts.base.slice('bg-['.length, -1);
    if (value.startsWith('image:')) value = value.slice('image:'.length);
    else if (
      value.startsWith('color:') ||
      value.startsWith('position:') ||
      value.startsWith('size:')
    ) {
      continue;
    }

    if (!isBackgroundImageValue(value)) continue;
    return decodeTailwindImageValue(value);
  }
  return null;
}

/** Resolve the authored image utility at the active width, then use the preview
 * snapshot for image values authored in CSS or another source. */
export function backgroundImageForLayer(
  currentClass: string,
  layer: LayerContext,
  computed?: string,
  baselineClass?: string
): string | undefined {
  const readImage = (className: string) =>
    readLayer(className, layer, (tokens) => backgroundImageFromTokens(tokens, layer.utilityPrefix))
      .value;
  const currentImage = readImage(currentClass);
  if (currentImage != null) return currentImage;

  // A class edit can remove the active layer's image utility. The computed style
  // snapshot was captured at selection time, so falling back to it would paint
  // the removed image back into the swatch until the element is reselected.
  const removedBaselineImage = baselineClass != null && readImage(baselineClass) != null;
  return removedBaselineImage ? undefined : computed;
}

function isBackgroundImageValue(value: string): boolean {
  return /^(?:none|url\s*\(|(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(|image-set\s*\(|cross-fade\s*\(|element\s*\(|var\s*\()/i.test(
    value.trim()
  );
}

/** Tailwind maps underscores to spaces in arbitrary values, except inside URLs
 * and quoted strings where an underscore is part of the authored value. */
function decodeTailwindImageValue(value: string): string {
  let decoded = '';
  let index = 0;
  let depth = 0;
  let urlDepth: number | null = null;
  let quote = '';

  while (index < value.length) {
    const char = value[index];
    if (char === '\\') {
      const next = value[index + 1];
      if (next === '_') {
        decoded += '_';
        index += 2;
      } else {
        decoded += char + (next ?? '');
        index += next === undefined ? 1 : 2;
      }
      continue;
    }
    if (quote) {
      decoded += char;
      if (char === quote) quote = '';
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      decoded += char;
      index += 1;
      continue;
    }
    const url = urlDepth === null ? /^url\s*\(/i.exec(value.slice(index)) : null;
    // An underscore immediately before `url(` is Tailwind's encoded space,
    // so it still begins a URL token. Preserve URL underscores once inside.
    if (url && (index === 0 || !/[A-Za-z0-9-]/.test(value[index - 1]))) {
      decoded += url[0];
      depth += 1;
      urlDepth = depth;
      index += url[0].length;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (urlDepth === depth) urlDepth = null;
      depth = Math.max(0, depth - 1);
    }
    decoded += char === '_' && urlDepth === null ? ' ' : char;
    index += 1;
  }
  return decoded;
}

/** Quote a URL as one CSS url() value while preserving it as data. */
export function cssUrlValue(url: string): string {
  return `url("${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

/** Build a Tailwind arbitrary background-image class from an already encoded URL. */
export function tailwindBackgroundUrlToken(url: string): string {
  return `bg-[url(${url})]`;
}
