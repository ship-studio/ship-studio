/** WCAG contrast helpers and the rendered-style snapshot used by color pickers. */

import { converter } from 'culori';
import { parseColor } from './parseColor';

export type ContrastCategory = 'normal-text' | 'large-text' | 'graphics';
export type ContrastLevel = 'AA' | 'AAA';

export interface ColorContrastContext {
  backgroundColor?: string;
  category?: ContrastCategory;
  unavailableReason?: string;
}

export interface ColorVariableDefinition {
  name: string;
  value?: string;
  /** Selector that scopes this definition. Missing selectors are treated as global. */
  selector?: string;
}

/** A computed style on the selected element or one of its ancestors. */
export interface ColorContrastLayerSnapshot {
  backgroundColor: string;
  hasBackgroundImage: boolean;
  opacity: number;
  mixBlendMode: string;
  backgroundBlendMode: string;
  hasFilter: boolean;
}

/** Layers are ordered from the selected element outward through the root element. */
export interface ColorContrastSnapshot {
  layers: readonly ColorContrastLayerSnapshot[];
  truncated: boolean;
  fontSizePx: number;
  fontWeight: number;
  hasText: boolean;
  /** More than one rendered instance is affected by this edit. */
  groupCount?: number;
  /** A descendant text run has a different rendered paint or typography. */
  hasMixedTextStyle?: boolean;
  /** Strictest category among the visible text runs boundedly inspected. */
  strictestTextCategory?: ContrastCategory;
}

const toRgb = converter('rgb');
const MAX_LAYERS = 32;
const MAX_STYLE_TEXT = 512;
const CSS_COLOR = /^[\s\S]{1,256}$/;

