/**
 * Color picker: react-colorful's hex surface + a format switcher and an editable
 * input that displays the same color as HEX / RGB / HSL / OKLCH (via culori).
 *
 * The surface and the canonical value are hex; the format switcher only changes
 * how the input renders/accepts the value. Typing commits only on a valid parse,
 * so a partial value never resets the picker mid-edit. Controlled via value/onChange.
 */

import { useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import { COLOR_FORMATS, toFormat, toHex, type ColorFormat } from '../../lib/color';
import { EnumDropdown } from './EnumDropdown';

interface Props {
  /** Any CSS color string (hex/rgb/hsl/oklch/var). */
  value: string;
  /** Fires with a normalized 6-digit hex as the color changes. */
  onChange: (hex: string) => void;
}

export function ColorPicker({ value, onChange }: Props) {
  const hex = toHex(value) ?? '#000000';
  const [format, setFormat] = useState<ColorFormat>('hex');
  const [text, setText] = useState(() => toFormat(hex, format));

  // Re-derive the input text when the color or format changes, without an effect
  // (set-state-during-render with a sentinel — same pattern as the gap field).
  const [synced, setSynced] = useState({ hex, format });
  if (synced.hex !== hex || synced.format !== format) {
    setSynced({ hex, format });
    setText(toFormat(hex, format));
  }

  const commit = (raw: string) => {
    const next = toHex(raw);
    if (next) onChange(next);
  };

  return (
    <div className="ss-color-picker">
      <HexColorPicker color={hex} onChange={onChange} />
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
          if (!toHex(text)) setText(toFormat(hex, format));
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
