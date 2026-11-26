/**
 * Shared colour picker used by the visual editor, CSS controls, and declaration
 * popover. Callbacks use the selected CSS representation so the authored value
 * keeps the format chosen in the picker. HSB remains editor-only because CSS
 * has no hsb() syntax, so that selection emits standards-compliant RGB.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { converter } from 'culori';
import { parseColor } from '../../lib/parseColor';
import { HsvaColorPicker, type HsvaColor } from 'react-colorful';
import { useCommands } from '../../commands/useCommands';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useLocalStorageFlag } from '../../hooks/useLocalStorageFlag';
import {
  contrastRatio,
  contrastThreshold,
  resolveColorVariable,
  type ColorVariableDefinition,
  type ColorContrastContext,
  type ContrastCategory,
  type ContrastLevel,
} from '../../lib/colorContrast';
import { formatNumericValue, parseNumericValue } from '../../lib/cssProperties';
import {
  COLOR_FORMATS,
  colorPickerFloatingHeight,
  hsvaToCss,
  rgbaToCss,
  toCss,
  toFormat,
  toHex,
  toHsva,
  toRgba,
  updateHsvaChannel,
  type ColorFormat,
  type Hsva,
} from '../../lib/color';
import { getColorSamplerSupport, sampleScreenColor } from '../../lib/color-sampler';
import { logger } from '../../lib/logger';
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  ColorPickerIcon,
  ContrastIcon,
  CopyIcon,
  SettingsSlidersIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { ToggleButton } from '../primitives/ToggleButton';
import { ColorContrastOverlay } from './ColorContrastOverlay';
import { ColorPickerVariables } from './ColorPickerVariables';
import { useColorPickerRecent } from './useColorPickerRecent';

const toHsl = converter('hsl');
const toOklch = converter('oklch');
const toRgb = converter('rgb');
const colorSwatchStyle = (color: string) => ({ '--picker-swatch-color': color }) as CSSProperties;
const DEFAULT_RECENT_COLORS = ['#ffffff', '#000000'] as const;
const CONTRAST_CHECKER_STORAGE_KEY = 'shipstudio.color-picker.contrast-checker';

type ChannelId = 'hex' | 'r' | 'g' | 'b' | 'h' | 's' | 'l' | 'v' | 'c' | 'a';

interface ChannelDefinition {
  id: ChannelId;
  label: string;
  value: string;
  step?: number;
  suffix?: string;
  ariaLabel?: string;
}

interface HslChannelValues {
  h: number;
  s: number;
  l: number;
  alpha: number;
}

interface Props {
  /** Resolved CSS color string used for rendering and contrast calculations. */
  value: string;
  /** Fires in the selected CSS format as the color or format changes. */
  onChange: (css: string) => void;
  /** Closes the picker and returns focus to the trigger. */
  onClose: () => void;
  /** Background and semantic target supplied by the active editor selection. */
  contrastContext?: ColorContrastContext;
  /** Authored project color tokens; unresolved values remain unavailable. */
  variables?: readonly ColorVariableDefinition[];
  /** CSS selector whose declarations are being edited, when known. */
  variableSelector?: string;
  /** Used to keep recent colors isolated to the active project. */
  projectPath?: string;
  /** Original authored CSS syntax, retained when it is a color variable. */
  authoredValue?: string;
  /** Reports the content height used by the non-resizable floating surface. */
  onHeightChange?: (height: number) => void;
}

type PickerMode = 'custom' | 'variables';
type CategorySelection = 'auto' | ContrastCategory;
type AuthoredOverride = { value: string | null };
type DisplayOverride = { value: string | null };

const EMPTY_VARIABLES: readonly ColorVariableDefinition[] = [];

const CATEGORY_LABELS: Record<ContrastCategory, string> = {
  'normal-text': 'Normal text',
  'large-text': 'Large text',
  graphics: 'Graphics',
};

