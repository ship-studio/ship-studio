/** Free-form property fields for layout and effects values that are not enums. */

import { useState } from 'react';
import {
  ValueField,
  type ValueFieldOption,
  type ValueFieldVariable,
} from '../primitives/ValueField';
import { ToggleButton } from '../primitives/ToggleButton';
import { ResettableLabel } from './ResettableLabel';
import {
  radiusResetSpec,
  readLayer,
  tailwindUtilityParts,
  tokensForVariant,
  type InheritedProp,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';
import {
  CornerRadiusBottomLeftIcon,
  CornerRadiusBottomRightIcon,
  CornerRadiusIcon,
  CornerRadiusTopLeftIcon,
  CornerRadiusTopRightIcon,
  LockedIcon,
  UnlockedIcon,
} from '@/components/icons';

type ValuePropertyKind =
  | 'border'
  | 'radius'
  | 'z-index'
  | 'blur'
  | 'font-size'
  | 'line-height'
  | 'letter-spacing';

interface ParsedValue {
  token: string;
  style: Record<string, string>;
}

const RADIUS_VALUES_V3: Record<string, string> = {
  'rounded-none': '0',
  rounded: '0.25rem',
  'rounded-sm': '0.125rem',
  'rounded-md': '0.375rem',
  'rounded-lg': '0.5rem',
  'rounded-xl': '0.75rem',
  'rounded-2xl': '1rem',
  'rounded-3xl': '1.5rem',
  'rounded-full': '9999px',
};

const RADIUS_VALUES_V4: Record<string, string> = {
  'rounded-none': '0',
  'rounded-xs': '0.125rem',
  'rounded-sm': '0.25rem',
  'rounded-md': '0.375rem',
  'rounded-lg': '0.5rem',
  'rounded-xl': '0.75rem',
  'rounded-2xl': '1rem',
  'rounded-3xl': '1.5rem',
  'rounded-4xl': '2rem',
  'rounded-full': 'calc(infinity * 1px)',
  // Tailwind v4 keeps the bare form as a compatibility alias for `rounded-sm`.
  rounded: '0.25rem',
};

function radiusValuesForVersion(version?: LayerContext['tailwindVersion']) {
  return version === 'v4' ? RADIUS_VALUES_V4 : RADIUS_VALUES_V3;
}

type RadiusCorner = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left';

const RADIUS_CORNER_KEYS = [
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left',
] as const satisfies readonly RadiusCorner[];

export type RadiusValues = [string, string, string, string];

type RadiusReadOptions = Pick<
  LayerContext,
  'utilityPrefix' | 'tailwindVersion' | 'direction' | 'writingMode'
>;

const BLUR_VALUES: Record<string, string> = {
  'blur-none': '0px',
  'blur-sm': '4px',
  blur: '8px',
  'blur-md': '12px',
  'blur-lg': '16px',
  'blur-xl': '24px',
};

const FONT_SIZE_VALUES: Record<string, string> = {
  'text-xs': '0.75rem',
  'text-sm': '0.875rem',
  'text-base': '1rem',
  'text-lg': '1.125rem',
  'text-xl': '1.25rem',
  'text-2xl': '1.5rem',
  'text-3xl': '1.875rem',
  'text-4xl': '2.25rem',
  'text-5xl': '3rem',
};

const LINE_HEIGHT_VALUES: Record<string, string> = {
  'leading-none': '1',
  'leading-tight': '1.25',
  'leading-snug': '1.375',
  'leading-normal': '1.5',
  'leading-relaxed': '1.625',
  'leading-loose': '2',
};

const LETTER_SPACING_VALUES: Record<string, string> = {
  'tracking-tighter': '-0.05em',
  'tracking-tight': '-0.025em',
  'tracking-normal': '0em',
  'tracking-wide': '0.025em',
  'tracking-wider': '0.05em',
  'tracking-widest': '0.1em',
};

function arbitraryToken(prefix: string, value: string): string {
  return `${prefix}-[${value.trim().replace(/\s+/g, '_')}]`;
}

function readBorderValue(className: string): string | null {
  for (const token of className.split(/\s+/)) {
    if (token === 'border') return '1px';
    if (token === 'border-0') return '0';
    const scale = /^border-(\d+)$/.exec(token);
    if (scale) return `${scale[1]}px`;
    const arbitrary = /^border-\[([^\]]+)\]$/.exec(token);
    if (arbitrary) {
      const raw = arbitrary[1].replace(/_/g, ' ');
      if (raw.startsWith('length:')) return raw.slice('length:'.length).trim();
      if (/^[-+]?\d/.test(raw)) return raw;
    }
  }
  return null;
}

