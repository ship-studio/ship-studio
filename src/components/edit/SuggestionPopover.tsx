/**
 * A portaled autocomplete dropdown for the inline chip inputs (rule selector, nested
 * selector, @media condition, add-selector).
 *
 * Rendered to `document.body` via a portal with fixed positioning, so it escapes the
 * editor panel's DOM entirely. The critical layout (block container, full-width rows
 * that stack, horizontal text) is set with INLINE styles — they beat any class/global
 * rule, so the dropdown can't be reflowed into columns or vertical text by an ancestor.
 * Classes are used only for colors/hover.
 */

import { useMemo } from 'react';
import { createPortal } from 'react-dom';

export interface Suggestion {
  /** Committed when picked. */
  value: string;
  /** Shown (defaults to value). */
  label: string;
  hint?: string;
}

interface Props {
  /** The input element the dropdown anchors under (a DOM node, not a React ref). */
  anchor: HTMLElement | null;
  items: Suggestion[];
  /** Highlighted index (keyboard nav lives in the owning input). */
  active: number;
  onPick: (value: string) => void;
  width?: number;
  /** ARIA listbox id — the owning combobox input points its `aria-controls` here, and
   *  each option's id is derived from it (`${listId}-opt-${i}`) for `aria-activedescendant`. */
  listId?: string;
}

/** Stable per-option id for the owning input's `aria-activedescendant`. */
export function suggestionOptionId(listId: string | undefined, index: number): string | undefined {
  return listId ? `${listId}-opt-${index}` : undefined;
}

export function SuggestionPopover({ anchor, items, active, onPick, width = 240, listId }: Props) {
  const pos = useMemo(() => {
    if (!anchor || items.length === 0) return null;
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom;
    const flip = below < 220 && r.top > below;
    return {
      left,
      top: flip ? undefined : r.bottom + 4,
      bottom: flip ? window.innerHeight - r.top + 4 : undefined,
      maxHeight: Math.max(120, (flip ? r.top : below) - 12),
    };
  }, [anchor, items.length, width]);

  if (!pos) return null;

  return createPortal(
    <div
      className="ss-suggest"
      role="listbox"
      id={listId}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        bottom: pos.bottom,
        width,
        maxHeight: pos.maxHeight,
        // Bulletproof layout (inline = wins over any class/global rule):
        display: 'block',
        boxSizing: 'border-box',
        overflowY: 'auto',
        overflowX: 'hidden',
        writingMode: 'horizontal-tb',
        columns: 'auto',
      }}
    >
      {items.map((it, i) => (
        <button
          key={it.value}
          type="button"
          role="option"
          id={suggestionOptionId(listId, i)}
          aria-selected={i === active}
          className={`ss-suggest__item${i === active ? ' is-active' : ''}`}
          // Keep the input focused so its blur doesn't close us before the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(it.value)}
          style={{
            display: 'flex',
            width: '100%',
            boxSizing: 'border-box',
            alignItems: 'baseline',
            gap: 8,
            writingMode: 'horizontal-tb',
            textAlign: 'left',
            whiteSpace: 'nowrap',
          }}
        >
          <code
            className="ss-suggest__label"
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {it.label}
          </code>
          {it.hint && (
            <span className="ss-suggest__hint" style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>
              {it.hint}
            </span>
          )}
        </button>
      ))}
    </div>,
    document.body
  );
}
