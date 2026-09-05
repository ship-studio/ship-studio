/**
 * Small, forgiving media-query tokenizer for the CSS cascade editor.
 *
 * CSSOM gives the editor the condition without the `@media` keyword. The editor
 * keeps that condition as the source of truth, but exposes the useful pieces as
 * chips so authors can edit a media type, operator, feature, or value in place.
 */

export type MediaQueryChunkKind = 'at-rule' | 'type' | 'operator' | 'feature' | 'value' | 'literal';

export interface MediaQueryChunk {
  kind: MediaQueryChunkKind;
  value: string;
  /** The feature name that owns a value chip, when the query uses `(feature: value)`. */
  feature?: string;
}

export const MEDIA_TYPES = ['all', 'screen', 'print', 'speech'];
export const MEDIA_OPERATORS = ['and', 'or', 'not', 'only', ','];
export const MEDIA_FEATURES = [
  'width:',
  'min-width:',
  'max-width:',
  'height:',
  'min-height:',
  'max-height:',
  'orientation:',
  'aspect-ratio:',
  'resolution:',
  'color:',
  'monochrome:',
  'hover:',
  'any-hover:',
  'pointer:',
  'any-pointer:',
  'prefers-color-scheme:',
  'prefers-reduced-motion:',
  'prefers-contrast:',
  'display-mode:',
  'forced-colors:',
  'inverted-colors:',
];

const WIDTH_VALUES = [
  '320px',
  '375px',
  '480px',
  '640px',
  '767px',
  '768px',
  '1024px',
  '1280px',
  '1440px',
  '1536px',
];

const FEATURE_VALUES: Record<string, string[]> = {
  width: WIDTH_VALUES,
  'min-width': WIDTH_VALUES,
  'max-width': WIDTH_VALUES,
  height: ['480px', '667px', '768px', '900px', '1080px'],
  'min-height': ['480px', '667px', '768px', '900px', '1080px'],
  'max-height': ['480px', '667px', '768px', '900px', '1080px'],
  orientation: ['portrait', 'landscape'],
  'aspect-ratio': ['1 / 1', '4 / 3', '16 / 9', '21 / 9'],
  resolution: ['1dppx', '2dppx', '192dpi', '384dpi'],
  color: ['0', '1', '8', '24'],
  monochrome: ['0', '1', '8'],
  hover: ['hover', 'none'],
  'any-hover': ['hover', 'none'],
  pointer: ['fine', 'coarse', 'none'],
  'any-pointer': ['fine', 'coarse', 'none'],
  'prefers-color-scheme': ['light', 'dark', 'no-preference'],
  'prefers-reduced-motion': ['no-preference', 'reduce'],
  'prefers-contrast': ['no-preference', 'less', 'more', 'custom'],
  'display-mode': ['browser', 'standalone', 'fullscreen', 'minimal-ui'],
  'forced-colors': ['none', 'active'],
  'inverted-colors': ['none', 'inverted'],
};

const GENERIC_VALUES = [
  ...WIDTH_VALUES,
  'auto',
  'none',
  'light',
  'dark',
  'portrait',
  'landscape',
  'fine',
  'coarse',
  'reduce',
  'no-preference',
];

