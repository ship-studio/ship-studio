import { useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';

const ELLIPSIS = '…';

interface Segmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

interface Typography {
  font: string;
  letterSpacing: number;
  letterSpacingCss: string;
  fontFamily: string;
  fontSize: string;
  fontStyle: string;
  fontVariant: string;
  fontWeight: string;
  fontStretch: string;
  lineHeight: string;
  wordSpacing: string;
  textTransform: string;
  direction: string;
}

/** Props for text that preserves both ends while truncating its middle to fit. */
export interface MiddleTruncateProps extends HTMLAttributes<HTMLSpanElement> {
  text: string;
}

let sharedCanvasContext: CanvasRenderingContext2D | null | undefined;
let sharedGraphemeSegmenter: Segmenter | null | undefined;

function getGraphemeSegmenter(): Segmenter | null {
  if (sharedGraphemeSegmenter !== undefined) return sharedGraphemeSegmenter;
  if (typeof Intl === 'undefined') {
    sharedGraphemeSegmenter = null;
    return sharedGraphemeSegmenter;
  }

  const intlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity: 'grapheme' }
    ) => Segmenter;
  };

  if (typeof intlWithSegmenter.Segmenter !== 'function') {
    sharedGraphemeSegmenter = null;
    return sharedGraphemeSegmenter;
  }

  try {
    sharedGraphemeSegmenter = new intlWithSegmenter.Segmenter(undefined, {
      granularity: 'grapheme',
    });
  } catch {
    sharedGraphemeSegmenter = null;
  }

  return sharedGraphemeSegmenter;
}