const PHYSICAL_RADIUS_TARGETS: Record<string, readonly RadiusCorner[]> = {
  rounded: RADIUS_CORNER_KEYS,
  'rounded-t': ['top-left', 'top-right'],
  'rounded-r': ['top-right', 'bottom-right'],
  'rounded-b': ['bottom-right', 'bottom-left'],
  'rounded-l': ['top-left', 'bottom-left'],
  'rounded-tl': ['top-left'],
  'rounded-tr': ['top-right'],
  'rounded-br': ['bottom-right'],
  'rounded-bl': ['bottom-left'],
};

const LOGICAL_RADIUS_UTILITY_NAMES = [
  'rounded-s',
  'rounded-e',
  'rounded-ss',
  'rounded-se',
  'rounded-ee',
  'rounded-es',
] as const;

const RADIUS_UTILITY_NAMES = [
  ...Object.keys(PHYSICAL_RADIUS_TARGETS).filter((name) => name !== 'rounded'),
  ...LOGICAL_RADIUS_UTILITY_NAMES,
];

interface LogicalRadiusSides {
  inlineStart: 'top' | 'right' | 'bottom' | 'left';
  inlineEnd: 'top' | 'right' | 'bottom' | 'left';
  blockStart: 'top' | 'right' | 'bottom' | 'left';
  blockEnd: 'top' | 'right' | 'bottom' | 'left';
}

function logicalRadiusSides(options: RadiusReadOptions): LogicalRadiusSides {
  const direction = options.direction ?? 'ltr';
  const writingMode = options.writingMode?.toLowerCase() ?? 'horizontal-tb';
  const vertical = writingMode.startsWith('vertical') || writingMode.startsWith('sideways');
  if (!vertical) {
    return {
      inlineStart: direction === 'rtl' ? 'right' : 'left',
      inlineEnd: direction === 'rtl' ? 'left' : 'right',
      blockStart: 'top',
      blockEnd: 'bottom',
    };
  }

  const blockRight = writingMode.startsWith('vertical-rl');
  return {
    inlineStart: direction === 'rtl' ? 'bottom' : 'top',
    inlineEnd: direction === 'rtl' ? 'top' : 'bottom',
    blockStart: blockRight ? 'right' : 'left',
    blockEnd: blockRight ? 'left' : 'right',
  };
}

function radiusCornerAt(
  block: LogicalRadiusSides[keyof LogicalRadiusSides],
  inline: LogicalRadiusSides[keyof LogicalRadiusSides]
): RadiusCorner | null {
  if (block === 'top' && inline === 'left') return 'top-left';
  if (block === 'top' && inline === 'right') return 'top-right';
  if (block === 'bottom' && inline === 'right') return 'bottom-right';
  if (block === 'bottom' && inline === 'left') return 'bottom-left';
  return null;
}

function radiusTargetsForUtility(
  utility: string,
  options: RadiusReadOptions
): readonly RadiusCorner[] | null {
  const physical = PHYSICAL_RADIUS_TARGETS[utility];
  if (physical) return physical;

  const logical = logicalRadiusSides(options);
  const corners = {
    'rounded-s': [
      radiusCornerAt(logical.blockStart, logical.inlineStart),
      radiusCornerAt(logical.blockEnd, logical.inlineStart),
    ],
    'rounded-e': [
      radiusCornerAt(logical.blockStart, logical.inlineEnd),
      radiusCornerAt(logical.blockEnd, logical.inlineEnd),
    ],
    'rounded-ss': [radiusCornerAt(logical.blockStart, logical.inlineStart)],
    'rounded-se': [radiusCornerAt(logical.blockStart, logical.inlineEnd)],
    'rounded-ee': [radiusCornerAt(logical.blockEnd, logical.inlineEnd)],
    'rounded-es': [radiusCornerAt(logical.blockEnd, logical.inlineStart)],
  }[utility];
  return corners?.filter((corner): corner is RadiusCorner => corner !== null) ?? null;
}

