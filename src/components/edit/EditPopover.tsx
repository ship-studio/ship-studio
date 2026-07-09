/**
 * A small popup editor anchored next to a clicked declaration prop/value. The
 * convention: click a value → this opens right beside it with the current value
 * pre-selected; type and press Enter to save, Escape cancels, click-away commits.
 *
 * It's the seam for value-type-specific editors. When the value is a color it shows
 * the Tailwind editor's `ColorPicker`; otherwise a text input with a custom
 * autocomplete (property names, value keywords, `var(--…)` variables) — the same
 * menu styling as the rest of the editor. Lengths/draggers etc. can slot in too.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { ColorPicker } from './ColorPicker';
import { colorSwatch, parseNumericValue, formatNumericValue } from '../../lib/cssProperties';

interface Props {
  anchor: HTMLElement | null;
  initial: string;
  /** Autocomplete options (text mode) — filtered as you type. */
  options?: string[];
  placeholder?: string;
  onCommit: (value: string) => void;
  onClose: () => void;
}

export function EditPopover({ anchor, initial, options, placeholder, onCommit, onClose }: Props) {
  const [text, setText] = useState(initial);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const isColor = colorSwatch(initial) !== null;
  const width = isColor ? 224 : 220;

  // Filter the options by what's typed; hide the menu when the sole match is exactly
  // the current text (nothing left to suggest).
  const matches = useMemo(() => {
    if (!options || isColor) return [];
    const q = text.trim().toLowerCase();
    const list = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    return list.slice(0, 8);
  }, [options, text, isColor]);

  // Inline `!important` completion: typing a trailing `!` (or a partial like `!imp`)
  // ghosts the rest of `!important` in grey — Tab fills it, Enter accepts + commits.
  const ghostSuffix = useMemo(() => {
    const m = /!([a-z]*)$/i.exec(text);
    if (!m) return '';
    const tail = m[1].toLowerCase();
    return 'important'.startsWith(tail) && tail !== 'important'
      ? 'important'.slice(tail.length)
      : '';
  }, [text]);

  const showMenu =
    !ghostSuffix && matches.length > 0 && !(matches.length === 1 && matches[0] === text);

  // Position just below-left of the anchor, clamped into the viewport. Computed
  // from the anchor's measured rect at open time (anchor is stable while open).
  const pos = useMemo(() => {
    if (!anchor) return null;
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const top = Math.min(r.bottom + 4, window.innerHeight - (isColor ? 240 : 60));
    return { top, left };
  }, [anchor, width, isColor]);

  // Focus + select the current value on open (text mode).
  useEffect(() => {
    if (isColor) return;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [isColor]);

  // Escape cancels; click-away commits the current value. Clicks inside the popover
  // or its portaled sub-menus (the color format dropdown) don't dismiss.
  // The popover is only mounted while open, so `open` is simply `true` here.
  useDismissOnOutsidePointer(
    true,
    popRef,
    () => {
      onCommit(textRef.current);
      onClose();
    },
    {
      event: 'mousedown',
      isOutside: (target) => {
        const t = target as HTMLElement;
        if (popRef.current?.contains(t)) return false;
        // Clicking the anchor again is a toggle — let its own onClick close us.
        if (anchor?.contains(t)) return false;
        if (t.closest?.('.ss-enum__menu, .ss-color-popover')) return false;
        return true;
      },
    }
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (!pos) return null;
  return createPortal(
    <div
      ref={popRef}
      className={`ss-value-pop${isColor ? ' ss-value-pop--color' : ''}`}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width }}
    >
      {isColor ? (
        <ColorPicker
          value={text}
          onChange={(c) => {
            setText(c);
            onCommit(c); // live-apply as you drag
          }}
        />
      ) : (
        <>
          <div className="ss-value-pop__field">
            {parseNumericValue(text) && (
              <ScrubHandle
                value={text}
                onScrub={(v) => {
                  setText(v);
                  onCommit(v); // live-apply as you drag
                }}
              />
            )}
            <span className="ss-value-pop__inputwrap">
              {ghostSuffix && (
                <span className="ss-value-pop__ghost" aria-hidden="true">
                  <span className="ss-value-pop__ghost-typed">{text}</span>
                  <span className="ss-value-pop__ghost-hint">{ghostSuffix}</span>
                </span>
              )}
              <input
                ref={inputRef}
                className="ss-value-pop__input"
                value={text}
                spellCheck={false}
                autoComplete="off"
                role="combobox"
                aria-expanded={showMenu}
                aria-controls={listId}
                aria-activedescendant={showMenu ? optionId(active) : undefined}
                aria-autocomplete="list"
                placeholder={placeholder}
                onChange={(e) => {
                  setText(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Tab' && ghostSuffix) {
                    e.preventDefault();
                    setText(text + ghostSuffix);
                    setActive(0);
                    return;
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (ghostSuffix) {
                      onCommit(text + ghostSuffix);
                      onClose();
                      return;
                    }
                    const pick = showMenu ? (matches[active] ?? text) : text;
                    onCommit(pick);
                    onClose();
                  } else if (e.key === 'ArrowDown' && showMenu) {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, matches.length - 1));
                  } else if (e.key === 'ArrowUp' && showMenu) {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    // Menu closed: step a numeric value (same conventions as
                    // drag-to-scrub) and live-apply. Non-numeric values keep
                    // the default caret behavior.
                    const next = stepNumericValue(text, e.key === 'ArrowUp' ? 1 : -1, e);
                    if (next === null) return;
                    e.preventDefault();
                    setText(next);
                    setActive(0);
                    onCommit(next); // live-apply, like scrubbing
                  }
                }}
              />
            </span>
          </div>
          {showMenu && (
            <div className="ss-add-menu ss-value-pop__menu">
              <div className="ss-add-menu__list" role="listbox" id={listId}>
                {matches.map((o, i) => (
                  <button
                    key={o}
                    type="button"
                    role="option"
                    id={optionId(i)}
                    aria-selected={active === i}
                    className={`ss-add-menu__item${active === i ? ' is-active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onCommit(o);
                      onClose();
                    }}
                  >
                    <code className="ss-add-menu__label">{o}</code>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>,
    document.body
  );
}

/** Per-pixel step scaled to the value's magnitude, so big numbers (700) move fast and
 *  small ones (1, 20, 50) stay gentle. Roughly 1% of the order of magnitude. */
function magnitudeStep(v: number): number {
  const a = Math.abs(v);
  if (a < 10) return 0.1; // 0–9    → 0.1 / px
  if (a < 100) return 1; //  10–99  → 1 / px
  if (a < 1000) return 10; // 100–999 → 10 / px
  return 100; //              1000+   → 100 / px
}

/** One keyboard step of a numeric value: the magnitude-aware base step with
 *  Shift ×10 / Alt ÷10 — the same conventions as drag-to-scrub. Preserves the
 *  unit; null when the value isn't a single number (keyword, color, calc(…)). */
function stepNumericValue(
  value: string,
  dir: 1 | -1,
  mods: { shiftKey: boolean; altKey: boolean }
): string | null {
  const p = parseNumericValue(value);
  if (!p) return null;
  const base = magnitudeStep(p.num);
  const step = mods.shiftKey ? base * 10 : mods.altKey ? base / 10 : base;
  const stepDecimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return formatNumericValue(p.num + dir * step, p.unit, Math.max(p.decimals, stepDecimals));
}

/** Drag-to-scrub a numeric value (devtools-style). Horizontal drag adjusts the
 *  number live, preserving the unit; the step scales with the value's magnitude, and
 *  Shift ×10 / Alt ÷10 give coarse/fine control. */
function ScrubHandle({ value, onScrub }: { value: string; onScrub: (v: string) => void }) {
  const drag = useRef<{ x: number; num: number; unit: string; decimals: number } | null>(null);
  return (
    <span
      className="ss-value-pop__scrub"
      title="Drag to adjust · Shift ×10 · Alt ÷10"
      onPointerDown={(e) => {
        const p = parseNumericValue(value);
        if (!p) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, num: p.num, unit: p.unit, decimals: p.decimals };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const base = magnitudeStep(d.num);
        const step = e.shiftKey ? base * 10 : e.altKey ? base / 10 : base;
        const stepDecimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
        const next = d.num + (e.clientX - d.x) * step;
        onScrub(formatNumericValue(next, d.unit, Math.max(d.decimals, stepDecimals)));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
    >
      <svg
        width={12}
        height={12}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="9 7 4 12 9 17" />
        <polyline points="15 7 20 12 15 17" />
      </svg>
    </span>
  );
}