function findClosingParen(source: string, start: number): number {
  let depth = 0;
  let quote = '';
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findTopLevelColon(source: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

function kindForWord(word: string): MediaQueryChunkKind {
  const normalized = word.toLowerCase();
  if (MEDIA_TYPES.includes(normalized)) return 'type';
  if (MEDIA_OPERATORS.includes(normalized)) return 'operator';
  return 'literal';
}

/** Parse a CSS media condition into editable visual chunks. */
export function parseMediaQuery(condition: string): MediaQueryChunk[] {
  const chunks: MediaQueryChunk[] = [];
  let cursor = 0;

  while (cursor < condition.length) {
    while (/\s/.test(condition[cursor] ?? '')) cursor += 1;
    if (cursor >= condition.length) break;

    if (condition[cursor] === ',') {
      chunks.push({ kind: 'operator', value: ',' });
      cursor += 1;
      continue;
    }

    if (condition[cursor] === '(') {
      const close = findClosingParen(condition, cursor);
      if (close < 0) {
        chunks.push({ kind: 'literal', value: condition.slice(cursor).trim() });
        break;
      }
      const inner = condition.slice(cursor + 1, close).trim();
      const colon = findTopLevelColon(inner);
      if (colon > 0) {
        const feature = inner.slice(0, colon).trim();
        const value = inner.slice(colon + 1).trim();
        if (feature) {
          chunks.push({ kind: 'feature', value: `${feature}:` });
          if (value) chunks.push({ kind: 'value', value, feature });
        }
      } else {
        chunks.push({ kind: 'literal', value: `(${inner})` });
      }
      cursor = close + 1;
      continue;
    }

    const start = cursor;
    while (cursor < condition.length && !/[\s,(]/.test(condition[cursor])) cursor += 1;
    const word = condition.slice(start, cursor).trim();
    if (word) chunks.push({ kind: kindForWord(word), value: word });
  }

  return chunks;
}

function appendWord(output: string, word: string): string {
  if (!output) return word;
  if (output.endsWith(' ') || output.endsWith(',')) return `${output}${word}`;
  return `${output} ${word}`;
}

/** Rebuild the source condition from its visual chunks. */
export function serializeMediaQuery(chunks: readonly MediaQueryChunk[]): string {
  let output = '';
  let featureOpen = false;

  for (const chunk of chunks) {
    const value = chunk.value.trim();
    if (!value || chunk.kind === 'at-rule') continue;

    if (chunk.kind === 'feature') {
      if (featureOpen) output += ')';
      output = appendWord(output, `(${value.replace(/\s*:\s*$/, ':')}`);
      featureOpen = true;
      continue;
    }

    if (featureOpen && chunk.kind === 'value') {
      output += ` ${value})`;
      featureOpen = false;
      continue;
    }

    if (featureOpen) {
      output += ')';
      featureOpen = false;
    }

    if (value === ',') {
      output = `${output.trimEnd()}, `;
    } else {
      output = appendWord(output, value);
    }
  }

  if (featureOpen) output += ')';
  return output.trim();
}

/** Whether a media condition has enough structure to be safely written to CSS. */
export function isMediaQueryComplete(condition: string): boolean {
  const source = condition.trim();
  if (!source) return false;

  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  if (quote || depth !== 0) return false;

  const chunks = parseMediaQuery(source);
  if (chunks.length === 0) return false;
  if (
    chunks.some((chunk, index) => chunk.kind === 'feature' && chunks[index + 1]?.kind !== 'value')
  ) {
    return false;
  }
  const last = chunks[chunks.length - 1];
  return last.kind !== 'operator' && last.kind !== 'feature' && last.kind !== 'at-rule';
}

/** Normalize a value before it is put back into the chunk model. */
export function normalizeMediaQueryChunk(kind: MediaQueryChunkKind, value: string): string {
  const trimmed = value.trim();
  if (kind === 'feature') return `${trimmed.replace(/\s*:\s*$/, '')}:`;
  if (kind === 'type' || kind === 'operator' || kind === 'at-rule') {
    return trimmed === ',' ? trimmed : trimmed.toLowerCase();
  }
  return trimmed;
}

function featureKey(feature?: string): string {
  return (feature ?? '')
    .replace(/\s*:\s*$/, '')
    .trim()
    .toLowerCase();
}

/** Suggest values appropriate to the chunk currently being edited. */
export function suggestMediaQueryChunks(
  kind: MediaQueryChunkKind,
  query: string,
  feature?: string
): string[] {
  const source =
    kind === 'at-rule'
      ? ['@media']
      : kind === 'type'
        ? MEDIA_TYPES
        : kind === 'operator'
          ? MEDIA_OPERATORS
          : kind === 'feature'
            ? MEDIA_FEATURES
            : kind === 'value'
              ? (FEATURE_VALUES[featureKey(feature)] ?? GENERIC_VALUES)
              : [];
  const q = query.trim().toLowerCase();
  if (!q) return [...source];
  const starts = source.filter((item) => item.toLowerCase().startsWith(q));
  const contains = source.filter(
    (item) => !item.toLowerCase().startsWith(q) && item.toLowerCase().includes(q)
  );
  return [...starts, ...contains];
}