interface RgbColor {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

function parseRgb(value: string): RgbColor | null {
  const parsed = parseColor(value);
  if (!parsed) return null;
  const rgb = toRgb(parsed);
  const channels = [rgb.r, rgb.g, rgb.b, rgb.alpha ?? 1];
  if (!channels.every((channel) => typeof channel === 'number' && Number.isFinite(channel))) {
    return null;
  }
  return {
    r: clamp01(rgb.r ?? 0),
    g: clamp01(rgb.g ?? 0),
    b: clamp01(rgb.b ?? 0),
    alpha: clamp01(rgb.alpha ?? 1),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function composite(foreground: RgbColor, background: Pick<RgbColor, 'r' | 'g' | 'b'>) {
  const alpha = foreground.alpha;
  return {
    r: alpha * foreground.r + (1 - alpha) * background.r,
    g: alpha * foreground.g + (1 - alpha) * background.g,
    b: alpha * foreground.b + (1 - alpha) * background.b,
  };
}

function relativeLuminance(color: Pick<RgbColor, 'r' | 'g' | 'b'>): number {
  const linear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/**
 * Calculate WCAG contrast without rounding the ratio. Foreground alpha is
 * composited over an opaque background; a translucent or unknown background
 * cannot be evaluated without making an assumption about what is behind it.
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseRgb(foreground);
  const bg = parseRgb(background);
  if (!fg || !bg || bg.alpha !== 1) return null;

  const renderedForeground = composite(fg, bg);
  const fgLuminance = relativeLuminance(renderedForeground);
  const bgLuminance = relativeLuminance(bg);
  const lighter = Math.max(fgLuminance, bgLuminance);
  const darker = Math.min(fgLuminance, bgLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2.2 contrast thresholds. AAA for graphics intentionally remains AA's 3:1. */
export function contrastThreshold(category: ContrastCategory, level: ContrastLevel): number {
  if (category === 'graphics') return 3;
  if (category === 'large-text') return level === 'AA' ? 3 : 4.5;
  return level === 'AA' ? 4.5 : 7;
}

/** Resolve CSS custom-property references, aliases, nested functions, and fallbacks. */
export function resolveColorVariable(
  value: string,
  variables: readonly ColorVariableDefinition[],
  selector?: string
): string | null {
  const hasSelectorMetadata = variables.some((variable) => variable.selector !== undefined);
  let applicableVariables = variables;

  if (hasSelectorMetadata) {
    const globalVariables = variables.filter(
      (variable) => variable.selector === undefined || variable.selector === ':root'
    );
    const scopedVariables = selector
      ? variables.filter((variable) => variable.selector === selector)
      : [];
    const scopedNames = new Set(scopedVariables.map((variable) => variable.name));
    applicableVariables = [
      ...globalVariables.filter((variable) => !scopedNames.has(variable.name)),
      ...scopedVariables,
    ];
  }

  const byName = new Map<string, string | undefined>();
  const ambiguousNames = new Set<string>();
  for (const variable of applicableVariables) {
    if (byName.has(variable.name)) {
      byName.set(variable.name, undefined);
      ambiguousNames.add(variable.name);
    } else {
      byName.set(variable.name, variable.value);
    }
  }
  const result = resolveExpression(value, byName, ambiguousNames, new Set());
  return typeof result === 'string' ? result : null;
}

const INVALID_CYCLE = Symbol('invalid-cycle');
const INVALID_AMBIGUOUS = Symbol('invalid-ambiguous');
type VariableResolution = string | null | typeof INVALID_CYCLE | typeof INVALID_AMBIGUOUS;

function resolveExpression(
  value: string,
  variables: ReadonlyMap<string, string | undefined>,
  ambiguousNames: ReadonlySet<string>,
  resolving: ReadonlySet<string>
): VariableResolution {
  let output = '';
  let cursor = 0;
  let quote = '';

  while (cursor < value.length) {
    const char = value[cursor];
    if (quote) {
      output += char;
      if (char === quote && value[cursor - 1] !== '\\') quote = '';
      cursor += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      cursor += 1;
      continue;
    }

    if (value.slice(cursor, cursor + 4).toLowerCase() !== 'var(') {
      output += char;
      cursor += 1;
      continue;
    }

    const end = matchingParen(value, cursor + 3);
    if (end === -1) return null;
    const body = value.slice(cursor + 4, end);
    const comma = topLevelComma(body);
    const name = (comma === -1 ? body : body.slice(0, comma)).trim();
    const fallback = comma === -1 ? null : body.slice(comma + 1).trim();
    if (!/^--[\w-]+$/.test(name)) return null;
    if (ambiguousNames.has(name)) return INVALID_AMBIGUOUS;
    if (resolving.has(name) && variables.get(name)?.trim()) return INVALID_CYCLE;

    let replacement: string | null = null;
    const rawValue = variables.get(name);
    if (rawValue?.trim()) {
      const nextResolving = new Set(resolving);
      nextResolving.add(name);
      const resolved = resolveExpression(rawValue, variables, ambiguousNames, nextResolving);
      if (resolved === INVALID_CYCLE || resolved === INVALID_AMBIGUOUS) return resolved;
      replacement = resolved;
    }
    if (replacement === null && fallback !== null) {
      const resolved = resolveExpression(fallback, variables, ambiguousNames, resolving);
      if (resolved === INVALID_CYCLE || resolved === INVALID_AMBIGUOUS) return resolved;
      replacement = resolved;
    }
    if (replacement === null) return null;

    output += replacement;
    cursor = end + 1;
  }

  return output.trim();
}

function matchingParen(value: string, openIndex: number): number {
  let depth = 0;
  let quote = '';
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function topLevelComma(value: string): number {
  let depth = 0;
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) return index;
  }
  return -1;
}

/** Validate the new iframe protocol fields before they enter editor state. */
export function validateColorContrastSnapshot(value: unknown): ColorContrastSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate.layers) ||
    candidate.layers.length === 0 ||
    candidate.layers.length > MAX_LAYERS ||
    typeof candidate.truncated !== 'boolean' ||
    !isFiniteNumber(candidate.fontSizePx) ||
    candidate.fontSizePx <= 0 ||
    candidate.fontSizePx > 10000 ||
    !isFiniteNumber(candidate.fontWeight) ||
    candidate.fontWeight <= 0 ||
    candidate.fontWeight > 1000 ||
    typeof candidate.hasText !== 'boolean' ||
    (candidate.groupCount !== undefined &&
      (!isFiniteNumber(candidate.groupCount) ||
        !Number.isInteger(candidate.groupCount) ||
        candidate.groupCount < 1 ||
        candidate.groupCount > 10000)) ||
    (candidate.hasMixedTextStyle !== undefined &&
      typeof candidate.hasMixedTextStyle !== 'boolean') ||
    (candidate.strictestTextCategory !== undefined &&
      candidate.strictestTextCategory !== 'normal-text' &&
      candidate.strictestTextCategory !== 'large-text')
  ) {
    return undefined;
  }

  const layers: ColorContrastLayerSnapshot[] = [];
  for (const layer of candidate.layers) {
    if (!layer || typeof layer !== 'object') return undefined;
    const item = layer as Record<string, unknown>;
    if (
      typeof item.backgroundColor !== 'string' ||
      !CSS_COLOR.test(item.backgroundColor) ||
      typeof item.hasBackgroundImage !== 'boolean' ||
      !isFiniteNumber(item.opacity) ||
      item.opacity < 0 ||
      item.opacity > 1 ||
      typeof item.mixBlendMode !== 'string' ||
      item.mixBlendMode.length > MAX_STYLE_TEXT ||
      typeof item.backgroundBlendMode !== 'string' ||
      item.backgroundBlendMode.length > MAX_STYLE_TEXT ||
      typeof item.hasFilter !== 'boolean'
    ) {
      return undefined;
    }
    layers.push({
      backgroundColor: item.backgroundColor,
      hasBackgroundImage: item.hasBackgroundImage,
      opacity: item.opacity,
      mixBlendMode: item.mixBlendMode,
      backgroundBlendMode: item.backgroundBlendMode,
      hasFilter: item.hasFilter,
    });
  }

