/**
 * Color picker: react-colorful's RGBA surface (saturation/hue + opacity) plus a
 * format dropdown and an editable input that shows the same color as
 * HEX / RGB / HSL / OKLCH (via culori, which react-colorful can't do for OKLCH).
 *
 * The canonical value is a CSS color string carrying alpha; the format only
 * changes how the input renders/accepts it. Typing commits on a valid parse,
 * so a partial value never resets the picker mid-edit. Controlled via value/onChange.
 */

import { useState } from 'react';
import { RgbaColorPicker } from 'react-colorful';
import {
  COLOR_FORMATS,
  rgbaToCss,
  toCss,
  toFormat,
  toRgba,
  type ColorFormat,
} from '../../lib/color';
import { EnumDropdown } from './EnumDropdown';

interface Props {
  /** Any CSS color string (hex/rgb/hsl/oklch/var), alpha allowed. */
  value: string;
  /** Fires with a canonical rgb()/rgba() string as the color changes. */
  onChange: (css: string) => void;
}

export function ColorPicker({ value, onChange }: Props) {
  const rgba = toRgba(value);
  const [format, setFormat] = useState<ColorFormat>('hex');
  const [text, setText] = useState(() => toFormat(value, format));

  // Re-derive the input text when the color or format changes, without an effect
  // (set-state-during-render with a sentinel — same pattern as the gap field).
  const key = `${value}|${format}`;
  const [syncedKey, setSyncedKey] = useState(key);
  if (syncedKey !== key) {
    setSyncedKey(key);
    setText(toFormat(value, format));
  }

  const commit = (raw: string) => {
    const css = toCss(raw);
    if (css) onChange(css);
  };

  return (
    <div className="ss-color-picker">
      <RgbaColorPicker color={rgba} onChange={(c) => onChange(rgbaToCss(c))} />
      <div className="ss-color-picker__row">
        <EnumDropdown
          label="Color format"
          value={format}
          options={COLOR_FORMATS.map((f) => ({ label: f.label, token: f.id }))}
          onChange={(token) => setFormat(token as ColorFormat)}
        />
      </div>
      <input
        className="ss-color-picker__input"
        aria-label={`Color value (${format})`}
        spellCheck={false}
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          commit(e.target.value);
        }}
        onBlur={() => {
          if (!toCss(text)) setText(toFormat(value, format));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(text);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
