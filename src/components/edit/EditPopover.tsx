/**
 * The shared CSS value editor. Text values can render in place inside the value's
 * existing column; color values can still open the dedicated floating picker.
 * The current value is pre-selected; Enter saves, Escape cancels, and click-away
 * commits.
 *
 * It's the seam for value-type-specific editors. When the value is a color it shows
 * the Tailwind editor's `ColorPicker`; otherwise a text input with a custom
 * autocomplete (property names, value keywords, `var(--…)` variables) — the same
 * menu styling as the rest of the editor. Lengths/draggers etc. can slot in too.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { DockablePanel } from '../primitives/DockablePanel';
import { ColorPicker } from './ColorPicker';
import { CssValueText } from './CssValueText';
import { colorSwatch, parseNumericValue, formatNumericValue } from '../../lib/cssProperties';
import { ScrubHorizontalIcon } from '@/components/icons';
import {
  COLOR_PICKER_GUTTER,
  COLOR_PICKER_HEIGHT,
  COLOR_PICKER_POSITION_KEY,
  COLOR_PICKER_SIZE_KEY,
  COLOR_PICKER_WIDTH,
} from '../../lib/color';

interface Props {
  anchor: HTMLElement | null;
  /** Render the text editor in document flow instead of in a floating surface. */
  inline?: boolean;
  initial: string;
  /** Autocomplete options (text mode) — filtered as you type. */
  options?: string[];
  /** Keep color values in the text editor instead of opening the picker. */
  enableColorPicker?: boolean;
  placeholder?: string;
  onCommit: (value: string) => void;
  onClose: () => void;
}

export function EditPopover({
  anchor,
  inline = false,
  initial,
  options,
  enableColorPicker = true,
  placeholder,
  onCommit,
  onClose,
}: Props) {
  const [text, setText] = useState(initial);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // A color value opens the floating picker even in inline mode — the picker is a
  // dockable panel of its own, so it never has to fit the value's text column.
  const isColor = enableColorPicker && colorSwatch(initial) !== null;
  const width = isColor ? COLOR_PICKER_WIDTH : 220;

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
    if (isColor) {
      // No anchor (inline rows pass none): open at the gutter — the dockable panel
      // remembers where the user last put it anyway.
      const r = anchor?.getBoundingClientRect();
      if (!r) return { top: COLOR_PICKER_GUTTER, left: COLOR_PICKER_GUTTER };
      let left = r.left - width - COLOR_PICKER_GUTTER;
      if (left < COLOR_PICKER_GUTTER) left = r.right + COLOR_PICKER_GUTTER;
      left = Math.min(
        Math.max(COLOR_PICKER_GUTTER, left),
        Math.max(COLOR_PICKER_GUTTER, window.innerWidth - width - COLOR_PICKER_GUTTER)
      );
      const maxTop = Math.max(
        COLOR_PICKER_GUTTER,
        window.innerHeight - COLOR_PICKER_HEIGHT - COLOR_PICKER_GUTTER
      );
      const top = Math.min(Math.max(COLOR_PICKER_GUTTER, r.top), maxTop);
      return { top, left };
    }
    if (inline) return { top: 0, left: 0 };
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const top = Math.min(rect.bottom + 4, window.innerHeight - 60);
    return { top, left };
  }, [anchor, width, isColor, inline]);

  // Focus + select the current value on open (text mode).
  useEffect(() => {
    if (isColor) return;
    const el = inputRef.current;
    if (el) {
      el.focus({ preventScroll: true });
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
        if (
          t.closest?.(
            '.ss-enum__menu, .ss-color-picker__floating-surface, .ss-color-picker__format-menu'
          )
        )
          return false;
        return true;
      },
    }
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.querySelector('.ss-color-picker__format-menu')) return;
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const setInputRef = (element: HTMLInputElement | HTMLTextAreaElement | null) => {
    inputRef.current = element;
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setText(event.target.value);
    setActive(0);
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!inline || popRef.current?.contains(event.relatedTarget)) return;
    onCommit(textRef.current);
    onClose();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Tab' && ghostSuffix) {
      event.preventDefault();
      setText(text + ghostSuffix);
      setActive(0);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (ghostSuffix) {
        onCommit(text + ghostSuffix);
        onClose();
        return;
      }
      const pick = showMenu ? (matches[active] ?? text) : text;
      onCommit(pick);
      onClose();
    } else if (event.key === 'ArrowDown' && showMenu) {
      event.preventDefault();
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp' && showMenu) {
      event.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      // Menu closed: step a numeric value (same conventions as drag-to-scrub)
      // and live-apply. Non-numeric values keep the default caret behavior.
      const next = stepNumericValue(text, event.key === 'ArrowUp' ? 1 : -1, event);
      if (next === null) return;
      event.preventDefault();
      setText(next);
      setActive(0);
      onCommit(next); // live-apply, like scrubbing
    }
  };

  if (!pos) return null;
  const editor = isColor ? (
    <DockablePanel
      docked={false}
      ariaLabel="Color picker"
      positionKey={COLOR_PICKER_POSITION_KEY}
      sizeKey={COLOR_PICKER_SIZE_KEY}
      floatingSize={{ width: COLOR_PICKER_WIDTH, height: COLOR_PICKER_HEIGHT }}
      initialPosition={() => ({ left: pos.left, top: pos.top })}
      resizable={false}
      surfaceClassName="ss-color-picker__floating-surface"
    >
      <div ref={popRef} className="ss-color-picker__floating-content">
        <ColorPicker
          value={text}
          onChange={(c) => {
            setText(c);
            onCommit(c); // live-apply as you drag
          }}
          onClose={() => {
            onClose();
            anchor?.focus({ preventScroll: true });
          }}
        />
      </div>
    </DockablePanel>
  ) : (
    <div
      ref={popRef}
      className={`ss-value-pop${inline ? ' ss-value-pop--inline' : ''}`}
      style={inline ? undefined : { position: 'fixed', top: pos.top, left: pos.left, width }}
    >
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
            {inline && (
              <span className="ss-value-pop__sizer" aria-hidden="true">
                <CssValueText value={`${text}${ghostSuffix}` || placeholder || ' '} />
              </span>
            )}
            {ghostSuffix && (
              <span className="ss-value-pop__ghost" aria-hidden="true">
                <span className="ss-value-pop__ghost-typed">{text}</span>
                <span className="ss-value-pop__ghost-hint">{ghostSuffix}</span>
              </span>
            )}
            {inline ? (
              <textarea
                ref={setInputRef}
                className="ss-value-pop__input"
                value={text}
                rows={1}
                spellCheck={false}
                autoComplete="off"
                role="combobox"
                aria-multiline="true"
                aria-expanded={showMenu}
                aria-controls={listId}
                aria-activedescendant={showMenu ? optionId(active) : undefined}
                aria-autocomplete="list"
                placeholder={placeholder}
                onChange={handleChange}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
              />
            ) : (
              <input
                ref={setInputRef}
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
                onChange={handleChange}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
              />
            )}
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
                  <code className="ss-add-menu__label">
                    <CssValueText value={o} />
                  </code>
                </button>
              ))}
            </div>
          </div>
        )}
      </>
    </div>
  );

  // The color editor is always a floating panel, so it portals out of the row even
  // when the text editor for that row would have rendered in flow.
  return inline && !isColor ? editor : createPortal(editor, document.body);
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
      <ScrubHorizontalIcon aria-hidden="true" />
    </span>
  );
}