function normalizeRadiusToken(
  token: string,
  options: RadiusReadOptions
): { base: string; important: boolean } | null {
  const parsed = tailwindUtilityParts(token, options.utilityPrefix);
  if (!parsed || parsed.negative) return null;
  return { base: parsed.base, important: parsed.important };
}

function radiusUtilityParts(base: string): { utility: string; valuePart: string } | null {
  if (base === 'rounded') return { utility: 'rounded', valuePart: '' };
  for (const utility of RADIUS_UTILITY_NAMES) {
    const marker = `${utility}-`;
    if (base.startsWith(marker)) {
      return { utility, valuePart: base.slice(marker.length) };
    }
  }
  if (base.startsWith('rounded-')) {
    return { utility: 'rounded', valuePart: base.slice('rounded-'.length) };
  }
  return null;
}

function decodeRadiusUtilityValue(valuePart: string, options: RadiusReadOptions): string | null {
  const values = radiusValuesForVersion(options.tailwindVersion);
  const named = values[valuePart ? `rounded-${valuePart}` : 'rounded'];
  if (named !== undefined) return named;

  if (valuePart.startsWith('[') && valuePart.endsWith(']')) {
    const raw = valuePart.slice(1, -1).replace(/_/g, ' ').trim();
    if (!raw) return null;
    const typed = /^length:(.+)$/i.exec(raw)?.[1].trim();
    return typed || raw;
  }

  if (valuePart.startsWith('(') && valuePart.endsWith(')')) {
    const property = valuePart.slice(1, -1).trim();
    if (/^--[\w-]+$/.test(property)) return `var(${property})`;
  }
  return null;
}

function parseRadiusCornerValue(value: string): string | null {
  const parsed = parseRadiusValue(value);
  if (!parsed) return null;
  const tokens = splitCssValueList(parsed);
  return tokens.length >= 1 && tokens.length <= 2 && !tokens.includes('/') ? parsed : null;
}

interface RadiusUtilityCandidate {
  targets: readonly RadiusCorner[];
  value: string;
  specificity: number;
  important: boolean;
  order: number;
  layerMinPx: number;
}

type RadiusUtilityParse = RadiusUtilityCandidate | 'unsupported' | null;

function parseRadiusUtility(
  token: string,
  options: RadiusReadOptions,
  order: number
): RadiusUtilityParse {
  const normalized = normalizeRadiusToken(token, options);
  if (!normalized) return null;
  const parts = radiusUtilityParts(normalized.base);
  if (!parts) return null;
  const targets = radiusTargetsForUtility(parts.utility, options);
  const raw = decodeRadiusUtilityValue(parts.valuePart, options);
  if (!targets || raw === null) return 'unsupported';

  const value = parts.utility === 'rounded' ? parseRadiusValue(raw) : parseRadiusCornerValue(raw);
  if (!value) return 'unsupported';

  return {
    targets,
    value,
    specificity: targets.length === RADIUS_CORNER_KEYS.length ? 0 : targets.length === 1 ? 2 : 1,
    important: normalized.important,
    order,
    layerMinPx: 0,
  };
}

function radiusCandidateWins(next: RadiusUtilityCandidate, current: RadiusUtilityCandidate) {
  if (next.important !== current.important) return next.important;
  if (next.specificity !== current.specificity) return next.specificity > current.specificity;
  return next.order >= current.order;
}

type ResolvedRadiusCorners = Partial<
  Record<RadiusCorner, { value: string; candidate: RadiusUtilityCandidate }>
>;

interface RadiusLayerResult {
  corners: ResolvedRadiusCorners;
}

function formatRadiusCorners(corners: ResolvedRadiusCorners): string | null {
  const first = RADIUS_CORNER_KEYS.map((corner) => corners[corner]).find(
    (entry): entry is NonNullable<ResolvedRadiusCorners[RadiusCorner]> => entry !== undefined
  );
  if (!first) return null;
  if (
    first.candidate.specificity === 0 &&
    RADIUS_CORNER_KEYS.every((corner) => corners[corner]?.candidate === first.candidate)
  ) {
    // Keep a generic shorthand in its original 1–4 value form for the linked
    // field. Only expand when directional utilities actually participate.
    return first.candidate.value;
  }
  return RADIUS_CORNER_KEYS.map((corner) => corners[corner]?.value ?? '0').join(' ');
}