  return {
    layers,
    truncated: candidate.truncated,
    fontSizePx: candidate.fontSizePx,
    fontWeight: candidate.fontWeight,
    hasText: candidate.hasText,
    ...(candidate.groupCount !== undefined ? { groupCount: candidate.groupCount } : {}),
    ...(candidate.hasMixedTextStyle !== undefined
      ? { hasMixedTextStyle: candidate.hasMixedTextStyle }
      : {}),
    ...(candidate.strictestTextCategory !== undefined
      ? { strictestTextCategory: candidate.strictestTextCategory }
      : {}),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export interface ColorContrastContexts {
  text: ColorContrastContext;
  graphics: ColorContrastContext;
}

/** Build text and non-text contexts using the same validated rendered snapshot. */
export function colorContrastContexts(
  snapshot: ColorContrastSnapshot | undefined
): ColorContrastContexts {
  if (!snapshot) {
    const unavailableReason = 'Rendered style information is unavailable.';
    return {
      text: { unavailableReason },
      graphics: { category: 'graphics', unavailableReason },
    };
  }

  const groupUnavailableReason =
    snapshot.groupCount != null && snapshot.groupCount > 1
      ? 'This edit affects multiple rendered instances; their contrast may differ.'
      : undefined;

  const graphics: ColorContrastContext = {
    category: 'graphics',
    ...effectiveBackdrop(snapshot, false),
  };

  if (snapshot.truncated) {
    return {
      text: { unavailableReason: 'The ancestor chain is too deep to evaluate safely.' },
      graphics: {
        category: 'graphics',
        unavailableReason: 'The ancestor chain is too deep to evaluate safely.',
      },
    };
  }
  if (!snapshot.hasText) {
    return {
      text: { unavailableReason: 'This element has no rendered text.' },
      graphics: groupUnavailableReason
        ? { category: 'graphics', unavailableReason: groupUnavailableReason }
        : graphics,
    };
  }

  const category: ContrastCategory =
    snapshot.strictestTextCategory ??
    (snapshot.fontSizePx >= 24 || (snapshot.fontWeight >= 700 && snapshot.fontSizePx >= 18.6666667)
      ? 'large-text'
      : 'normal-text');
  const textUnavailableReason = snapshot.hasMixedTextStyle
    ? 'Descendant text has different rendered colors, backgrounds, or typography.'
    : undefined;
  const textBackdrop = effectiveBackdrop(snapshot, true);
  return {
    text: groupUnavailableReason
      ? { category, unavailableReason: groupUnavailableReason }
      : textUnavailableReason
        ? { category, unavailableReason: textUnavailableReason }
        : { category, ...textBackdrop },
    graphics: groupUnavailableReason
      ? { category: 'graphics', unavailableReason: groupUnavailableReason }
      : graphics,
  };
}

function effectiveBackdrop(
  snapshot: ColorContrastSnapshot,
  includeSelectedBackground: boolean
): Pick<ColorContrastContext, 'backgroundColor' | 'unavailableReason'> {
  // Group effects apply to the whole ancestor path even when an ancestor's own
  // background is hidden behind a nearer opaque layer.
  for (const layer of snapshot.layers) {
    if (layer.opacity !== 1 || layer.mixBlendMode !== 'normal' || layer.hasFilter) {
      return { unavailableReason: 'Opacity, filters, or blending affect the rendered color.' };
    }
  }

  const start = includeSelectedBackground ? 0 : 1;
  let baseIndex = -1;
  const parsed: RgbColor[] = [];
  for (let index = start; index < snapshot.layers.length; index += 1) {
    const layer = snapshot.layers[index];
    const color = parseRgb(layer.backgroundColor);
    if (!color) return { unavailableReason: 'A rendered background color could not be parsed.' };
    parsed.push(color);
    if (color.alpha === 1) {
      baseIndex = parsed.length - 1;
      break;
    }
  }
  if (baseIndex === -1) {
    return { unavailableReason: 'No opaque background is available for contrast.' };
  }

  // Images and background blending matter only until the first opaque surface.
  for (let index = 0; index <= baseIndex; index += 1) {
    const layer = snapshot.layers[start + index];
    if (layer.hasBackgroundImage) {
      return { unavailableReason: 'Background images and gradients are not supported.' };
    }
  }

  const base = parsed[baseIndex];
  if (!base) return { unavailableReason: 'A rendered background color could not be parsed.' };
  let result = { r: base.r, g: base.g, b: base.b };
  for (let index = baseIndex - 1; index >= 0; index -= 1) {
    const layer = parsed[index];
    if (!layer) return { unavailableReason: 'A rendered background color could not be parsed.' };
    result = composite(layer, result);
  }

  return { backgroundColor: `rgb(${result.r * 255} ${result.g * 255} ${result.b * 255})` };
}
