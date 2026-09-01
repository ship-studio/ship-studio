/**
 * Insert-element popover — the palette of primitives (div, headings, paragraph,
 * button, image, …) plus a Before / After / Inside placement control. Shared by
 * the canvas ElementToolbar (anchored to its + button) and the element tree's
 * context menu (anchored at the cursor). Portaled + flip-up positioned so it's
 * never clipped (same approach as AddMenu).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ELEMENT_KINDS, type ElementKind, type InsertPosition } from '../../lib/edit-structure';

interface Props {
  /** Where to anchor the popover (viewport coords); null = closed. */
  anchor: { left: number; top: number; bottom: number } | null;
  /** The anchor element can't contain children (void tag) — no "Inside". */
  insideDisabled: boolean;
  /** The anchor IS the document (`<html>`/`<head>`/`<body>`) — nothing can sit
   *  beside it, so only "Inside" is offered (issues #723/#740). */
  outsideDisabled?: boolean;
  onInsert: (position: InsertPosition, kind: ElementKind) => void;
  onClose: () => void;
}

const MENU_WIDTH = 224;
const MENU_MAX_HEIGHT = 320;

const POSITIONS: { id: InsertPosition; label: string }[] = [
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
  { id: 'inside', label: 'Inside' },
];

export function InsertMenu({ anchor, insideDisabled, outsideDisabled, onInsert, onClose }: Props) {
  const [position, setPosition] = useState<InsertPosition>('after');
  const [active, setActive] = useState(0);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const disabledPosition = (id: InsertPosition) =>
    id === 'inside' ? insideDisabled : !!outsideDisabled;
  // A void anchor loses "Inside", a structural one loses Before/After — fall
  // back to whichever placement is still available.
  const effectivePosition = !disabledPosition(position)
    ? position
    : outsideDisabled
      ? 'inside'
      : 'after';

  // Fresh keyboard highlight each time the menu opens (render-time state
  // adjustment — the sanctioned "derive from prop change" pattern).
  const [openedFor, setOpenedFor] = useState<Props['anchor']>(null);
  if (anchor !== openedFor) {
    setOpenedFor(anchor);
    setActive(0);
  }
  // Focus the listbox on open so arrow-key nav works immediately.
  useEffect(() => {
    if (anchor) listRef.current?.focus();
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as HTMLElement)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [anchor, onClose]);

  if (!anchor) return null;

  // Position under the anchor, clamped; flip up if it would overflow below.
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  const below = window.innerHeight - anchor.bottom;
  const flip = below < MENU_MAX_HEIGHT && anchor.top > below;
  const pos = {
    left,
    top: flip ? undefined : anchor.bottom + 4,
    bottom: flip ? window.innerHeight - anchor.top + 4 : undefined,
  };

  const pick = (kind: ElementKind) => {
    onInsert(effectivePosition, kind);
    onClose();
  };

  return createPortal(
    <div
      ref={popRef}
      className="ss-insert-menu"
      role="dialog"
      aria-label="Insert element"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        bottom: pos.bottom,
        width: MENU_WIDTH,
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive((a) => Math.min(a + 1, ELEMENT_KINDS.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((a) => Math.max(a - 1, 0));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const row = ELEMENT_KINDS[active];
          if (row) pick(row.kind);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="ss-insert-menu__positions" role="radiogroup" aria-label="Placement">
        {POSITIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={effectivePosition === p.id}
            className={`ss-insert-menu__position${effectivePosition === p.id ? ' is-active' : ''}`}
            disabled={disabledPosition(p.id)}
            title={
              p.id === 'inside' && insideDisabled
                ? 'This element can’t contain children'
                : disabledPosition(p.id)
                  ? 'Nothing can sit beside this element — it’s part of the page itself'
                  : undefined
            }
            onClick={() => setPosition(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div
        ref={listRef}
        className="ss-insert-menu__list"
        role="listbox"
        id={listId}
        aria-label="Element"
        aria-activedescendant={optionId(active)}
        tabIndex={0}
      >
        {ELEMENT_KINDS.map((row, i) => (
          <button
            key={row.kind}
            type="button"
            role="option"
            id={optionId(i)}
            aria-selected={i === active}
            className={`ss-insert-menu__item${i === active ? ' is-active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(row.kind)}
          >
            <span className="ss-insert-menu__label">{row.label}</span>
            <code className="ss-insert-menu__tag">{`<${row.kind}>`}</code>
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}