function isVariableValue(value: string | undefined): boolean {
  return /^var\(/i.test(value?.trim() ?? '');
}

function inferColorFormat(value: string | undefined): ColorFormat {
  const candidate = value?.trim() ?? '';
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(candidate)) return 'hex';
  if (/^rgba?\(/i.test(candidate)) return 'rgb';
  if (/^hsla?\(/i.test(candidate)) return 'hsl';
  if (/^(?:hsba?|hsva?)\(/i.test(candidate)) return 'hsb';
  if (/^oklch\(/i.test(candidate)) return 'oklch';
  return 'hsl';
}

function resolvePickerValue(
  value: string,
  authoredValue: string | undefined,
  variables: readonly ColorVariableDefinition[],
  selector?: string
): string | null {
  const resolvedValue = toCss(value);
  if (resolvedValue) return resolvedValue;

  const authored = authoredValue?.trim();
  if (authored && isVariableValue(authored)) {
    const resolved = resolveColorVariable(authored, variables, selector);
    return resolved ? toCss(resolved) : null;
  }
  if (authored) {
    const parsedAuthored = toCss(authored);
    if (parsedAuthored) return parsedAuthored;
  }
  return null;
}

function resolveContrastColor(
  value: string | undefined,
  variables: readonly ColorVariableDefinition[],
  selector?: string
): string | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const resolved = isVariableValue(trimmed)
    ? resolveColorVariable(trimmed, variables, selector)
    : trimmed;
  // Preserve fractional computed RGB channels. Canonicalizing through toCss()
  // rounds them to integer channels before WCAG luminance is calculated.
  return resolved && parseColor(resolved) ? resolved : null;
}

const round = (number: number, places = 0) => {
  const factor = 10 ** places;
  return String(Math.round((number + Number.EPSILON) * factor) / factor);
};

const clamp = (number: number, min: number, max: number) => Math.max(min, Math.min(max, number));

const normalizeHue = (number: number) => {
  const normalized = number % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function alphaPercent(alpha: number): string {
  return round(clamp(alpha, 0, 1) * 100);
}

function rgbObjectToCss(color: { r?: number; g?: number; b?: number; alpha?: number }): string {
  return rgbaToCss({
    r: Math.round(clamp((color.r ?? 0) * 255, 0, 255)),
    g: Math.round(clamp((color.g ?? 0) * 255, 0, 255)),
    b: Math.round(clamp((color.b ?? 0) * 255, 0, 255)),
    a: clamp(color.alpha ?? 1, 0, 1),
  });
}

function currentColor(value: string) {
  return parseColor(value) ?? parseColor('#000000')!;
}

function hslChannelValues(value: string): HslChannelValues {
  const hsl = toHsl(currentColor(value));
  return {
    h: hsl.h ?? 0,
    s: hsl.s ?? 0,
    l: hsl.l ?? 0,
    alpha: hsl.alpha ?? 1,
  };
}

function channelDefinitions(
  value: string,
  format: ColorFormat,
  hsva: Hsva,
  hslValues?: HslChannelValues
): ChannelDefinition[] {
  const rgba = toRgba(value);
  const alpha = alphaPercent(rgba.a);

  if (format === 'hex') {
    return [
      { id: 'hex', label: 'Hex', value: toHex(value) ?? '#000000' },
      { id: 'a', label: 'A', ariaLabel: 'Alpha', value: alpha, suffix: '%' },
    ];
  }

  if (format === 'rgb') {
    return [
      { id: 'r', label: 'R', value: String(rgba.r) },
      { id: 'g', label: 'G', value: String(rgba.g) },
      { id: 'b', label: 'B', value: String(rgba.b) },
      { id: 'a', label: 'A', ariaLabel: 'Alpha', value: alpha, suffix: '%' },
    ];
  }

  if (format === 'hsl') {
    const hsl = hslValues ?? hslChannelValues(value);
    return [
      { id: 'h', label: 'H', value: round(normalizeHue(hsl.h ?? 0), 1) },
      { id: 's', label: 'S', value: round(clamp(hsl.s ?? 0, 0, 1) * 100), suffix: '%' },
      { id: 'l', label: 'L', value: round(clamp(hsl.l ?? 0, 0, 1) * 100), suffix: '%' },
      { id: 'a', label: 'A', ariaLabel: 'Alpha', value: alpha, suffix: '%' },
    ];
  }

  if (format === 'hsb') {
    // Read the live HSB state, not a round-trip through RGB: black and the greys
    // have no recoverable hue/saturation, so re-deriving them here would reset the
    // fields to 0 the moment brightness hit 0.
    return [
      { id: 'h', label: 'H', value: round(normalizeHue(hsva.h), 1) },
      { id: 's', label: 'S', value: round(clamp(hsva.s, 0, 100)), suffix: '%' },
      { id: 'v', label: 'B', value: round(clamp(hsva.v, 0, 100)), suffix: '%' },
      { id: 'a', label: 'A', ariaLabel: 'Alpha', value: alpha, suffix: '%' },
    ];
  }

  const oklch = toOklch(currentColor(value));
  return [
    {
      id: 'l',
      label: 'L',
      value: round(clamp(oklch.l ?? 0, 0, 1) * 100, 1),
      suffix: '%',
    },
    { id: 'c', label: 'C', value: round(clamp(oklch.c ?? 0, 0, 0.4), 3), step: 0.001 },
    { id: 'h', label: 'H', value: round(normalizeHue(oklch.h ?? 0), 1) },
    { id: 'a', label: 'A', ariaLabel: 'Alpha', value: alpha, suffix: '%' },
  ];
}

/** Apply one typed channel value, in the CSS-representable formats. HSB is handled
 *  on the picker's own HSVA state instead — see `updateField`. */
function updateChannel(
  value: string,
  format: ColorFormat,
  channel: ChannelId,
  raw: string
): string | null {
  const rgba = toRgba(value);
  const number = parseNumber(raw);

  if (format === 'hex') {
    if (channel === 'hex') {
      const candidate = raw.trim().startsWith('#') ? raw.trim() : `#${raw.trim()}`;
      if (!toCss(candidate)) return null;
      return rgbaToCss({ ...toRgba(candidate), a: rgba.a });
    }
    if (channel === 'a' && number !== null) {
      return rgbaToCss({ ...rgba, a: clamp(number, 0, 100) / 100 });
    }
    return null;
  }

  if (format === 'rgb') {
    if (channel === 'a' && number !== null) {
      return rgbaToCss({ ...rgba, a: clamp(number, 0, 100) / 100 });
    }
    if ((channel === 'r' || channel === 'g' || channel === 'b') && number !== null) {
      return rgbaToCss({ ...rgba, [channel]: clamp(number, 0, 255) });
    }
    return null;
  }

  if (format === 'hsl') {
    const hsl = toHsl(currentColor(value));
    if (channel === 'a' && number !== null) hsl.alpha = clamp(number, 0, 100) / 100;
    else if (channel === 'h' && number !== null) hsl.h = normalizeHue(number);
    else if (channel === 's' && number !== null) hsl.s = clamp(number, 0, 100) / 100;
    else if (channel === 'l' && number !== null) hsl.l = clamp(number, 0, 100) / 100;
    else return null;
    return rgbObjectToCss(toRgb(hsl));
  }

  const oklch = toOklch(currentColor(value));
  if (channel === 'a' && number !== null) oklch.alpha = clamp(number, 0, 100) / 100;
  else if (channel === 'l' && number !== null) oklch.l = clamp(number, 0, 100) / 100;
  else if (channel === 'c' && number !== null) oklch.c = clamp(number, 0, 0.4);
  else if (channel === 'h' && number !== null) oklch.h = normalizeHue(number);
  else return null;
  return rgbObjectToCss(toRgb(oklch));
}

function ChannelField({
  channel,
  onChange,
  onScrub,
  onScrubEnd,
}: {
  channel: ChannelDefinition;
  onChange: (raw: string) => boolean;
  onScrub: (raw: string) => boolean;
  onScrubEnd: () => void;
}) {
  const fieldValue = (value: string) => `${value}${channel.suffix ?? ''}`;
  const channelValue = (value: string) =>
    channel.suffix ? value.split(channel.suffix).join('') : value;
  const [draft, setDraft] = useState(() => fieldValue(channel.value));
  const [syncedValue, setSyncedValue] = useState(channel.value);
  const drag = useRef<{
    x: number;
    num: number;
    decimals: number;
    moved: boolean;
    lastDelta: number;
  } | null>(null);
  const canScrub = channel.id !== 'hex' && Boolean(channel.label);
  if (syncedValue !== channel.value) {
    setSyncedValue(channel.value);
    setDraft(fieldValue(channel.value));
  }

  const commitIfValid = () => {
    const value = channelValue(draft);
    if (!onChange(value)) {
      setDraft(fieldValue(channel.value));
      return;
    }
    setDraft(fieldValue(value));
  };

  const handleScrubStart = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!canScrub || event.button !== 0) return;
    const parsed = parseNumericValue(channel.value);
    if (!parsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      x: event.clientX,
      num: parsed.num,
      decimals: parsed.decimals,
      moved: false,
      lastDelta: 0,
    };
  };

  const handleScrubMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const start = drag.current;
    if (!start) return;
    const delta = event.clientX - start.x;
    if (delta === start.lastDelta) return;
    start.lastDelta = delta;
    const base = channel.step ?? 1;
    const step = event.shiftKey ? base * 10 : event.altKey ? base / 10 : base;
    const stepDecimals = Math.max(0, (step.toString().split('.')[1] ?? '').length);
    const next = start.num + delta * step;
    if (onScrub(formatNumericValue(next, '', Math.max(start.decimals, stepDecimals)))) {
      start.moved = true;
    }
  };

  const handleScrubEnd = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const session = drag.current;
    if (!session) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (session.moved) onScrubEnd();
  };

  return (
    <label className="ss-color-picker__field">
      {channel.label && (
        <span
          className={`ss-color-picker__field-label${
            canScrub ? ' ss-color-picker__field-label--scrubbable' : ''
          }`}
          title={canScrub ? 'Drag to adjust · Shift ×10 · Alt ÷10' : undefined}
          onPointerDown={handleScrubStart}
          onPointerMove={handleScrubMove}
          onPointerUp={handleScrubEnd}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          {channel.label}
        </span>
      )}
      <input
        aria-label={channel.ariaLabel ?? channel.label}
        className="ss-color-picker__field-input"
        inputMode={channel.id === 'hex' ? 'text' : 'decimal'}
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commitIfValid}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitIfValid();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

interface EyeDropperResult {
  sRGBHex: string;
}

interface EyeDropperLike {
  open: () => Promise<EyeDropperResult>;
}

type EyeDropperConstructor = new () => EyeDropperLike;

function eyeDropperConstructor(): EyeDropperConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper;
}

