/**
 * Shared colour picker used by the visual editor, CSS controls, and declaration
 * popover. Callbacks use the selected CSS representation so the authored value
 * keeps the format chosen in the picker. HSB remains editor-only because CSS
 * has no hsb() syntax, so that selection emits standards-compliant RGB.
 */

import { useCallback, useState } from 'react';
import { converter, parse } from 'culori';
import { HsvaColorPicker, type HsvaColor } from 'react-colorful';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import {
  COLOR_FORMATS,
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
import { logger } from '../../lib/logger';
import { CheckIcon, ChevronIcon, CloseIcon, ColorPickerIcon, CopyIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { SegmentedControl } from '../primitives/SegmentedControl';

const toHsl = converter('hsl');
const toOklch = converter('oklch');
const toRgb = converter('rgb');

type ChannelId = 'hex' | 'r' | 'g' | 'b' | 'h' | 's' | 'l' | 'v' | 'c' | 'a';

interface ChannelDefinition {
  id: ChannelId;
  label: string;
  value: string;
  suffix?: string;
  ariaLabel?: string;
}

interface Props {
  /** Any CSS color string (hex/rgb/hsl/oklch/var), alpha allowed. */
  value: string;
  /** Fires in the selected CSS format as the color or format changes. */
  onChange: (css: string) => void;
  /** Closes the picker and returns focus to the trigger. */
  onClose: () => void;
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
  return parse(value) ?? parse('#000000')!;
}

function channelDefinitions(value: string, format: ColorFormat): ChannelDefinition[] {
  const rgba = toRgba(value);
  const alpha = alphaPercent(rgba.a);

  if (format === 'hex') {
    return [
      { id: 'hex', label: 'Hex', value: toHex(value) ?? '#000000' },
      { id: 'a', label: '', ariaLabel: 'Alpha', value: alpha, suffix: '%' },
    ];
  }

  if (format === 'rgb') {
    return [
      { id: 'r', label: 'R', value: String(rgba.r) },
      { id: 'g', label: 'G', value: String(rgba.g) },
      { id: 'b', label: 'B', value: String(rgba.b) },
      { id: 'a', label: '', ariaLabel: 'Alpha', value: alpha, suffix: '%' },
    ];
  }

  if (format === 'hsl') {
    const hsl = toHsl(currentColor(value));
    return [
      { id: 'h', label: 'H', value: round(normalizeHue(hsl.h ?? 0), 1) },
      { id: 's', label: 'S', value: round(clamp(hsl.s ?? 0, 0, 1) * 100), suffix: '%' },
      { id: 'l', label: 'L', value: round(clamp(hsl.l ?? 0, 0, 1) * 100), suffix: '%' },
      { id: 'a', label: '', ariaLabel: 'Alpha', value: alpha, suffix: '%' },
    ];
  }

  if (format === 'hsb') {
    const hsva = toHsva(value);
    return [
      { id: 'h', label: 'H', value: round(normalizeHue(hsva.h), 1) },
      { id: 's', label: 'S', value: round(clamp(hsva.s, 0, 100)), suffix: '%' },
      { id: 'v', label: 'B', value: round(clamp(hsva.v, 0, 100)), suffix: '%' },
      { id: 'a', label: '', ariaLabel: 'Alpha', value: alpha, suffix: '%' },
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
    { id: 'c', label: 'C', value: round(clamp(oklch.c ?? 0, 0, 0.4), 3) },
    { id: 'h', label: 'H', value: round(normalizeHue(oklch.h ?? 0), 1) },
    { id: 'a', label: '', ariaLabel: 'Alpha', value: alpha, suffix: '%' },
  ];
}

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

  if (format === 'hsb') {
    if (channel === 'a' && number !== null) {
      return hsvaToCss(updateHsvaChannel(toHsva(value), 'a', clamp(number, 0, 100) / 100));
    }
    if ((channel === 'h' || channel === 's' || channel === 'v') && number !== null) {
      return hsvaToCss(updateHsvaChannel(toHsva(value), channel, number));
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
}: {
  channel: ChannelDefinition;
  onChange: (raw: string) => boolean;
}) {
  const [draft, setDraft] = useState(channel.value);
  const [syncedValue, setSyncedValue] = useState(channel.value);
  if (syncedValue !== channel.value) {
    setSyncedValue(channel.value);
    setDraft(channel.value);
  }

  const commitIfValid = () => {
    if (!onChange(draft)) setDraft(channel.value);
  };

  return (
    <label className="ss-color-picker__field">
      {channel.label && <span className="ss-color-picker__field-label">{channel.label}</span>}
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
      {channel.suffix && <span className="ss-color-picker__field-suffix">{channel.suffix}</span>}
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

export function ColorPicker({ value, onChange, onClose }: Props) {
  const [format, setFormat] = useState<ColorFormat>('hsl');
  const [originalHsva] = useState(() => toHsva(value));
  const [hsva, setHsva] = useState(() => toHsva(value));
  const [syncedValue, setSyncedValue] = useState(value);

  if (syncedValue !== value) {
    setSyncedValue(value);
    const external = toRgba(value);
    const current = toRgba(hsvaToCss(hsva));
    if (
      external.r !== current.r ||
      external.g !== current.g ||
      external.b !== current.b ||
      external.a !== current.a
    ) {
      const next = toHsva(value);
      setHsva(next);
    }
  }

  const localValue = hsvaToCss(hsva);
  const rgba = toRgba(localValue);
  const originalRgba = toRgba(hsvaToCss(originalHsva));
  const channels = channelDefinitions(localValue, format);
  const eyeDropper = eyeDropperConstructor();
  const { copy, isCopied, error: copyError } = useCopyToClipboard();

  const emitHsva = useCallback(
    (next: Hsva) => {
      setHsva(next);
      onChange(toFormat(hsvaToCss(next), format));
    },
    [format, onChange]
  );

  const selectFormat = useCallback(
    (next: ColorFormat) => {
      setFormat(next);
      onChange(toFormat(hsvaToCss(hsva), next));
    },
    [hsva, onChange]
  );

  const updateColor = useCallback((next: HsvaColor) => emitHsva(next as Hsva), [emitHsva]);

  const updateField = useCallback(
    (channel: ChannelId, raw: string) => {
      const next = updateChannel(hsvaToCss(hsva), format, channel, raw);
      if (next) emitHsva(toHsva(next));
      return next !== null;
    },
    [emitHsva, format, hsva]
  );

  const handleEyeDropper = async () => {
    if (!eyeDropper) return;
    try {
      const result = await new eyeDropper().open();
      const next = toCss(result.sRGBHex);
      if (next) emitHsva(toHsva(next));
    } catch (error) {
      if (!isEyeDropperCancellation(error)) {
        logger.warn('[ColorPicker] EyeDropper failed', { error: String(error) });
      }
    }
  };

  const copyValue = toFormat(localValue, format) || rgbaToCss(rgba);
  const copyLabel = isCopied ? 'Copied color' : copyError ? 'Copy color failed' : 'Copy color';
  const usesOverflowFormat = format === 'oklch';
  const selectedFormatLabel = COLOR_FORMATS.find((option) => option.id === format)?.label ?? format;

  return (
    <div className="ss-color-picker" role="dialog" aria-label="Color picker">
      <header className="ss-edit-panel__header ss-color-picker__header" data-dockable-drag-handle>
        <h2 className="ss-edit-panel__title">Color picker</h2>
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

      <div className="ss-color-picker__controls">
        <div className="ss-color-picker__visual">
          <HsvaColorPicker
            className="ss-color-picker__colorful"
            color={hsva}
            onChange={updateColor}
          />
          <span className="ss-color-picker__preview" aria-label="Original and current color">
            <button
              type="button"
              className="ss-color-picker__preview-original"
              style={{ backgroundColor: rgbaToCss(originalRgba) }}
              aria-label="Restore original color"
              title="Restore original color"
              onClick={() => emitHsva(originalHsva)}
            />
            <span
              className="ss-color-picker__preview-current"
              style={{ backgroundColor: rgbaToCss(rgba) }}
              aria-hidden="true"
            />
          </span>
        </div>
        <div className="ss-color-picker__format-row">
          <IconButton
            className="ss-color-picker__action ss-color-picker__eyedropper"
            size="medium"
            variant="default"
            icon={<ColorPickerIcon size={16} />}
            aria-label="Eyedropper"
            title={
              eyeDropper ? 'Pick color from screen' : 'Eyedropper unavailable on this platform.'
            }
            disabled={!eyeDropper}
            onClick={() => void handleEyeDropper()}
          />
          <div
            className={`ss-color-picker__format-control${
              usesOverflowFormat ? ' ss-color-picker__format-control--dropdown' : ''
            }`}
          >
            {!usesOverflowFormat && (
              <SegmentedControl<ColorFormat>
                value={format}
                onValueChange={selectFormat}
                aria-label="Color format"
                className="ss-color-picker__tabs ss-color-picker__tabs-list"
                options={COLOR_FORMATS.filter((option) => option.id !== 'oklch').map((option) => ({
                  value: option.id,
                  label: option.label,
                }))}
              />
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

        <div className="ss-color-picker__channels">
          <IconButton
            size="medium"
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
                onChange={(raw) => updateField(channel.id, raw)}
              />
            ))}
          </div>
        </div>
      </div>

      <span className="ss-color-picker__sr-status" aria-live="polite">
        {isCopied ? 'Color copied' : copyError ? 'Unable to copy color' : ''}
      </span>
    </div>
  );
}
