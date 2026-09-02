/** Free-form property fields for layout and effects values that are not enums. */

import {
  ValueField,
  type ValueFieldOption,
  type ValueFieldVariable,
} from '../primitives/ValueField';
import { ResettableLabel } from './ResettableLabel';
import { readLayer, type InheritedProp, type LayerContext, type ResetSpec } from '../../lib/edit';

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

const RADIUS_VALUES: Record<string, string> = {
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

function readRadiusValue(className: string): string | null {
  for (const token of className.split(/\s+/)) {
    if (RADIUS_VALUES[token]) return RADIUS_VALUES[token];
    const arbitrary = /^rounded-\[([^\]]+)\]$/.exec(token);
    if (arbitrary) return arbitrary[1].replace(/_/g, ' ');
  }
  return null;
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

function cssUnitlessOrLength(value: string): string | null {
  const trimmed = value.trim();
  if (/^[-+]?\d*\.?\d+$/.test(trimmed)) return trimmed;
  return cssLength(trimmed);
}

function parseValue(kind: ValuePropertyKind, raw: string): ParsedValue | null {
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

  const css = cssLength(value);
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
    const token = Object.entries(RADIUS_VALUES).find(([, current]) => current === css)?.[0];
    return { token: token ?? arbitraryToken('rounded', css), style: { 'border-radius': css } };
  }

  const token = Object.entries(BLUR_VALUES).find(([, current]) => current === css)?.[0];
  return { token: token ?? arbitraryToken('blur', css), style: { filter: `blur(${css})` } };
}

function resetSpec(kind: ValuePropertyKind): ResetSpec {
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
    return {
      match: (token) => token === 'rounded' || token.startsWith('rounded-'),
      cssProps: ['border-radius'],
    };
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
}: {
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
}) {
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