function isEyeDropperCancellation(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'AbortError' || name === 'NotAllowedError';
}

export function ColorPicker({
  value,
  onChange,
  onClose,
  contrastContext,
  variables: suppliedVariables,
  variableSelector,
  projectPath,
  authoredValue,
  onHeightChange,
}: Props) {
  const variables = suppliedVariables ?? EMPTY_VARIABLES;
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const initialAuthoredValue = authoredValue ?? value;
  const initialIsVariable = isVariableValue(initialAuthoredValue);
  const [format, setFormat] = useState<ColorFormat>(() =>
    inferColorFormat(initialIsVariable ? value : initialAuthoredValue)
  );
  const [mode, setMode] = useState<PickerMode>(() => (initialIsVariable ? 'variables' : 'custom'));
  const [contrastEnabled, , toggleContrastEnabled] = useLocalStorageFlag(
    CONTRAST_CHECKER_STORAGE_KEY,
    false
  );
  const [categorySelection, setCategorySelection] = useState<CategorySelection>('auto');
  const [level, setLevel] = useState<ContrastLevel>('AA');
  const [authoredOverride, setAuthoredOverride] = useState<AuthoredOverride | null>(null);
  const [displayOverride, setDisplayOverride] = useState<DisplayOverride | null>(null);
  const currentAuthoredValue = authoredOverride
    ? (authoredOverride.value ?? undefined)
    : authoredValue;
  const baseDisplayValue = resolvePickerValue(
    value,
    currentAuthoredValue,
    variables,
    variableSelector
  );
  const displayValue = displayOverride ? displayOverride.value : baseDisplayValue;
  const [originalAuthoredValue] = useState(authoredValue);
  const [originalResolvedColor] = useState(() =>
    resolvePickerValue(value, authoredValue, variables, variableSelector)
  );
  const [originalHsva] = useState(() => toHsva(originalResolvedColor ?? '#000000'));
  const [hsva, setHsva] = useState(() => toHsva(displayValue ?? '#000000'));
  const [hslValues, setHslValues] = useState(() => hslChannelValues(displayValue ?? '#000000'));
  const [syncedPropValue, setSyncedPropValue] = useState(value);
  const [syncedValue, setSyncedValue] = useState(displayValue);
  const [syncedAuthoredValue, setSyncedAuthoredValue] = useState(authoredValue);
  const eyeDropperActiveRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const reportedHeightRef = useRef<number | null>(null);
  const visualRef = useRef<HTMLDivElement>(null);
  const pointerSessionRef = useRef(false);
  const keyboardSessionRef = useRef(false);
  const { colors: recentColors, recordColor } = useColorPickerRecent(projectPath);
  const visibleRecentColors = recentColors.length > 0 ? recentColors : DEFAULT_RECENT_COLORS;

  if (syncedAuthoredValue !== authoredValue) {
    setSyncedAuthoredValue(authoredValue);
    setAuthoredOverride(null);
    setDisplayOverride(null);
  }

  if (syncedPropValue !== value) {
    setSyncedPropValue(value);
    setAuthoredOverride(null);
    setDisplayOverride(null);
  }

  if (syncedValue !== displayValue) {
    setSyncedValue(displayValue);
    if (displayValue) {
      const external = toRgba(displayValue);
      const current = toRgba(hsvaToCss(hsva));
      if (
        external.r !== current.r ||
        external.g !== current.g ||
        external.b !== current.b ||
        external.a !== current.a
      ) {
        setHsva(toHsva(displayValue));
        setHslValues(hslChannelValues(displayValue));
      }
    }
  }

  const localValue = hsvaToCss(hsva);
  const rgba = toRgba(localValue);
  const originalRgba = toRgba(hsvaToCss(originalHsva));
  const hasResolvedColor = displayValue !== null;
  const channels = hasResolvedColor ? channelDefinitions(localValue, format, hsva, hslValues) : [];
  const eyeDropper = eyeDropperConstructor();
  const { data: nativeSamplerSupport, isLoading: isCheckingNativeSampler } = useAsyncState(
    getColorSamplerSupport,
    { immediate: true }
  );
  const nativeSampler = useAsyncState(sampleScreenColor, {
    onError: (error) => {
      logger.warn('[ColorPicker] Native color sampler failed', { error: String(error) });
    },
  });
  const eyeDropperAvailable = Boolean(eyeDropper || nativeSamplerSupport?.available);
  const eyeDropperTitle = eyeDropperAvailable
    ? 'Pick color from screen'
    : (nativeSamplerSupport?.reason ??
      (isCheckingNativeSampler
        ? 'Checking screen color support…'
        : 'Screen color sampling is unavailable in this webview.'));
  const { copy, isCopied, error: copyError } = useCopyToClipboard();

  const backgroundColor = useMemo(() => {
    if (contrastContext?.unavailableReason) return null;
    return resolveContrastColor(contrastContext?.backgroundColor, variables, variableSelector);
  }, [
    contrastContext?.backgroundColor,
    contrastContext?.unavailableReason,
    variableSelector,
    variables,
  ]);
  const foregroundColor = hasResolvedColor ? toCss(localValue) : null;
  const contrastValue =
    foregroundColor && backgroundColor ? contrastRatio(foregroundColor, backgroundColor) : null;
  const effectiveCategory =
    categorySelection === 'auto' ? (contrastContext?.category ?? null) : categorySelection;
  const aaaAllowed = effectiveCategory === 'normal-text' || effectiveCategory === 'large-text';
  const effectiveLevel: ContrastLevel = level === 'AAA' && aaaAllowed ? 'AAA' : 'AA';
  const requiredRatio = effectiveCategory
    ? contrastThreshold(effectiveCategory, effectiveLevel)
    : null;
  const passes =
    contrastValue !== null && requiredRatio !== null ? contrastValue >= requiredRatio : null;
  const categoryLabel = effectiveCategory ? CATEGORY_LABELS[effectiveCategory] : null;
  const autoCategoryLabel = categoryLabel ? `Auto (${categoryLabel})` : 'Auto (not detected)';
  const unavailableReason = contrastContext?.unavailableReason
    ? contrastContext.unavailableReason
    : !backgroundColor
      ? 'Background color is unavailable for this selection.'
      : !foregroundColor
        ? 'Foreground color is unavailable.'
        : !effectiveCategory
          ? 'Choose a contrast category to check the required level.'
          : 'Contrast ratio is unavailable for these colors.';
  // Truncate rather than round: WCAG compares the unrounded ratio, so 4.497 must
  // read 4.49 next to its AA failure, never 4.50.
  const contrastRatioLabel =
    contrastValue === null ? '— : 1' : `${(Math.floor(contrastValue * 100) / 100).toFixed(2)} : 1`;
  const hasAnyContrastColor = Boolean(foregroundColor || backgroundColor);
  const copyValue = toFormat(localValue, format) || rgbaToCss(rgba);
  const copyLabel = isCopied ? 'Copied color' : copyError ? 'Copy color failed' : 'Copy color';
  const usesOverflowFormat = format === 'oklch';
  const selectedFormatLabel = COLOR_FORMATS.find((option) => option.id === format)?.label ?? format;
  const currentAuthoredIsVariable = isVariableValue(currentAuthoredValue);

  const recordCurrentColor = useCallback(() => {
    if (displayValue) recordColor(displayValue);
  }, [displayValue, recordColor]);

  const finishPointerSession = useCallback(() => {
    if (!pointerSessionRef.current) return;
    pointerSessionRef.current = false;
    recordCurrentColor();
  }, [recordCurrentColor]);

  useEffect(() => {
    window.addEventListener('pointerup', finishPointerSession);
    window.addEventListener('pointercancel', finishPointerSession);
    window.addEventListener('mouseup', finishPointerSession);
    window.addEventListener('touchend', finishPointerSession);
    window.addEventListener('touchcancel', finishPointerSession);
    window.addEventListener('blur', finishPointerSession);
    return () => {
      window.removeEventListener('pointerup', finishPointerSession);
      window.removeEventListener('pointercancel', finishPointerSession);
      window.removeEventListener('mouseup', finishPointerSession);
      window.removeEventListener('touchend', finishPointerSession);
      window.removeEventListener('touchcancel', finishPointerSession);
      window.removeEventListener('blur', finishPointerSession);
    };
  }, [finishPointerSession]);

  const emitHsva = useCallback(
    (next: Hsva, hslValues?: HslChannelValues) => {
      const resolved = hsvaToCss(next);
      setHsva(next);
      setHslValues(hslValues ?? hslChannelValues(resolved));
      setDisplayOverride({ value: resolved });
      setAuthoredOverride({ value: null });
      onChange(toFormat(resolved, format));
    },
    [format, onChange]
  );

  const selectFormat = useCallback(
    (next: ColorFormat) => {
      setFormat(next);
      if (hasResolvedColor && !currentAuthoredIsVariable) {
        onChange(toFormat(hsvaToCss(hsva), next));
      }
    },
    [currentAuthoredIsVariable, hasResolvedColor, hsva, onChange]
  );

  const updateColor = useCallback((next: HsvaColor) => emitHsva(next as Hsva), [emitHsva]);

  const updateField = useCallback(
    (channel: ChannelId, raw: string) => {
      if (!hasResolvedColor) return false;
      if (format === 'hsl') {
        const number = parseNumber(raw);
        if (number === null) return false;
        const hsl = { ...hslValues };
        if (channel === 'a') hsl.alpha = clamp(number, 0, 100) / 100;
        else if (channel === 'h') hsl.h = normalizeHue(number);
        else if (channel === 's') hsl.s = clamp(number, 0, 100) / 100;
        else if (channel === 'l') hsl.l = clamp(number, 0, 100) / 100;
        else return false;
        const next = rgbObjectToCss(toRgb({ mode: 'hsl', ...hsl }));
        emitHsva(toHsva(next), hsl);
        return true;
      }
      // HSB edits stay in HSVA. Round-tripping them through RGB would throw away
      // the hue and saturation of any colour RGB can't express them in (black,
      // greys), so typing B=0 then B=50 used to come back as grey.
      if (format === 'hsb') {
        const number = parseNumber(raw);
        if (number === null) return false;
        if (channel === 'a') {
          emitHsva(updateHsvaChannel(hsva, 'a', clamp(number, 0, 100) / 100));
          return true;
        }
        if (channel === 'h' || channel === 's' || channel === 'v') {
          emitHsva(updateHsvaChannel(hsva, channel, number));
          return true;
        }
        return false;
      }
      const next = updateChannel(hsvaToCss(hsva), format, channel, raw);
      if (next) emitHsva(toHsva(next));
      return next !== null;
    },
    [emitHsva, format, hasResolvedColor, hsva, hslValues]
  );

  const handleEyeDropper = async () => {
    // `isLoading` does not update until React renders. The ref closes the small
    // window in which a rapid second click could open another native sampler.
    if (eyeDropperActiveRef.current) return;
    eyeDropperActiveRef.current = true;

    try {
      if (eyeDropper) {
        const result = await new eyeDropper().open();
        const next = toCss(result.sRGBHex);
        if (next) {
          emitHsva(toHsva(next));
          recordColor(next);
        }
        return;
      }

      if (!nativeSamplerSupport?.available || nativeSampler.isLoading) return;

      const sampledColor = await nativeSampler.execute();
      const next = sampledColor ? toCss(sampledColor) : null;
      if (next) {
        emitHsva(toHsva(next));
        recordColor(next);
      }
    } catch (error) {
      if (!isEyeDropperCancellation(error)) {
        logger.warn('[ColorPicker] EyeDropper failed', { error: String(error) });
      }
    } finally {
      eyeDropperActiveRef.current = false;
    }
  };

  const selectVariable = (name: string, resolvedColor: string | null) => {
    const authored = `var(${name})`;
    setAuthoredOverride({ value: authored });
    setDisplayOverride({ value: resolvedColor });
    if (resolvedColor) {
      const next = toHsva(resolvedColor);
      setHsva(next);
      setHslValues(hslChannelValues(resolvedColor));
      recordColor(resolvedColor);
    }
    // Keep the CSS token authored. The resolved value is only used by the
    // visual controls and contrast calculations.
    onChange(authored);
  };

  const selectRecentColor = (color: string) => {
    emitHsva(toHsva(color));
    recordColor(color);
  };

  const restoreOriginal = () => {
    if (isVariableValue(originalAuthoredValue)) {
      const originalResolved = originalResolvedColor;
      setAuthoredOverride({ value: originalAuthoredValue! });
      setDisplayOverride({ value: originalResolved });
      setHsva(originalHsva);
      setHslValues(hslChannelValues(originalResolved ?? '#000000'));
      onChange(originalAuthoredValue!);
      if (originalResolved) recordColor(originalResolved);
      return;
    }
    emitHsva(originalHsva);
    recordColor(hsvaToCss(originalHsva));
  };

  const startColorPointerSession = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    if (
      target.closest('.react-colorful__saturation, .react-colorful__hue, .react-colorful__alpha')
    ) {
      pointerSessionRef.current = true;
    }
  };

  const handleColorKeyDown = (target: EventTarget | null, key: string) => {
    if (!(target instanceof Element)) return;
    if (
      [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'PageUp',
        'PageDown',
      ].includes(key) &&
      target.closest('.react-colorful__saturation, .react-colorful__hue, .react-colorful__alpha')
    ) {
      keyboardSessionRef.current = true;
    }
  };

  const finishKeyboardSession = () => {
    if (!keyboardSessionRef.current) return;
    keyboardSessionRef.current = false;
    recordCurrentColor();
  };

  const reportPickerHeight = useCallback(() => {
    const content = contentRef.current;
    if (!content || !onHeightChange) return;
    // Measure the content wrapper's natural border box. The floating panel
    // sizes its surface as border-box, so include that surface's chrome when
    // reporting the height needed to fit the content without scrolling.
    // Measuring the picker root's scrollHeight would feed the panel constraint
    // back into the next reported height in some WebViews.
    const surface = content.closest<HTMLElement>('.dockable-panel__surface--floating');
    const surfaceStyle = surface ? window.getComputedStyle(surface) : null;
    const surfaceChrome = surfaceStyle
      ? [
          surfaceStyle.borderBlockStartWidth,
          surfaceStyle.borderBlockEndWidth,
          surfaceStyle.paddingBlockStart,
          surfaceStyle.paddingBlockEnd,
        ].reduce((total, value) => total + (Number.parseFloat(value) || 0), 0)
      : 0;
    const height = colorPickerFloatingHeight(content.offsetHeight + surfaceChrome);
    if (height <= 0 || height === reportedHeightRef.current) return;
    reportedHeightRef.current = height;
    onHeightChange(height);
  }, [onHeightChange]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !onHeightChange) return;
    // The outer dialog stays scrollable when a short viewport cannot fit this
    // intrinsic content height.
    reportPickerHeight();
    const observer = new ResizeObserver(reportPickerHeight);
    observer.observe(content);
    window.addEventListener('resize', reportPickerHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reportPickerHeight);
    };
  }, [onHeightChange, reportPickerHeight]);

  useCommands(
    () => [
      {
        id: `color-picker.toggle-contrast.${instanceId}`,
        title: 'Toggle color contrast boundary',
        category: 'action',
        when: 'project',
        keywords: ['accessibility', 'contrast', 'color'],
        icon: <ContrastIcon size={14} />,
        run: toggleContrastEnabled,
      },
      {
        id: `color-picker.show-variables.${instanceId}`,
        title: 'Show project color variables',
        category: 'action',
        when: 'project',
        keywords: ['color', 'token', 'variable'],
        run: () => setMode('variables'),
      },
      {
        id: `color-picker.show-custom.${instanceId}`,
        title: 'Show custom color controls',
        category: 'action',
        when: 'project',
        keywords: ['color', 'picker', 'custom'],
        run: () => setMode('custom'),
      },
    ],
    [instanceId]
  );

  const pairTriggerLabel =
    contrastValue === null
      ? `Contrast color pair ratio unavailable: ${unavailableReason}`
      : `Contrast color pair, ${contrastRatioLabel}`;
  const settingsMenu = (
    <div className="ss-color-picker__settings-menu">
      <span className="ss-color-picker__menu-heading">Category</span>
      <DropdownItem
        active={categorySelection === 'auto'}
        onSelect={() => setCategorySelection('auto')}
      >
        {autoCategoryLabel}
      </DropdownItem>
      <DropdownItem
        active={categorySelection === 'large-text'}
        onSelect={() => setCategorySelection('large-text')}
      >
        Large text
      </DropdownItem>
      <DropdownItem
        active={categorySelection === 'normal-text'}
        onSelect={() => setCategorySelection('normal-text')}
      >
        Normal text
      </DropdownItem>
      <DropdownItem
        active={categorySelection === 'graphics'}
        onSelect={() => setCategorySelection('graphics')}
      >
        Graphics
      </DropdownItem>
      <DropdownDivider />
      <span className="ss-color-picker__menu-heading">Level</span>
      <DropdownItem active={effectiveLevel === 'AA'} onSelect={() => setLevel('AA')}>
        AA · {effectiveCategory ? `${contrastThreshold(effectiveCategory, 'AA')}:1` : 'Essential'}
      </DropdownItem>
      <DropdownItem
        active={effectiveLevel === 'AAA' && aaaAllowed}
        disabled={!aaaAllowed}
        onSelect={() => setLevel('AAA')}
      >
        AAA · Only for text
      </DropdownItem>
    </div>
  );

  return (
    <div className="ss-color-picker" role="dialog" aria-label="Color picker">
      <div ref={contentRef} className="ss-color-picker__content">
        <header className="ss-edit-panel__header ss-color-picker__header" data-dockable-drag-handle>
          <h2 className="ss-edit-panel__title workspace-panel-title">Color picker</h2>
          <IconButton
            className="ss-color-picker__action"
            size="compact"
            variant="ghost"
            icon={<CloseIcon size={14} />}
            aria-label="Close color picker"
            title="Close color picker"
            onClick={onClose}
          />
        </header>

        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as PickerMode)}
          size="default"
          className="ss-color-picker__controls"
        >
          <div className="ss-color-picker__mode-row">
            <TabsList className="ss-color-picker__mode-tabs" aria-label="Color source">
              <TabsTab value="custom">Custom</TabsTab>
              <TabsTab value="variables">Variables</TabsTab>
            </TabsList>
            <ToggleButton
              className="workspace-panel-toggle ss-color-picker__contrast-toggle button--icon-only"
              size="default"
              variant={contrastEnabled ? 'secondary' : 'default'}
              leftIcon={<ContrastIcon size={16} />}
              pressed={contrastEnabled}
              aria-label="Contrast checker"
              title="Contrast checker"
              onClick={toggleContrastEnabled}
            />
          </div>

          {contrastEnabled && (
            <div className="ss-color-picker__contrast-row" aria-live="polite">
              <Dropdown
                align="left"
                portal
                menuClassName="ss-color-picker__format-menu ss-color-picker__pair-menu"
                trigger={(triggerProps) => (
                  <Button
                    {...triggerProps}
                    className="ss-color-picker__pair-trigger"
                    size="default"
                    variant="ghost"
                    disabled={!hasAnyContrastColor}
                    aria-label={pairTriggerLabel}
                    title={contrastValue === null ? unavailableReason : 'Show contrast colors'}
                  >
                    <ContrastIcon size={14} />
                    <span className="ss-color-picker__ratio-value">{contrastRatioLabel}</span>
                    <ChevronIcon size={14} />
                  </Button>
                )}
              >
                <div
                  className="ss-color-picker__pair-values"
                  role="group"
                  aria-label="Contrast colors"
                >
                  <div className="ss-color-picker__pair-value">
                    <span>Foreground</span>
                    {foregroundColor ? (
                      <>
                        <span
                          className="ss-color-picker__pair-swatch ss-color-picker__swatch"
                          style={colorSwatchStyle(foregroundColor)}
                          aria-hidden="true"
                        />
                        <code>{toFormat(foregroundColor, 'hex')}</code>
                      </>
                    ) : (
                      <span className="ss-color-picker__pair-unavailable">Unavailable</span>
                    )}
                  </div>
                  <div className="ss-color-picker__pair-value">
                    <span>Background</span>
                    {backgroundColor ? (
                      <>
                        <span
                          className="ss-color-picker__pair-swatch ss-color-picker__swatch"
                          style={colorSwatchStyle(backgroundColor)}
                          aria-hidden="true"
                        />
                        <code>{toFormat(backgroundColor, 'hex')}</code>
                      </>
                    ) : (
                      <span className="ss-color-picker__pair-unavailable">Unavailable</span>
                    )}
                  </div>
                </div>
              </Dropdown>

              <span
                role="status"
                className={`ss-color-picker__contrast-status${
                  passes === true ? ' is-pass' : passes === false ? ' is-fail' : ' is-unavailable'
                }`}
                aria-label={
                  passes === null
                    ? `Contrast check unavailable. ${unavailableReason}`
                    : `${passes ? 'Pass' : 'Fail'} ${effectiveLevel}, ${requiredRatio}:1 required`
                }
                title={
                  passes === null ? unavailableReason : `${effectiveLevel} · ${requiredRatio}:1`
                }
              >
                {passes === true ? (
                  <CheckIcon size={16} />
                ) : passes === false ? (
                  <CloseIcon size={16} />
                ) : null}
                <span>
                  {passes === null ? 'Not checked' : `${effectiveLevel} · ${requiredRatio}:1`}
                </span>
              </span>

              <Dropdown
                align="right"
                portal
                menuClassName="ss-color-picker__format-menu ss-color-picker__settings-menu-surface"
                trigger={(triggerProps) => (
                  <IconButton
                    {...triggerProps}
                    className="ss-color-picker__settings-trigger"
                    size="default"
                    variant="ghost"
                    icon={<SettingsSlidersIcon size={16} />}
                    aria-label="Contrast settings"
                    title="Contrast settings"
                  />
                )}
              >
                {settingsMenu}
              </Dropdown>
            </div>
          )}

          <TabsPanel value="custom" className="ss-color-picker__custom-panel">
            {mode === 'custom' && (
              <>
                <div
                  ref={visualRef}
                  className={`ss-color-picker__visual${hasResolvedColor ? '' : ' is-unavailable'}`}
                  onPointerDownCapture={(event) => startColorPointerSession(event.target)}
                  onMouseDownCapture={(event) => startColorPointerSession(event.target)}
                  onTouchStartCapture={(event) => startColorPointerSession(event.target)}
                  onKeyDownCapture={(event) => handleColorKeyDown(event.target, event.key)}
                  onKeyUpCapture={finishKeyboardSession}
                >
                  <HsvaColorPicker
                    className="ss-color-picker__colorful"
                    color={hsva}
                    onChange={updateColor}
                  />
                  {contrastEnabled && hasResolvedColor && (
                    <ColorContrastOverlay
                      visualRef={visualRef}
                      hue={hsva.h}
                      alpha={hsva.a}
                      backgroundColor={backgroundColor}
                      threshold={requiredRatio}
                      enabled={Boolean(backgroundColor && requiredRatio !== null)}
                    />
                  )}
                  {hasResolvedColor ? (
                    <span
                      className="ss-color-picker__preview"
                      aria-label="Original and current color"
                    >
                      <button
                        type="button"
                        className="ss-color-picker__preview-original ss-color-picker__swatch"
                        style={colorSwatchStyle(rgbaToCss(originalRgba))}
                        aria-label="Restore original color"
                        title="Restore original color"
                        onClick={restoreOriginal}
                      />
                      <span
                        className="ss-color-picker__preview-current ss-color-picker__swatch"
                        style={colorSwatchStyle(rgbaToCss(rgba))}
                        aria-hidden="true"
                      />
                    </span>
                  ) : (
                    <p className="ss-color-picker__unavailable" role="status">
                      Current color is unavailable. Choose a replacement color or a project
                      variable.
                    </p>
                  )}
                </div>

                <div className="ss-color-picker__format-row">
                  <IconButton
                    className="ss-color-picker__action ss-color-picker__eyedropper"
                    size="default"
                    variant="default"
                    icon={<ColorPickerIcon size={16} />}
                    aria-label="Eyedropper"
                    title={eyeDropperTitle}
                    disabled={!eyeDropperAvailable || nativeSampler.isLoading}
                    onClick={() => void handleEyeDropper()}
                  />
                  <div
                    className={`ss-color-picker__format-control${
                      usesOverflowFormat ? ' ss-color-picker__format-control--dropdown' : ''
                    }`}
                  >
                    {!usesOverflowFormat && (
                      <Tabs
                        value={format}
                        onValueChange={(value) => selectFormat(value as ColorFormat)}
                        mode="navigation"
                        className="ss-color-picker__tabs"
                      >
                        <TabsList
                          aria-label="Color format"
                          variant="stretch"
                          className="ss-color-picker__tabs-list"
                        >
                          {COLOR_FORMATS.filter((option) => option.id !== 'oklch').map((option) => (
                            <TabsTab key={option.id} value={option.id}>
                              {option.label}
                            </TabsTab>
                          ))}
                        </TabsList>
                      </Tabs>
                    )}
                    <Dropdown
                      align="right"
                      portal
                      menuClassName="ss-color-picker__format-menu"
                      trigger={(triggerProps) =>
                        usesOverflowFormat ? (
                          <Button
                            {...triggerProps}
                            className="ss-color-picker__format-dropdown-trigger"
                            size="medium"
                            variant="default"
                            width="fill"
                            rightIcon={<ChevronIcon size={16} />}
                            aria-label={`Color format: ${selectedFormatLabel}`}
                            title="Choose color format"
                          >
                            {selectedFormatLabel}
                          </Button>
                        ) : (
                          <IconButton
                            {...triggerProps}
                            className="ss-color-picker__action ss-color-picker__format-trigger"
                            size="medium"
                            variant="ghost"
                            icon={<ChevronIcon size={16} />}
                            aria-label="More color formats"
                            title="More color formats"
                          />
                        )
                      }
                    >
                      {COLOR_FORMATS.map((option) => (
                        <DropdownItem
                          key={option.id}
                          active={format === option.id}
                          onSelect={() => selectFormat(option.id)}
                        >
                          {option.label}
                        </DropdownItem>
                      ))}
                    </Dropdown>
                  </div>
                </div>

                {hasResolvedColor && (
                  <div className="ss-color-picker__channels">
                    <IconButton
                      size="default"
                      variant="default"
                      icon={
                        <span className="ss-color-picker__copy-icon" aria-hidden="true">
                          <CopyIcon className="ss-color-picker__copy-icon-copy" size={16} />
                          <CheckIcon className="ss-color-picker__copy-icon-check" size={16} />
                        </span>
                      }
                      data-copied={isCopied || undefined}
                      className={`ss-color-picker__action ss-color-picker__copy${
                        isCopied ? ' is-copied' : ''
                      }`}
                      aria-label={copyLabel}
                      title={copyLabel}
                      onClick={() => void copy(copyValue)}
                    />
                    <div
                      className={`ss-color-picker__channel-fields ss-color-picker__channel-fields--${format}`}
                    >
                      {channels.map((channel) => (
                        <ChannelField
                          key={`${format}-${channel.id}`}
                          channel={channel}
                          onChange={(raw) => {
                            const valid = updateField(channel.id, raw);
                            if (valid) recordCurrentColor();
                            return valid;
                          }}
                          onScrub={(raw) => updateField(channel.id, raw)}
                          onScrubEnd={recordCurrentColor}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </TabsPanel>
          <TabsPanel value="variables" className="ss-color-picker__variables-panel">
            {mode === 'variables' && (
              <ColorPickerVariables
                variables={variables}
                variableSelector={variableSelector}
                authoredValue={currentAuthoredValue}
                onSelect={selectVariable}
              />
            )}
          </TabsPanel>
        </Tabs>

        <footer className="ss-color-picker__recent">
          <h3>Recent</h3>
          <div className="ss-color-picker__recent-list" aria-label="Recently used colors">
            {visibleRecentColors.map((color) => {
              const label = toFormat(color, 'hex');
              return (
                <button
                  key={color}
                  type="button"
                  className="ss-color-picker__recent-color"
                  aria-label={`Use recent color ${label}`}
                  title={label}
                  onClick={() => selectRecentColor(color)}
                >
                  <span
                    className="ss-color-picker__recent-swatch ss-color-picker__swatch"
                    style={colorSwatchStyle(color)}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </footer>

        <span className="ss-color-picker__sr-status" aria-live="polite">
          {isCopied ? 'Color copied' : copyError ? 'Unable to copy color' : ''}
        </span>
      </div>
    </div>
  );
}