function parseRadiusLayer(
  className: string,
  options: RadiusReadOptions = {}
): RadiusLayerResult | 'unsupported' | null {
  const resolved: ResolvedRadiusCorners = {};
  let found = false;
  let unsupported = false;

  for (const [order, token] of className.split(/\s+/).entries()) {
    const candidate = parseRadiusUtility(token, options, order);
    if (candidate === 'unsupported') {
      unsupported = true;
      continue;
    }
    if (!candidate) continue;
    found = true;
    const expanded = candidate.specificity === 0 ? expandRadiusValue(candidate.value) : null;
    for (const corner of candidate.targets) {
      const index = RADIUS_CORNER_KEYS.indexOf(corner);
      const value = expanded?.[index] ?? candidate.value;
      const current = resolved[corner];
      if (!current || radiusCandidateWins(candidate, current.candidate)) {
        resolved[corner] = { value, candidate };
      }
    }
  }

  if (unsupported) return 'unsupported';
  return found ? { corners: resolved } : null;
}

function readRadiusValue(className: string, options: RadiusReadOptions = {}): string | null {
  const parsed = parseRadiusLayer(className, options);
  return parsed && parsed !== 'unsupported' ? formatRadiusCorners(parsed.corners) : null;
}

function radiusCascadeCandidateWins(
  next: RadiusUtilityCandidate,
  current: RadiusUtilityCandidate,
  nextMinPx: number,
  currentMinPx: number
): boolean {
  if (next.important !== current.important) return next.important;
  return nextMinPx >= currentMinPx;
}

function readRadiusCascade(
  className: string,
  layer: LayerContext
): { value: string | null; definedAt: LayerContext['bp'] | null } {
  const layers = layer.ordered
    .filter((breakpoint) => breakpoint.minPx <= layer.bp.minPx)
    .sort((a, b) => a.minPx - b.minPx);
  const resolved: ResolvedRadiusCorners = {};
  let definedAt: LayerContext['bp'] | null = null;

  for (const breakpoint of layers) {
    const scoped = tokensForVariant(className, breakpoint.prefix, layer.known);
    const parsed = parseRadiusLayer(scoped, layer);
    if (parsed === 'unsupported') return { value: null, definedAt: null };
    if (!parsed) continue;

    const layeredCandidates = new Map<RadiusUtilityCandidate, RadiusUtilityCandidate>();
    let applied = false;
    for (const corner of RADIUS_CORNER_KEYS) {
      const next = parsed.corners[corner];
      if (!next) continue;
      const layeredCandidate =
        layeredCandidates.get(next.candidate) ??
        (() => {
          const candidate = { ...next.candidate, layerMinPx: breakpoint.minPx };
          layeredCandidates.set(next.candidate, candidate);
          return candidate;
        })();
      const current = resolved[corner];
      if (
        !current ||
        radiusCascadeCandidateWins(
          layeredCandidate,
          current.candidate,
          breakpoint.minPx,
          current.candidate.layerMinPx
        )
      ) {
        resolved[corner] = {
          value: next.value,
          candidate: layeredCandidate,
        };
        applied = true;
      }
    }
    if (applied) definedAt = breakpoint;
  }

  return { value: formatRadiusCorners(resolved), definedAt };
}

function readZIndexValue(className: string): string | null {
  for (const token of className.split(/\s+/)) {
    if (token === 'z-auto') return 'auto';
    const scale = /^z-(-?\d+)$/.exec(token);
    if (scale) return scale[1];
    const arbitrary = /^z-\[([^\]]+)\]$/.exec(token);
    if (arbitrary) return arbitrary[1].replace(/_/g, ' ');
  }
  return null;
}

function readBlurValue(className: string): string | null {
  for (const token of className.split(/\s+/)) {
    if (BLUR_VALUES[token]) return BLUR_VALUES[token];
    const arbitrary = /^blur-\[([^\]]+)\]$/.exec(token);
    if (arbitrary) return arbitrary[1].replace(/_/g, ' ');
  }
  return null;
}

