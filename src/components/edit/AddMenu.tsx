/**
 * The cascade card's "+ Add" menu — adds CONTENT *inside* a rule (the selector's
 * identity and scope live elsewhere, on the selector itself). Two groups:
 *
 *   PROPERTY            → a declaration (`color`, `display`, …) with suggestions
 *   ALSO STYLE (nested) → a nested rule (`&:hover`, `& .child`, `&:has()`, or any
 *                         selector / nested `@`-rule you type)
 *
 * What you type routes intent: a word filters properties; a leading selector char
 * (`&`, `:`, `.`, `>`…) or `@` means a nested rule. Free text is normalized and
 * honored. Portaled + flip-up positioned so it's never clipped by the panel.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { PlusIcon } from '../icons/utility';
import { suggestProperties } from '../../lib/cssProperties';
import {
  NEST_ITEMS,
  WRAP_ITEMS,
  KEYFRAME_STEP_ITEMS,
  searchStructures,
  classifyFreeText,
  classifyKeyframeStep,
} from '../../lib/cssStructures';

/**
 * What this card's body can hold, which decides what "+ Add" offers:
 *   'full'      — a style rule: properties + nested rules (default)
 *   'keyframes' — a `@keyframes` rule: keyframe steps only (`from`, `50%`, …)
 *   'props'     — a keyframe step: properties only (no nested rules)
 */
export type AddMode = 'full' | 'keyframes' | 'props';

interface Props {
  onAddProperty: (prop: string) => void;
  /** Add a nested rule with this selector/prelude (a nested selector or keyframe step). */
  onNest: (selector: string) => void;
  mode?: AddMode;
  /** Open the menu automatically on mount — for the editing flow (e.g. right after
   *  creating a rule, jump straight to picking its first property). */
  autoOpen?: boolean;
}

type RowKind = 'prop' | 'nest';
interface MenuRow {
  key: string;
  label: string;
  hint?: string;
  kind: RowKind;
  /** The string handed to the matching callback. */
  insert: string;
}
interface Section {
  title: string;
  rows: MenuRow[];
}

