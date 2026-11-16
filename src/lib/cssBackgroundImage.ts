import { readLayer, tailwindUtilityParts, type LayerContext, type ResetSpec } from './edit';

export type BackgroundLayerKind = 'image' | 'linear' | 'radial' | 'solid';

export interface BackgroundLayer {
  id: string;
  kind: BackgroundLayerKind;
  value: string;
}

export interface BackgroundLayerSettings {
  size: string;
  position: string;
  repeat: string;
  attachment: string;
}

export type BackgroundResetProperty = keyof BackgroundLayerSettings | 'image';

export interface ParsedBackgroundStack {
  layers: BackgroundLayer[];
  reason?: string;
}

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundLayerSettings = {
  size: 'auto',
  position: '0% 0%',
  repeat: 'repeat',
  attachment: 'scroll',
};

/** Split a CSS comma list without splitting inside functions, strings or escapes. */
export function splitCssCommaList(value: string): string[] | null {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (char === ',' && depth === 0) {
      const item = value.slice(start, i).trim();
      if (!item) return null;
      items.push(item);
      start = i + 1;
    }
  }
  if (quote || depth !== 0) return null;
  const last = value.slice(start).trim();
  if (!last) return null;
  items.push(last);
  return items;
}

/** True for one complete url() image value, including commas within the URL. */
export function isSimpleCssBackgroundUrl(value: string): boolean {
  const source = value.trim();
  const open = /^url\s*\(/i.exec(source);
  if (!open) return false;
  let index = open[0].length;
  let quote = '';
  let depth = 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0)
        return !!source.slice(open[0].length, index).trim() && !source.slice(index + 1).trim();
    }
    index += 1;
  }
  return false;
}

/** Read a Tailwind arbitrary background-image value from one breakpoint layer. */
export function backgroundImageFromTokens(tokens: string, utilityPrefix?: string): string | null {
  for (const token of tokens.split(/\s+/)) {
    const parts = tailwindUtilityParts(token, utilityPrefix);
    if (!parts || parts.negative) continue;
    if (parts.base === 'bg-none') return 'none';
    const arbitraryProperty = /^\[background-image:(.*)\]!?$/.exec(parts.base);
    if (arbitraryProperty && isBackgroundImageValue(arbitraryProperty[1])) {
      return decodeTailwindImageValue(arbitraryProperty[1]);
    }
    if (!parts.base.startsWith('bg-[') || !parts.base.endsWith(']')) continue;
    let value = parts.base.slice(4, -1);
    if (value.startsWith('image:')) value = value.slice('image:'.length);
    else if (/^(?:color|position|size|length|repeat|attachment):/.test(value)) continue;
    if (!isBackgroundImageValue(value)) continue;
    return decodeTailwindImageValue(value);
  }
  return null;
}

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
  const removedBaselineImage = baselineClass != null && readImage(baselineClass) != null;
  return removedBaselineImage ? undefined : computed;
}