function isFontSizeArbitrary(raw: string): boolean {
  return /^(?:[-+]?\d|\.(?:\d)|calc\(|min\(|max\(|clamp\(|var\()/i.test(raw.trim());
}

function readTypographyValue(
  className: string,
  values: Record<string, string>,
  prefix: string,
  arbitraryAllowed: (raw: string) => boolean = () => true
): string | null {
  for (const token of className.split(/\s+/)) {
    if (values[token]) return values[token];
    const arbitrary = new RegExp(`^${prefix}-\\[([^\\]]+)\\]$`).exec(token);
    if (arbitrary && arbitraryAllowed(arbitrary[1])) return arbitrary[1].replace(/_/g, ' ');
  }
  return null;
}

function readFontSizeValue(className: string): string | null {
  for (const token of className.split(/\s+/)) {
    if (FONT_SIZE_VALUES[token]) return FONT_SIZE_VALUES[token];
    const arbitrary = /^text-\[([^\]]+)\]$/.exec(token);
    if (!arbitrary) continue;
    const raw = arbitrary[1].replace(/_/g, ' ');
    if (raw.startsWith('length:')) return raw.slice('length:'.length).trim();
    if (isFontSizeArbitrary(raw) && !/^var\(/i.test(raw)) return raw;
  }
  return null;
}

function readLineHeightValue(className: string): string | null {
  return readTypographyValue(className, LINE_HEIGHT_VALUES, 'leading');
}

function readLetterSpacingValue(className: string): string | null {
  return readTypographyValue(className, LETTER_SPACING_VALUES, 'tracking');
}

function cssLength(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = /^[-+]?\d*\.?\d+$/.test(trimmed) && trimmed !== '0' ? `${trimmed}px` : trimmed;
  if (/^0(?:[a-z%]+)?$/i.test(normalized)) return normalized;
  if (/^[-+]?\d*\.?\d+(?:px|%|em|rem|ch|vw|vh|svw|svh|vmin|vmax|cm|mm|in|pt|pc)$/i.test(normalized))
    return normalized;
  if (/^(?:calc|min|max|clamp|var)\(.+\)$/i.test(normalized)) return normalized;
  return null;
}

/** Split a CSS space-separated value list without breaking function arguments. */
function splitCssValueList(value: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let depth = 0;
  const push = () => {
    if (token) tokens.push(token);
    token = '';
  };

  for (const character of value.trim()) {
    if (character === '(') depth += 1;
    if (character === ')' && depth > 0) depth -= 1;
    if (depth === 0 && (character === '/' || /\s/.test(character))) {
      push();
      if (character === '/') tokens.push('/');
      continue;
    }
    token += character;
  }
  push();
  return tokens;
}

function expandRadiusGroup(values: string[]): RadiusValues {
  if (values.length === 1) return [values[0], values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  return [values[0] ?? '', values[1] ?? '', values[2] ?? '', values[3] ?? ''];
}

/** Expand CSS border-radius shorthand into top-left, top-right, bottom-right,
 * bottom-left values. Elliptical values retain their horizontal/vertical pair. */
export function expandRadiusValue(value: string): RadiusValues {
  const tokens = splitCssValueList(value);
  if (tokens.length === 0) return ['', '', '', ''];
  const slash = tokens.indexOf('/');
  if (slash === -1) return expandRadiusGroup(tokens);

  const horizontal = expandRadiusGroup(tokens.slice(0, slash));
  const vertical = expandRadiusGroup(tokens.slice(slash + 1));
  return horizontal.map((part, index) => `${part} ${vertical[index]}`) as RadiusValues;
}

function collapseRadiusGroup(values: readonly string[]): string {
  return values.join(' ');
}

/** Rebuild a border-radius shorthand from the four visible corner values. */
export function collapseRadiusValues(values: readonly string[]): string {
  const normalized = values.map((value) => value.trim());
  const pairs = normalized.map(splitCssValueList);
  if (pairs.length === 4 && pairs.every((pair) => pair.length === 2 && !pair.includes('/'))) {
    return `${collapseRadiusGroup(pairs.map((pair) => pair[0]))} / ${collapseRadiusGroup(
      pairs.map((pair) => pair[1])
    )}`;
  }
  return collapseRadiusGroup(normalized);
}

/** Normalize and validate one to four border-radius values (optionally with a
 * horizontal/vertical slash pair) for a Tailwind arbitrary utility. */
export function parseRadiusValue(value: string): string | null {
  const tokens = splitCssValueList(value);
  if (tokens.length === 0) return null;
  const slash = tokens.indexOf('/');
  const groups = slash === -1 ? [tokens] : [tokens.slice(0, slash), tokens.slice(slash + 1)];
  if (
    groups.some(
      (group) =>
        group.length < 1 || group.length > 4 || group.some((part) => cssLength(part) === null)
    )
  )
    return null;
  if (tokens.filter((token) => token === '/').length > 1) return null;
  const normalizedGroups = groups.map((group) => group.map((part) => cssLength(part)!));
  return slash === -1
    ? normalizedGroups[0].join(' ')
    : `${normalizedGroups[0].join(' ')} / ${normalizedGroups[1].join(' ')}`;
}

function cssUnitlessOrLength(value: string): string | null {
  const trimmed = value.trim();
  if (/^[-+]?\d*\.?\d+$/.test(trimmed)) return trimmed;
  return cssLength(trimmed);
}

function parseValue(
  kind: ValuePropertyKind,
  raw: string,
  radiusOptions: RadiusReadOptions = {}
): ParsedValue | null {
  const value = raw.trim();
  if (kind === 'z-index') {
    if (value.toLowerCase() === 'auto') return { token: 'z-auto', style: { 'z-index': 'auto' } };
    if (/^var\(\s*--[\w-]+\s*\)$/i.test(value)) {
      return { token: arbitraryToken('z', value), style: { 'z-index': value } };
    }
    if (!/^-?\d+$/.test(value)) return null;
    const token = ['0', '10', '20', '30', '40', '50'].includes(value)
      ? `z-${value}`
      : arbitraryToken('z', value);
    return { token, style: { 'z-index': value } };
  }

  if (kind === 'font-size' || kind === 'line-height' || kind === 'letter-spacing') {
    const css = kind === 'line-height' ? cssUnitlessOrLength(value) : cssLength(value);
    if (!css) return null;
    const values =
      kind === 'font-size'
        ? FONT_SIZE_VALUES
        : kind === 'line-height'
          ? LINE_HEIGHT_VALUES
          : LETTER_SPACING_VALUES;
    const prefix = kind === 'font-size' ? 'text' : kind === 'line-height' ? 'leading' : 'tracking';
    const token = Object.entries(values).find(([, current]) => current === css)?.[0];
    const property =
      kind === 'font-size'
        ? 'font-size'
        : kind === 'line-height'
          ? 'line-height'
          : 'letter-spacing';
    const arbitrary =
      kind === 'font-size' ? arbitraryToken(prefix, `length:${css}`) : arbitraryToken(prefix, css);
    return { token: token ?? arbitrary, style: { [property]: css } };
  }

  const css = kind === 'radius' ? parseRadiusValue(value) : cssLength(value);
  if (!css) return null;
  if (kind === 'border') {
    if (css === '0') return { token: 'border-0', style: { 'border-width': '0' } };
    const token =
      css === '1px'
        ? 'border'
        : arbitraryToken('border', /^var\(/i.test(css) ? `length:${css}` : css);
    return {
      token,
      style: { 'border-width': css, 'border-style': 'solid' },
    };
  }
  if (kind === 'radius') {
    const token = Object.entries(radiusValuesForVersion(radiusOptions.tailwindVersion)).find(
      ([, current]) => current === css
    )?.[0];
    return { token: token ?? arbitraryToken('rounded', css), style: { 'border-radius': css } };
  }

  const token = Object.entries(BLUR_VALUES).find(([, current]) => current === css)?.[0];
  return { token: token ?? arbitraryToken('blur', css), style: { filter: `blur(${css})` } };
}

function resetSpec(kind: ValuePropertyKind, utilityPrefix?: string): ResetSpec {
  if (kind === 'border') {
    return {
      match: (token) =>
        token === 'border' ||
        token === 'border-0' ||
        /^border-(?:\d+|\[(?:[+-]?\d|length:))/.test(token),
      cssProps: ['border-width', 'border-style'],
    };
  }
  if (kind === 'radius') {
    return radiusResetSpec(utilityPrefix);
  }
  if (kind === 'z-index') {
    return {
      match: (token) => token === 'z-auto' || /^z-(?:-?\d+|\[)/.test(token),
      cssProps: ['z-index'],
    };
  }
  if (kind === 'font-size') {
    return {
      match: (token) =>
        token in FONT_SIZE_VALUES ||
        (() => {
          const arbitrary = /^text-\[([^\]]+)\]$/.exec(token);
          if (!arbitrary) return false;
          const raw = arbitrary[1].replace(/_/g, ' ');
          return raw.startsWith('length:') || (isFontSizeArbitrary(raw) && !/^var\(/i.test(raw));
        })(),
      cssProps: ['font-size'],
    };
  }
  if (kind === 'line-height') {
    return {
      match: (token) => token in LINE_HEIGHT_VALUES || token.startsWith('leading-'),
      cssProps: ['line-height'],
    };
  }
  if (kind === 'letter-spacing') {
    return {
      match: (token) => token in LETTER_SPACING_VALUES || token.startsWith('tracking-'),
      cssProps: ['letter-spacing'],
    };
  }
  return { match: (token) => token === 'blur' || token.startsWith('blur-'), cssProps: ['filter'] };
}

const LABELS: Record<ValuePropertyKind, string> = {
  border: 'Border',
  radius: 'Radius',
  'z-index': 'Z-index',
  blur: 'Blur',
  'font-size': 'Size',
  'line-height': 'Line height',
  'letter-spacing': 'Letter spacing',
};

const VARIANTS: Record<ValuePropertyKind, 'number' | 'length'> = {
  border: 'length',
  radius: 'length',
  'z-index': 'number',
  blur: 'length',
  'font-size': 'length',
  'line-height': 'length',
  'letter-spacing': 'length',
};

const KEYWORDS: Record<ValuePropertyKind, ValueFieldOption[]> = {
  border: [],
  radius: [],
  'z-index': [{ value: 'auto', label: 'AUTO', kind: 'keyword' }],
  blur: [],
  'font-size': [],
  'line-height': [],
  'letter-spacing': [],
};

function readValue(kind: ValuePropertyKind, className: string): string | null {
  if (kind === 'border') return readBorderValue(className);
  if (kind === 'radius') return readRadiusValue(className);
  if (kind === 'z-index') return readZIndexValue(className);
  if (kind === 'blur') return readBlurValue(className);
  if (kind === 'font-size') return readFontSizeValue(className);
  if (kind === 'line-height') return readLineHeightValue(className);
  return readLetterSpacingValue(className);
}

interface ValuePropertyControlProps {
  kind: ValuePropertyKind;
  currentClass: string;
  layer: LayerContext;
  variables?: ValueFieldVariable[];
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onReset: (spec: ResetSpec) => void;
  /** Ancestor-defined value for this property (only for inheritable kinds). */
  inherited?: InheritedProp | null;
  projectPath?: string;
  onOpenInCode?: (file: string, line: number) => void;
}

type RadiusValueControlProps = Omit<ValuePropertyControlProps, 'kind'>;

const RADIUS_CORNERS = [
  { key: 'top-left', label: 'Top left', Icon: CornerRadiusTopLeftIcon },
  { key: 'top-right', label: 'Top right', Icon: CornerRadiusTopRightIcon },
  { key: 'bottom-right', label: 'Bottom right', Icon: CornerRadiusBottomRightIcon },
  { key: 'bottom-left', label: 'Bottom left', Icon: CornerRadiusBottomLeftIcon },
] as const;

function RadiusValueControl({
  currentClass,
  layer,
  variables,
  onApplyEnum,
  onReset,
  inherited = null,
  projectPath,
  onOpenInCode,
}: RadiusValueControlProps) {
  const { value, definedAt } = readRadiusCascade(currentClass, layer);
  const [separated, setSeparated] = useState(false);
  const shown = value ?? inherited?.cssValue ?? '';
  const cornerValues = expandRadiusValue(shown);

  const applyRadiusValue = (raw: string) => {
    const parsed = parseValue('radius', raw, layer);
    if (!parsed) return false;
    onApplyEnum(parsed.token, parsed.style);
    return true;
  };

  const toggleLabel = separated ? 'Link radius values' : 'Separate radius values';
  return (
    <div className="ss-edit-panel__control">
      <ResettableLabel
        label="Radius"
        definedAt={definedAt}
        active={layer.bp}
        onReset={() => onReset(resetSpec('radius', layer.utilityPrefix))}
        inherited={inherited}
        projectPath={projectPath}
        onOpenInCode={onOpenInCode}
      />
      <div className="ss-radius-control">
        <div className="ss-radius-control__fields">
          {separated ? (
            <div className="ss-radius-control__grid">
              {RADIUS_CORNERS.map((corner, index) => (
                <div key={corner.key} className="ss-radius-control__corner">
                  <corner.Icon className="ss-radius-control__marker" size={14} aria-hidden="true" />
                  <ValueField
                    className="ss-edit-panel__text ss-radius-control__value"
                    variant="length"
                    variables={variables}
                    value={cornerValues[index]}
                    aria-label={`Radius ${corner.label}`}
                    placeholder="0"
                    title={`Radius ${corner.label}`}
                    onCommit={(next) => {
                      const nextValues = cornerValues.map((current, currentIndex) =>
                        currentIndex === index ? next : current || '0'
                      );
                      return applyRadiusValue(collapseRadiusValues(nextValues));
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <ValueField
              className="ss-edit-panel__text ss-radius-control__value"
              variant="length"
              variables={variables}
              value={shown}
              leading={
                <CornerRadiusIcon
                  className="ss-radius-control__leading-icon"
                  size={14}
                  aria-hidden="true"
                />
              }
              aria-label="Radius"
              placeholder="0"
              title="Radius"
              onCommit={applyRadiusValue}
            />
          )}
        </div>
        <ToggleButton
          variant="ghost"
          size="compact"
          className="button--icon-only ss-radius-control__toggle"
          pressed={separated}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => setSeparated((current) => !current)}
          leftIcon={separated ? <UnlockedIcon size={16} /> : <LockedIcon size={16} />}
        />
      </div>
    </div>
  );
}

export function ValuePropertyControl({
  kind,
  currentClass,
  layer,
  variables,
  onApplyEnum,
  onReset,
  inherited = null,
  projectPath,
  onOpenInCode,
}: ValuePropertyControlProps) {
  if (kind === 'radius') {
    return (
      <RadiusValueControl
        currentClass={currentClass}
        layer={layer}
        variables={variables}
        onApplyEnum={onApplyEnum}
        onReset={onReset}
        inherited={inherited}
        projectPath={projectPath}
        onOpenInCode={onOpenInCode}
      />
    );
  }

  const { value, definedAt } = readLayer(currentClass, layer, (tokens) => readValue(kind, tokens));
  // With nothing set locally, the field shows the ancestor's effective value —
  // editable as ever; committing writes a local token and flips the label blue.
  const shown = value ?? inherited?.cssValue ?? '';
  // "Set here explicitly": adopt the inherited value as a local utility. Only
  // offered when it parses into a valid token for this control.
  const adopt =
    inherited && parseValue(kind, inherited.cssValue)
      ? () => {
          const parsed = parseValue(kind, inherited.cssValue);
          if (parsed) onApplyEnum(parsed.token, parsed.style);
        }
      : undefined;
  return (
    <div className="ss-edit-panel__control">
      <ResettableLabel
        label={LABELS[kind]}
        definedAt={definedAt}
        active={layer.bp}
        onReset={() => onReset(resetSpec(kind))}
        inherited={inherited}
        onAdopt={adopt}
        projectPath={projectPath}
        onOpenInCode={onOpenInCode}
      />
      <ValueField
        className="ss-edit-panel__text"
        variant={VARIANTS[kind]}
        keywords={KEYWORDS[kind]}
        variables={variables}
        value={shown}
        aria-label={LABELS[kind]}
        placeholder={
          kind === 'z-index'
            ? 'auto'
            : kind === 'blur'
              ? '0px'
              : kind === 'font-size'
                ? '1rem'
                : kind === 'line-height'
                  ? '1.5'
                  : kind === 'letter-spacing'
                    ? '0em'
                    : '0'
        }
        onCommit={(next) => {
          const parsed = parseValue(kind, next);
          if (!parsed) return false;
          onApplyEnum(parsed.token, parsed.style);
          return true;
        }}
        title={LABELS[kind]}
      />
    </div>
  );
}