const MENU_WIDTH = 288;
const SEL_START = /^[&:>+~.#[*]/;
const LOOKS_PROP = /^[a-zA-Z-]+$/;

export function AddMenu({ onAddProperty, onNest, mode = 'full', autoOpen = false }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // The trigger's rect is captured from the click event (never read from a ref
  // during render) and used to position the portaled menu.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  // Editing-flow: open on mount when asked (e.g. right after creating the rule), so
  // the user lands straight in property selection without a second click.
  useEffect(() => {
    if (autoOpen && btnRef.current) {
      setAnchor(btnRef.current.getBoundingClientRect());
      setOpen(true);
    }
    // One-shot on the autoOpen signal.
  }, [autoOpen]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setActive(0);
  };
  const applyRow = (r: MenuRow) => {
    if (r.kind === 'prop') onAddProperty(r.insert);
    else onNest(r.insert); // a nested selector or nested at-rule
    close();
  };

  const sections = useMemo<Section[]>(() => {
    const typed = query.trim();
    const out: Section[] = [];

    // KEYFRAMES — the body of a `@keyframes` rule is steps, never bare declarations.
    if (mode === 'keyframes') {
      const rows: MenuRow[] = [];
      const free = classifyKeyframeStep(typed);
      const items = searchStructures(KEYFRAME_STEP_ITEMS, typed);
      if (free && !items.some((i) => i.insert === free.insert)) {
        rows.push({
          key: `f:${free.insert}`,
          label: free.insert,
          hint: 'new step',
          kind: 'nest',
          insert: free.insert,
        });
      }
      for (const it of items)
        rows.push({
          key: `s:${it.insert}`,
          label: it.label,
          hint: it.hint,
          kind: 'nest',
          insert: it.insert,
        });
      if (rows.length) out.push({ title: 'Keyframe step', rows });
      return out;
    }

    const startsAt = typed.startsWith('@');
    const startsSel = SEL_START.test(typed);

    // PROPERTY — only when the query isn't clearly a selector or at-rule.
    if (mode === 'props' || (!startsAt && !startsSel)) {
      const sugg = suggestProperties(typed);
      const rows: MenuRow[] = [];
      if (typed && LOOKS_PROP.test(typed) && !sugg.includes(typed)) {
        rows.push({
          key: `new:${typed}`,
          label: typed,
          hint: 'new property',
          kind: 'prop',
          insert: typed,
        });
      }
      for (const p of sugg) rows.push({ key: `p:${p}`, label: p, kind: 'prop', insert: p });
      if (rows.length) out.push({ title: 'Property', rows });
    }

    // ALSO STYLE (nested selectors) — curated states (`&:hover`) + any free-typed
    // selector. Not for `@`-rules (those are conditions, handled below).
    if (mode !== 'props' && !startsAt) {
      const items = searchStructures(NEST_ITEMS, typed);
      const rows: MenuRow[] = [];
      if (startsSel) {
        const free = classifyFreeText(typed);
        if (free && free.kind === 'nest' && !items.some((i) => i.insert === free.insert)) {
          rows.push({
            key: `f:${free.insert}`,
            label: free.insert,
            hint: 'new nested rule',
            kind: 'nest',
            insert: free.insert,
          });
        }
      }
      for (const it of items)
        rows.push({
          key: `n:${it.insert}`,
          label: it.label,
          hint: it.hint,
          kind: 'nest',
          insert: it.insert,
        });
      if (rows.length) out.push({ title: 'Also style', rows });
    }

    // ONLY WHEN (condition) — `@media`/`@container`/`@supports`, nested inside the
    // rule so the base styles stay and these override at the condition. Recommended
    // up-front (even with an empty query) so breakpoints are discoverable here, not
    // just by knowing to type `@` in the selector field (which scopes the whole rule).
    if (mode !== 'props') {
      const items = searchStructures(WRAP_ITEMS, typed);
      const rows: MenuRow[] = [];
      if (startsAt && typed.length > 1 && !items.some((i) => i.insert === typed)) {
        rows.push({
          key: `fc:${typed}`,
          label: typed,
          hint: 'new condition',
          kind: 'nest',
          insert: typed,
        });
      }
      for (const it of items)
        rows.push({
          key: `c:${it.insert}`,
          label: it.label,
          hint: it.hint,
          kind: 'nest',
          insert: it.insert,
        });
      if (rows.length) out.push({ title: 'Only when (media · container · supports)', rows });
    }

    return out;
  }, [query, mode]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // Position under the trigger, clamped; flip up if it would overflow below.
  const pos = useMemo(() => {
    if (!open || !anchor) return null;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
    const below = window.innerHeight - anchor.bottom;
    const flip = below < 300 && anchor.top > below;
    return {
      left,
      top: flip ? undefined : anchor.bottom + 4,
      bottom: flip ? window.innerHeight - anchor.top + 4 : undefined,
    };
  }, [open, anchor]);

  useDismissOnOutsidePointer(open, popRef, close, {
    event: 'mousedown',
    isOutside: (t) => !popRef.current?.contains(t) && !btnRef.current?.contains(t),
  });

  const label = mode === 'keyframes' ? 'Add step' : mode === 'props' ? 'Add property' : 'Add';
  const placeholder =
    mode === 'keyframes'
      ? 'Add a keyframe step (from, to, 50%)…'
      : mode === 'props'
        ? 'Add a property…'
        : 'Add a property or nested rule (&:hover, & .child)…';

  const trigger = (
    <button
      ref={btnRef}
      type="button"
      className={`ss-card__add${open ? ' is-open' : ''}`}
      aria-label={
        mode === 'keyframes'
          ? 'Add a keyframe step'
          : mode === 'props'
            ? 'Add a property'
            : 'Add a property, nested rule, or condition'
      }
      aria-expanded={open}
      onClick={(e) => {
        if (open) close();
        else {
          setAnchor(e.currentTarget.getBoundingClientRect());
          setOpen(true);
        }
      }}
    >
      <PlusIcon size={11} /> {label}
    </button>
  );

  if (!open || !pos) return trigger;

  let idx = -1; // running flat index for keyboard highlight
  return (
    <>
      {trigger}
      {createPortal(
        <div
          ref={popRef}
          className="ss-add-menu"
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            bottom: pos.bottom,
            width: MENU_WIDTH,
          }}
        >
          <input
            className="ss-add-menu__search"
            autoFocus
            value={query}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-activedescendant={flat.length > 0 ? optionId(active) : undefined}
            aria-autocomplete="list"
            aria-label={label}
            placeholder={placeholder}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, flat.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (flat[active]) applyRow(flat[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
          />
          {/* Layout forced inline (block flow) — beats any class/global rule that was
              otherwise reflowing the rows into columns. */}
          <div
            className="ss-add-menu__list"
            role="listbox"
            id={listId}
            style={{ display: 'block', overflowY: 'auto' }}
          >
            {flat.length === 0 && <div className="ss-add-menu__empty">No matches</div>}
            {sections.map((section) => (
              <div
                key={section.title}
                role="group"
                aria-label={section.title}
                style={{ display: 'block' }}
              >
                <div className="ss-add-menu__group" role="presentation">
                  {section.title}
                </div>
                {section.rows.map((row) => {
                  idx += 1;
                  const isActive = idx === active;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      role="option"
                      id={optionId(idx)}
                      aria-selected={isActive}
                      className={`ss-add-menu__item${isActive ? ' is-active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyRow(row)}
                      style={{
                        display: 'flex',
                        width: '100%',
                        boxSizing: 'border-box',
                        alignItems: 'baseline',
                        gap: 8,
                        textAlign: 'left',
                        whiteSpace: 'nowrap',
                        writingMode: 'horizontal-tb',
                      }}
                    >
                      <code
                        className="ss-add-menu__label"
                        style={{
                          flex: '1 1 auto',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {row.label}
                      </code>
                      {row.hint && (
                        <span
                          className="ss-add-menu__hint"
                          style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}
                        >
                          {row.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