function isBackgroundImageValue(value: string): boolean {
  return /^(?:none|url\s*\(|(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(|image-set\s*\(|cross-fade\s*\(|element\s*\(|var\s*\()/i.test(
    value.trim()
  );
}

/** Decode Tailwind's underscore whitespace while retaining quoted/URL underscores. */
export function decodeTailwindImageValue(value: string): string {
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

/** Encode a CSS value for one Tailwind arbitrary value without changing URL data. */
export function encodeTailwindCssValue(value: string): string {
  let encoded = '';
  let urlDepth: number | null = null;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '\\') {
      encoded += char + (value[i + 1] ?? '');
      if (i + 1 < value.length) i += 1;
      continue;
    }
    if (quote) {
      encoded += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      encoded += char;
      continue;
    }
    const url = urlDepth === null ? /^url\s*\(/i.exec(value.slice(i)) : null;
    if (url) {
      encoded += url[0].replace(/\s/g, '_');
      depth += 1;
      urlDepth = depth;
      i += url[0].length - 1;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (urlDepth === depth) urlDepth = null;
      depth = Math.max(0, depth - 1);
    }
    if (char === ' ' || char === '\n' || char === '\t')
      encoded += urlDepth === null ? '_' : '\\000020';
    else if (char === '_' && urlDepth === null) encoded += '\\_';
    else encoded += char;
  }
  return encoded;
}

/** Parse supported image layers. Unknown CSS is deliberately read-only. */
export function parseBackgroundStack(value: string | undefined): ParsedBackgroundStack {
  const source = value?.trim() ?? '';
  if (!source || source === 'none') return { layers: [] };
  const values = splitCssCommaList(source);
  if (!values)
    return { layers: [], reason: 'This background value cannot be safely split into layers.' };
  const layers: BackgroundLayer[] = [];
  for (const [index, item] of values.entries()) {
    const lower = item.toLowerCase();
    if (isSimpleCssBackgroundUrl(item)) {
      layers.push({ id: `image-${index}`, kind: 'image', value: item });
    } else if (/^(?:repeating-)?linear-gradient\s*\(/i.test(item)) {
      const gradient = gradientArguments(item);
      if (!gradient) {
        return {
          layers: [],
          reason: `This gradient uses syntax the editor cannot safely round-trip: ${item.slice(0, 48)}`,
        };
      }
      const flatSolid =
        !/^repeating-/i.test(item) &&
        gradient?.prelude === '' &&
        gradient.stops.length === 2 &&
        gradient.stops[0].color === gradient.stops[1].color;
      layers.push({
        id: `${flatSolid ? 'solid' : 'linear'}-${index}`,
        kind: flatSolid ? 'solid' : 'linear',
        value: item,
      });
    } else if (/^(?:repeating-)?radial-gradient\s*\(/i.test(item)) {
      if (!gradientArguments(item)) {
        return {
          layers: [],
          reason: `This gradient uses syntax the editor cannot safely round-trip: ${item.slice(0, 48)}`,
        };
      }
      layers.push({ id: `radial-${index}`, kind: 'radial', value: item });
    } else if (!lower.includes('gradient(') && !/^var\s*\(/i.test(item) && isCssColorLike(item)) {
      layers.push({
        id: `solid-${index}`,
        kind: 'solid',
        value: `linear-gradient(${item}, ${item})`,
      });
    } else {
      return {
        layers: [],
        reason: `This layer uses CSS syntax the editor cannot safely round-trip: ${item.slice(0, 48)}`,
      };
    }
  }
  return { layers };
}

function isCssColorLike(value: string): boolean {
  const color = value.trim();
  if (/^#[\da-f]{3,8}$/i.test(color) || /^[a-z]+$/i.test(color)) return true;
  const fn =
    /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|device-cmyk|var)\s*\(/i.exec(
      color
    );
  return !!fn && color.endsWith(')') && splitCssCommaList(color.slice(fn[0].length, -1)) !== null;
}

/** Solid layers serialize as a flat gradient so they can stack above a base colour. */
export function serializeBackgroundStack(layers: BackgroundLayer[]): string {
  return layers
    .map((layer) => (layer.kind === 'solid' ? flatGradientColor(layer.value) : layer.value))
    .join(', ');
}

function flatGradientColor(value: string): string {
  const args = gradientArguments(value);
  if (args?.stops.length) return `linear-gradient(${args.stops[0].color}, ${args.stops[0].color})`;
  return value;
}

export interface GradientArguments {
  prelude: string;
  stops: Array<{ color: string; position: string }>;
}

export function gradientArguments(value: string): GradientArguments | null {
  const open = value.indexOf('(');
  if (open < 0 || !value.endsWith(')')) return null;
  const args = splitCssCommaList(value.slice(open + 1, -1));
  if (!args || args.length < 2) return null;
  const firstLooksColor = isCssColorLike(parseGradientStop(args[0]).color);
  const prelude = firstLooksColor ? '' : (args.shift() ?? '');
  const stops = args.map(parseGradientStop);
  if (stops.length < 2 || stops.some((stop) => !stop.color || !isCssColorLike(stop.color)))
    return null;
  return { prelude, stops };
}

function parseGradientStop(value: string): { color: string; position: string } {
  const stop = value.trim();
  const match =
    /^(.*\S)\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|px|rem|em|vh|vw|vmin|vmax|ch|lh))$/i.exec(stop);
  return match ? { color: match[1].trim(), position: match[2] } : { color: stop, position: '' };
}

/** Read the values of a comma-list property from authored Tailwind utilities. */
export function backgroundListFromTokens(
  tokens: string,
  property: keyof BackgroundLayerSettings,
  utilityPrefix?: string
): string[] | null {
  const explicitProperty = {
    size: 'background-size',
    position: 'background-position',
    repeat: 'background-repeat',
    attachment: 'background-attachment',
  }[property];
  const classes = tokens.split(/\s+/).filter(Boolean);
  for (const token of classes) {
    const parts = tailwindUtilityParts(token, utilityPrefix);
    if (!parts || parts.negative) continue;
    let value: string | null = null;
    const raw = parts.base;
    const arbitrary = /^\[(background-(?:size|position|repeat|attachment)):(.*)\]!?$/.exec(raw);
    if (arbitrary?.[1] === explicitProperty) value = decodeTailwindImageValue(arbitrary[2]);
    if (raw.startsWith('bg-[') && raw.endsWith(']')) {
      const content = raw.slice(4, -1);
      const colon = content.indexOf(':');
      const key = colon < 0 ? '' : content.slice(0, colon);
      const map: Record<string, keyof BackgroundLayerSettings> = {
        length: 'size',
        size: 'size',
        position: 'position',
        repeat: 'repeat',
        attachment: 'attachment',
      };
      if (map[key] === property) value = decodeTailwindImageValue(content.slice(colon + 1));
      else if (
        colon < 0 &&
        property === 'size' &&
        /^(?:auto|cover|contain|(?:\d*\.)?\d+(?:%|px|rem|em|vh|vw|vmin|vmax|ch|lh))(?:\s+(?:auto|(?:\d*\.)?\d+(?:%|px|rem|em|vh|vw|vmin|vmax|ch|lh)))?$/i.test(
          content
        )
      )
        value = decodeTailwindImageValue(content);
    }
    if (property === 'size' && ['bg-auto', 'bg-cover', 'bg-contain'].includes(raw)) {
      value = raw.slice(3);
    }
    if (property === 'size' && /^bg-size-(?:auto|cover|contain|\[.+\])$/.test(raw)) {
      value = decodeTailwindImageValue(raw.slice('bg-size-'.length).replace(/^\[(.*)\]$/, '$1'));
    }
    if (property === 'position' && /^bg-position-(?:\[.+\]|[-\w]+)$/.test(raw)) {
      value = raw
        .slice('bg-position-'.length)
        .replace(/^\[(.*)\]$/, '$1')
        .replace(/_/g, ' ');
    }
    if (
      property === 'position' &&
      /^bg-(?:center|top|right|bottom|left|left-top|right-top|left-bottom|right-bottom)$/.test(raw)
    ) {
      const position = raw.slice(3).replace('-', ' ');
      value =
        position === 'center'
          ? 'center'
          : position.replace(/^(left|right|top|bottom) (top|bottom|left|right)$/, '$1 $2');
    }
    if (
      property === 'repeat' &&
      /^bg-(?:repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space)$/.test(raw)
    ) {
      value = raw.slice(3).replace(/^repeat-(round|space)$/, '$1');
    }
    if (property === 'attachment' && /^bg-(?:fixed|local|scroll)$/.test(raw)) value = raw.slice(3);
    if (value !== null) return splitCssCommaList(value);
  }
  return null;
}

/** CSS repeats a short comma-list to match background-image layers. */
export function alignBackgroundValues(values: string[], count: number): string[] {
  if (count <= 0) return [];
  const source = values.length ? values : [DEFAULT_BACKGROUND_SETTINGS.size];
  return Array.from({ length: count }, (_, index) => source[index % source.length]);
}

/** Keep unused trailing CSS list values available for later layer additions. */
export function updateBackgroundLayerValue(
  values: string[],
  layerCount: number,
  index: number,
  value: string
): string[] {
  const active = alignBackgroundValues(values, layerCount);
  if (index >= 0 && index < active.length) active[index] = value;
  return [...active, ...values.slice(layerCount)];
}

/** Reorder effective list values while preserving CSS list repetition and dormant tail items. */
export function reorderBackgroundLayerValues(
  values: string[],
  layerCount: number,
  from: number,
  to: number
): string[] {
  const active = alignBackgroundValues(values, layerCount);
  if (from < 0 || to < 0 || from >= active.length || to >= active.length || from === to)
    return [...active, ...values.slice(layerCount)];
  const [value] = active.splice(from, 1);
  active.splice(to, 0, value);
  return [...active, ...values.slice(layerCount)];
}

/** Remove one effective layer value and retain list items that were beyond the old image count. */
export function removeBackgroundLayerValue(
  values: string[],
  layerCount: number,
  index: number
): string[] {
  const active = alignBackgroundValues(values, layerCount);
  if (index >= 0 && index < active.length) active.splice(index, 1);
  return [...active, ...values.slice(layerCount)];
}

/** Insert a new topmost image and keep existing layers' settings at their old indices. */
export function insertBackgroundLayerSettings(
  settings: Record<keyof BackgroundLayerSettings, string[]>,
  existingLayerCount: number
): Record<keyof BackgroundLayerSettings, string[]> {
  const next = {} as Record<keyof BackgroundLayerSettings, string[]>;
  for (const property of Object.keys(DEFAULT_BACKGROUND_SETTINGS) as Array<
    keyof BackgroundLayerSettings
  >) {
    const values = settings[property];
    if (existingLayerCount === 0) {
      next[property] = values.length ? [...values] : [DEFAULT_BACKGROUND_SETTINGS[property]];
      continue;
    }
    const existing = alignBackgroundValues(values, existingLayerCount);
    const dormant = values.slice(existingLayerCount);
    next[property] = [DEFAULT_BACKGROUND_SETTINGS[property], ...existing, ...dormant];
  }
  return next;
}

export function backgroundListToken(
  property: keyof BackgroundLayerSettings,
  values: string[]
): string {
  const cssProperty = {
    size: 'background-size',
    position: 'background-position',
    repeat: 'background-repeat',
    attachment: 'background-attachment',
  }[property];
  return `[${cssProperty}:${encodeTailwindCssValue(values.join(', '))}]`;
}

/** Reset only the active breakpoint's utility family for one background property. */
export function backgroundResetSpec(
  property: BackgroundResetProperty,
  utilityPrefix?: string
): ResetSpec {
  const cssProperty =
    property === 'image'
      ? 'background-image'
      : {
          size: 'background-size',
          position: 'background-position',
          repeat: 'background-repeat',
          attachment: 'background-attachment',
        }[property];
  return {
    match: (token) => {
      const base = tailwindUtilityParts(token, utilityPrefix)?.base;
      if (!base) return false;
      if (base.startsWith(`[${cssProperty}:`)) return true;
      if (base.startsWith('bg-[')) {
        const raw = base.slice(4, -1);
        const colon = raw.indexOf(':');
        const key = colon < 0 ? '' : raw.slice(0, colon);
        if (property === 'image') {
          return (
            key === 'image' ||
            key === 'url' ||
            (key === '' &&
              /^(?:url|(?:repeating-)?(?:linear|radial|conic)-gradient)\s*\(/i.test(raw))
          );
        }
        const accepted: Record<keyof BackgroundLayerSettings, string[]> = {
          size: ['length', 'size'],
          position: ['position'],
          repeat: ['repeat'],
          attachment: ['attachment'],
        };
        return accepted[property].includes(key);
      }
      if (property === 'image') return base === 'bg-none';
      if (property === 'size')
        return (
          ['bg-auto', 'bg-cover', 'bg-contain'].includes(base) ||
          /^bg-size-(?:auto|cover|contain|\[.+\])$/.test(base)
        );
      if (property === 'position') {
        return (
          /^bg-(?:center|top|right|bottom|left|left-top|right-top|left-bottom|right-bottom)$/.test(
            base
          ) || /^bg-position-(?:\[.+\]|[-\w]+)$/.test(base)
        );
      }
      if (property === 'repeat') {
        return /^bg-(?:repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space)$/.test(base);
      }
      return /^bg-(?:fixed|local|scroll)$/.test(base);
    },
    cssProps: [cssProperty],
    utilityPrefix,
  };
}

/** CSS-safe URL wrapper; quotes keep commas and parentheses part of the URL. */
export function cssUrlValue(url: string): string {
  const escaped = url
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\s]/g, (char) => `\\${char.codePointAt(0)!.toString(16).padStart(6, '0')}`);
  return `url("${escaped}")`;
}

export function tailwindBackgroundUrlToken(url: string): string {
  return `bg-[image:${encodeTailwindCssValue(cssUrlValue(url))}]`;
}

export function backgroundLayerToken(value: string): string {
  return `bg-[image:${encodeTailwindCssValue(value)}]`;
}