function segmentText(text: string): string[] {
  const segmenter = getGraphemeSegmenter();
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

function getCanvasContext(): CanvasRenderingContext2D | null {
  if (sharedCanvasContext !== undefined) return sharedCanvasContext;
  if (typeof document === 'undefined') {
    sharedCanvasContext = null;
    return sharedCanvasContext;
  }

  try {
    sharedCanvasContext = document.createElement('canvas').getContext('2d');
  } catch {
    sharedCanvasContext = null;
  }
  return sharedCanvasContext;
}

function readTypography(element: HTMLElement): Typography {
  const computed = window.getComputedStyle(element);
  const fontSize = computed.fontSize || '1em';
  const fontFamily = computed.fontFamily || 'sans-serif';
  const font =
    computed.font ||
    `${computed.fontStyle || 'normal'} ${computed.fontWeight || '400'} ${fontSize} ${fontFamily}`;
  const letterSpacingCss = computed.letterSpacing || 'normal';
  const parsedLetterSpacing = Number.parseFloat(letterSpacingCss);

  return {
    font,
    letterSpacing: Number.isFinite(parsedLetterSpacing) ? parsedLetterSpacing : 0,
    letterSpacingCss,
    fontFamily,
    fontSize,
    fontStyle: computed.fontStyle || 'normal',
    fontVariant: computed.fontVariant || 'normal',
    fontWeight: computed.fontWeight || '400',
    fontStretch: computed.fontStretch || 'normal',
    lineHeight: computed.lineHeight || 'normal',
    wordSpacing: computed.wordSpacing || 'normal',
    textTransform: computed.textTransform || 'none',
    direction: computed.direction || 'ltr',
  };
}

function applyTypography(element: HTMLElement, typography: Typography) {
  element.style.font = typography.font;
  element.style.letterSpacing = typography.letterSpacingCss;
  element.style.fontFamily = typography.fontFamily;
  element.style.fontSize = typography.fontSize;
  element.style.fontStyle = typography.fontStyle;
  element.style.fontVariant = typography.fontVariant;
  element.style.fontWeight = typography.fontWeight;
  element.style.fontStretch = typography.fontStretch;
  element.style.lineHeight = typography.lineHeight;
  element.style.wordSpacing = typography.wordSpacing;
  element.style.textTransform = typography.textTransform;
  element.style.direction = typography.direction;
}

function measureDomText(element: HTMLElement | null, text: string, typography: Typography): number {
  if (!element) return 0;
  applyTypography(element, typography);
  element.textContent = text;
  const rect = element.getBoundingClientRect();
  const width = rect.width || element.scrollWidth || element.offsetWidth;
  return Number.isFinite(width) ? width : 0;
}

function measureCanvasText(text: string, typography: Typography): number | null {
  if (!text) return 0;
  const context = getCanvasContext();
  if (!context) return null;

  try {
    context.font = typography.font;
    if ('direction' in context) context.direction = typography.direction as CanvasDirection;
    const glyphWidth = context.measureText(text).width;
    const letterSpacingWidth = typography.letterSpacing * Math.max(0, segmentText(text).length - 1);
    return glyphWidth + letterSpacingWidth;
  } catch {
    return null;
  }
}

function measureText(
  text: string,
  typography: Typography,
  measurementElement: HTMLElement | null
): number {
  return (
    measureCanvasText(text, typography) ?? measureDomText(measurementElement, text, typography)
  );
}

function readAvailableWidth(element: HTMLElement): number {
  const rectWidth = element.getBoundingClientRect().width;
  if (rectWidth > 0) return rectWidth;
  if (element.clientWidth > 0) return element.clientWidth;

  const computedWidth = Number.parseFloat(window.getComputedStyle(element).width);
  if (Number.isFinite(computedWidth)) return Math.max(0, computedWidth);
  return Math.max(0, rectWidth);
}

function composeCandidate(parts: string[], prefixCount: number, suffixCount: number): string {
  const prefix = parts.slice(0, prefixCount).join('');
  const suffix = suffixCount > 0 ? parts.slice(-suffixCount).join('') : '';
  return `${prefix}${ELLIPSIS}${suffix}`;
}

function findCandidate(
  text: string,
  availableWidth: number,
  typography: Typography,
  measurementElement: HTMLElement | null
): string {
  if (!text || availableWidth <= 0) return text ? ELLIPSIS : '';

  const parts = segmentText(text);
  const fullWidth = measureText(text, typography, measurementElement);
  if (fullWidth <= availableWidth) return text;

  let prefixCount = 0;
  let suffixCount = 0;
  let prefixWidth = 0;
  let suffixWidth = 0;

  while (prefixCount + suffixCount < parts.length) {
    const preferPrefix = prefixWidth <= suffixWidth;
    const sides = preferPrefix ? ['prefix', 'suffix'] : ['suffix', 'prefix'];
    let added = false;

    for (const side of sides) {
      if (side === 'prefix' && prefixCount >= parts.length - suffixCount) continue;
      if (side === 'suffix' && suffixCount >= parts.length - prefixCount) continue;

      const nextPrefixCount = side === 'prefix' ? prefixCount + 1 : prefixCount;
      const nextSuffixCount = side === 'suffix' ? suffixCount + 1 : suffixCount;
      const candidate = composeCandidate(parts, nextPrefixCount, nextSuffixCount);
      const candidateWidth = measureText(candidate, typography, measurementElement);
      if (candidateWidth > availableWidth) continue;

      prefixCount = nextPrefixCount;
      suffixCount = nextSuffixCount;
      prefixWidth = measureText(
        parts.slice(0, prefixCount).join(''),
        typography,
        measurementElement
      );
      suffixWidth = measureText(
        suffixCount > 0 ? parts.slice(-suffixCount).join('') : '',
        typography,
        measurementElement
      );
      added = true;
      break;
    }

    if (!added) break;
  }

  let candidate = composeCandidate(parts, prefixCount, suffixCount);
  while (measureDomText(measurementElement, candidate, typography) > availableWidth) {
    if (prefixCount === 0 && suffixCount === 0) return ELLIPSIS;

    if (prefixCount > 0 && (suffixCount === 0 || prefixWidth >= suffixWidth)) {
      prefixCount -= 1;
    } else {
      suffixCount -= 1;
    }
    candidate = composeCandidate(parts, prefixCount, suffixCount);
    prefixWidth = measureText(parts.slice(0, prefixCount).join(''), typography, measurementElement);
    suffixWidth = measureText(
      suffixCount > 0 ? parts.slice(-suffixCount).join('') : '',
      typography,
      measurementElement
    );
  }

  return candidate;
}

function classNames(...names: Array<string | undefined>): string | undefined {
  const value = names.filter(Boolean).join(' ');
  return value || undefined;
}

/**
 * Shows a single-line string while preserving balanced, pixel-measured portions
 * of both ends. Truncation boundaries are grapheme-safe and react to changes in
 * the element's width and typography.
 */
export function MiddleTruncate({
  text,
  className,
  dir,
  'aria-label': ariaLabel,
  ...rest
}: MiddleTruncateProps) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [displayText, setDisplayText] = useState(text);
  const [isTruncated, setIsTruncated] = useState(false);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const measurementElement = document.createElement('span');
    measurementElement.className = 'middle-truncate__measure';
    measurementElement.setAttribute('aria-hidden', 'true');
    measurementElement.dir = dir ?? 'auto';
    document.body.appendChild(measurementElement);

    let frame: number | null = null;
    let disposed = false;

    const measure = () => {
      if (disposed) return;
      const typography = readTypography(element);
      const candidate = findCandidate(
        text,
        readAvailableWidth(element),
        typography,
        measurementElement
      );
      setDisplayText((current) => (current === candidate ? current : candidate));
      setIsTruncated((current) => {
        const next = candidate !== text;
        return current === next ? current : next;
      });
    };

    const scheduleMeasure = () => {
      if (disposed || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };

    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleMeasure) : null;
    resizeObserver?.observe(element);

    const mutationObserver =
      typeof MutationObserver === 'function' ? new MutationObserver(scheduleMeasure) : null;
    mutationObserver?.observe(element, {
      attributes: true,
      attributeFilter: ['class', 'style', 'dir'],
    });

    const fonts = document.fonts;
    const onFontChange = () => scheduleMeasure();
    fonts?.addEventListener?.('loadingdone', onFontChange);
    fonts?.addEventListener?.('loadingerror', onFontChange);
    if (fonts) void fonts.ready.then(onFontChange).catch(() => undefined);

    window.addEventListener('resize', scheduleMeasure);
    measure();

    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      fonts?.removeEventListener?.('loadingdone', onFontChange);
      fonts?.removeEventListener?.('loadingerror', onFontChange);
      window.removeEventListener('resize', scheduleMeasure);
      measurementElement.remove();
    };
  }, [dir, text]);

  return (
    <span
      {...rest}
      ref={elementRef}
      className={classNames('middle-truncate', className)}
      dir={dir ?? 'auto'}
      aria-label={isTruncated ? text : ariaLabel}
    >
      {displayText}
    </span>
  );
}
