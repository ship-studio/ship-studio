/**
 * Sizing control (width / height / max-width / min-height). A single free-form
 * field that accepts a Tailwind keyword (`full`, `screen`, `auto`), a fraction
 * (`1/2`), a scale step (`64`), or any CSS length (`480px`, `clamp(…)` → `w-[…]`),
 * with a styled preset dropdown for discoverability (the app's own SuggestionPopover,
 * not the OS datalist popup, which ignores the theme). Always prefers the named
 * token, falling back to an arbitrary value only when off-scale.
 */

import { useId, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ResettableLabel } from './ResettableLabel';
import { SuggestionPopover, suggestionOptionId, type Suggestion } from './SuggestionPopover';
import {
  lengthValue,
  parseLengthInput,
  lengthResetSpec,
  readLayer,
  LENGTH_PRESETS,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';

interface Props {
  label: string;
  prefix: string;
  css: string;
  currentClass: string;
  layer: LayerContext;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onReset: (spec: ResetSpec) => void;
}

/** True when the field holds a plain number or number+unit — the arrow keys step
 *  those, so the preset menu stays out of the way. */
const isNumericText = (s: string) => /^(-?\d*\.?\d+)\s*([a-z%]*)$/i.test(s.trim());

export function LengthControl({
  label,
  prefix,
  css,
  currentClass,
  layer,
  onApplyEnum,
  onReset,
}: Props) {
  const { value, definedAt } = readLayer(currentClass, layer, (s) => lengthValue(s, prefix));
  const display = value ?? '';
  const listId = useId();

  const [text, setText] = useState(display);
  const [lastDisplay, setLastDisplay] = useState(display);
  const [invalid, setInvalid] = useState(false);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Sync the field when the value changes externally (reselect, breakpoint switch).
  if (display !== lastDisplay && !invalid) {
    setLastDisplay(display);
    setText(display);
  }

  // Preset suggestions: everything on empty text (discoverability), prefix-filtered
  // while typing a keyword/fraction, suppressed entirely on numeric text so the
  // arrow keys keep their stepping meaning.
  const matches: Suggestion[] =
    menuOpen && !isNumericText(text)
      ? LENGTH_PRESETS.filter(
          (p) => text.trim() === '' || p.startsWith(text.trim().toLowerCase())
        ).map((p) => ({ value: p, label: p }))
      : [];
  const menuVisible = matches.length > 0;

  const commit = () => {
    if (text.trim() === '') return true; // empty = leave unset (no-op)
    const parsed = parseLengthInput(text, prefix, css);
    if (parsed.kind === 'invalid') {
      setInvalid(true);
      return false;
    }
    setInvalid(false);
    onApplyEnum(parsed.token, { [css]: parsed.css });
    return true;
  };

  const pick = (v: string) => {
    const parsed = parseLengthInput(v, prefix, css);
    setMenuOpen(false);
    if (parsed.kind === 'invalid') return;
    setText(v);
    setInvalid(false);
    onApplyEnum(parsed.token, { [css]: parsed.css });
  };

  /** ArrowUp/Down step a numeric value (bare scale step or number+unit, keeping
   *  the unit) and commit each press; Shift ×10, Alt fine (÷10 on unit values —
   *  the Tailwind scale stays on whole steps). Keywords (`full`, `auto`) and
   *  fractions (`1/2`) aren't steppable — the caret is left alone. */
  const onArrowStep = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const m = /^(-?\d*\.?\d+)\s*([a-z%]*)$/i.exec(text.trim());
    if (!m) return; // non-numeric — leave the caret alone
    const unit = m[2];
    const fine = unit ? 0.1 : 1;
    const step = e.shiftKey ? 10 : e.altKey ? fine : 1;
    const dir = e.key === 'ArrowUp' ? 1 : -1;
    const num = Math.max(0, Math.round((parseFloat(m[1]) + dir * step) * 100) / 100);
    const next = `${num}${unit}`;
    const parsed = parseLengthInput(next, prefix, css);
    if (parsed.kind === 'invalid') return;
    e.preventDefault();
    setText(next);
    setInvalid(false);
    onApplyEnum(parsed.token, { [css]: parsed.css });
  };

  return (
    <div className="ss-edit-panel__control">
      <ResettableLabel
        label={label}
        definedAt={definedAt}
        active={layer.bp}
        onReset={() => onReset(lengthResetSpec(prefix, css))}
      />
      <input
        className={`ss-edit-panel__text${invalid ? ' ss-edit-panel__num--invalid' : ''}`}
        inputMode="text"
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={menuVisible}
        aria-controls={listId}
        aria-activedescendant={menuVisible ? suggestionOptionId(listId, active) : undefined}
        aria-autocomplete="list"
        aria-label={label}
        aria-invalid={invalid}
        placeholder="auto"
        title={
          invalid ? 'Use a keyword (full, auto), fraction (1/2), or length (480px, 50%)' : label
        }
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setMenuOpen(true);
          setActive(0);
          if (invalid) setInvalid(false);
        }}
        onFocus={(e) => {
          e.target.select();
          setAnchorEl(e.currentTarget);
          setMenuOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          setMenuOpen(false);
          if (!commit()) {
            setText(display);
            setInvalid(false);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (menuVisible) {
              e.preventDefault();
              pick(matches[active]?.value ?? text);
            } else if (commit()) {
              e.currentTarget.blur();
            }
          } else if (e.key === 'Escape' && menuVisible) {
            e.preventDefault();
            setMenuOpen(false);
          } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menuVisible) {
            // Menu open: arrows navigate the presets (same convention as the
            // cascade editor's popover). Numeric text suppresses the menu, so
            // stepping below still owns the arrows there.
            e.preventDefault();
            setActive((a) =>
              e.key === 'ArrowDown' ? Math.min(a + 1, matches.length - 1) : Math.max(a - 1, 0)
            );
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            onArrowStep(e);
          }
        }}
      />
      <SuggestionPopover
        anchor={anchorEl}
        items={menuVisible ? matches : []}
        active={active}
        onPick={pick}
        width={180}
        listId={listId}
      />
    </div>
  );
}
