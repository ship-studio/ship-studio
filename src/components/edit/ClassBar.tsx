/**
 * Custom-class control for the visual editor — a Webflow/Webstudio-style edit-
 * target selector.
 *
 * The model is flat (Webstudio "Local + Tokens", not Webflow combo chains): the
 * edit target is either **This element** (its own inline utilities) or one of the
 * named custom classes applied to it (editing a class updates every element using
 * it). A single searchable popover, split into three unambiguous zones so one
 * click never means two things:
 *
 *   1. Edit target   — This element + each applied class (pick one to edit; × removes)
 *   2. Apply existing — project classes not yet on the element (click to apply)
 *   3. Create         — only when the typed name has no exact match
 *
 * The active target is shown with a leading check + a faint tint (never a solid
 * fill). The control is an ARIA combobox: focus stays in the search input and a
 * visual highlight moves through the rows via `aria-activedescendant`.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PlusIcon } from '../icons/utility';
import { CheckIcon, SearchIcon } from '../icons/common';
import type { CustomClass } from '../../lib/customClasses';
import type { EditTarget } from '../../hooks/useVisualEditor';
import { logger } from '../../lib/logger';

interface Props {
  customClasses: CustomClass[];
  /** The selected element's current className string. */
  elementClass: string;
  editTarget: EditTarget;
  /** False when the project has no writable Tailwind entry stylesheet — creating
   *  a class isn't possible, so the create affordance is disabled with a hint. */
  canCreate?: boolean;
  onEditElement: () => void;
  onEditClass: (name: string, tokens: string[]) => void;
  onApplyExisting: (name: string) => void | Promise<void>;
  onUnapply: (name: string) => void | Promise<void>;
  onCreate: (name: string) => void;
}

/** Client-side mirror of the backend's class-name rule (the backend re-validates). */
const NAME_RE = /^[A-Za-z_-][A-Za-z0-9_-]*$/;

/** Keep in sync with --classedit-menu-w; used to clamp the menu into the viewport. */
const MENU_W = 248;

/** One navigable row in the popover (one flat list drives both render + keyboard). */
type Row =
  | { kind: 'element'; id: string }
  | { kind: 'applied'; id: string; cls: CustomClass }
  | { kind: 'available'; id: string; cls: CustomClass }
  | { kind: 'create'; id: string };

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <polyline points="6 9 12 15 18 9" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function ClassBar({
  customClasses,
  elementClass,
  editTarget,
  canCreate: canCreateClasses = true,
  onEditElement,
  onEditClass,
  onApplyExisting,
  onUnapply,
  onCreate,
}: Props) {
  const byName = useMemo(() => {
    const m = new Map<string, CustomClass>();
    for (const c of customClasses) m.set(c.name, c);
    return m;
  }, [customClasses]);

  const tokens = useMemo(() => elementClass.split(/\s+/).filter(Boolean), [elementClass]);
  const applied = useMemo(
    () => tokens.map((t) => byName.get(t)).filter((c): c is CustomClass => !!c),
    [tokens, byName]
  );
  const appliedNames = useMemo(() => new Set(applied.map((c) => c.name)), [applied]);
  const hasUtilities = useMemo(() => tokens.some((t) => !byName.has(t)), [tokens, byName]);
  const available = useMemo(
    () => customClasses.filter((c) => !appliedNames.has(c.name)),
    [customClasses, appliedNames]
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // True while an apply/unapply write is in flight — disables the toggle rows so a
  // rapid burst can't race (each write must land before the next starts).
  const [busy, setBusy] = useState(false);
  // Index of the keyboard-highlighted row in `rows` (combobox aria-activedescendant).
  const [active, setActive] = useState(0);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
  }, []);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Right-align to the trigger when a left-aligned menu would overflow the
    // window (the panel hugs the right edge), and never let it leave the viewport.
    const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 8));
    setMenuRect({ top: r.bottom + 4, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);

  const q = query.trim().toLowerCase();
  const matchedApplied = useMemo(
    () => applied.filter((c) => c.name.toLowerCase().includes(q)),
    [applied, q]
  );
  const matchedAvailable = useMemo(
    () => available.filter((c) => c.name.toLowerCase().includes(q)),
    [available, q]
  );
  const trimmed = query.trim();
  const canCreate = NAME_RE.test(trimmed) && !byName.has(trimmed);
  const showElementRow = q === '' || 'this element'.includes(q);

  const activeName = editTarget.kind === 'class' ? editTarget.name : null;

  // One flat, ordered list of navigable rows — the single source of truth for
  // both rendering order and keyboard traversal.
  const rows = useMemo<Row[]>(() => {
    const r: Row[] = [];
    if (showElementRow) r.push({ kind: 'element', id: 'ce-element' });
    for (const c of matchedApplied) r.push({ kind: 'applied', id: `ce-applied-${c.name}`, cls: c });
    for (const c of matchedAvailable)
      r.push({ kind: 'available', id: `ce-avail-${c.name}`, cls: c });
    if (canCreate) r.push({ kind: 'create', id: 'ce-create' });
    return r;
  }, [showElementRow, matchedApplied, matchedAvailable, canCreate]);

  // Keep the highlight in range as the list filters; reset to top on query change.
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(0, rows.length - 1));
  }, [rows.length, active]);

  // Apply/unapply keep the menu open; serialize so a burst can't race.
  const toggle = useCallback(async (fn: () => void | Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      // The handlers (applyClass/unapplyClass) already toast on failure and
      // don't reject; guard here anyway so a throwing handler can't surface as
      // an unhandled rejection and strand the busy state.
      logger.error('[ClassBar] apply/unapply failed', { error: String(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  const createEnabled = canCreate && hasUtilities && canCreateClasses;

  // Run a row's primary action (used by both click and Enter).
  const activate = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      switch (row.kind) {
        case 'element':
          onEditElement();
          close();
          break;
        case 'applied':
          if (!row.cls.editable) return;
          onEditClass(row.cls.name, row.cls.tokens);
          close();
          break;
        case 'available':
          if (busy) return;
          void toggle(() => onApplyExisting(row.cls.name)); // keep menu open (multi-apply)
          break;
        case 'create':
          if (!createEnabled) return;
          onCreate(trimmed);
          close();
          break;
      }
    },
    [
      onEditElement,
      onEditClass,
      onApplyExisting,
      onCreate,
      close,
      toggle,
      busy,
      createEnabled,
      trimmed,
    ]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (!rows.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % rows.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + rows.length) % rows.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        activate(rows[active]);
      }
    },
    [rows, active, activate, close]
  );

  // Scroll the keyboard-highlighted row into view.
  useEffect(() => {
    if (!open) return;
    const id = rows[active]?.id;
    const el = id ? listRef.current?.querySelector(`#${id}`) : null;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active, rows, open]);

  const noMatches = q !== '' && rows.length === 0;
  const activeId = open ? rows[active]?.id : undefined;

  return (
    <div className="ss-edit-panel__control">
      <span className="ss-edit-panel__label">Editing</span>
      <button
        ref={triggerRef}
        type="button"
        className={`ss-enum__trigger ss-classedit__trigger${activeName ? ' is-class' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ss-classedit__name">{activeName ?? 'This element'}</span>
        <Chevron />
      </button>

      {open &&
        menuRect &&
        createPortal(
          <div
            ref={menuRef}
            className="ss-enum__menu ss-classedit__menu"
            style={{ top: menuRect.top, left: menuRect.left }}
          >
            <div className="ss-classedit__searchwrap">
              <SearchIcon size={13} />
              <input
                type="text"
                role="combobox"
                aria-expanded={open}
                aria-controls="ce-listbox"
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                className="ss-classedit__search"
                placeholder="Search or create a class…"
                value={query}
                spellCheck={false}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
              />
            </div>

            <div className="ss-classedit__scroll" id="ce-listbox" role="listbox" ref={listRef}>
              {(showElementRow || matchedApplied.length > 0) && (
                <div className="ss-classedit__group">Edit target</div>
              )}

              {showElementRow &&
                (() => {
                  const isActive = editTarget.kind === 'element';
                  const isHi = rows[active]?.id === 'ce-element';
                  return (
                    <button
                      type="button"
                      role="option"
                      id="ce-element"
                      aria-selected={isActive}
                      className={`ss-classedit__item${isActive ? ' is-active' : ''}${isHi ? ' is-hi' : ''}`}
                      onMouseEnter={() => setActive(rows.findIndex((r) => r.id === 'ce-element'))}
                      onClick={() => activate({ kind: 'element', id: 'ce-element' })}
                    >
                      <span className="ss-classedit__check">
                        {isActive && <CheckIcon size={11} />}
                      </span>
                      <span className="ss-classedit__name">This element</span>
                    </button>
                  );
                })()}

              {matchedApplied.map((c) => {
                const isActive = activeName === c.name;
                const isHi = rows[active]?.id === `ce-applied-${c.name}`;
                return (
                  <div
                    key={c.name}
                    className={`ss-classedit__row${isActive ? ' is-active' : ''}${isHi ? ' is-hi' : ''}`}
                  >
                    <button
                      type="button"
                      role="option"
                      id={`ce-applied-${c.name}`}
                      aria-selected={isActive}
                      className="ss-classedit__pick"
                      disabled={!c.editable}
                      title={
                        c.editable
                          ? `Edit .${c.name} — updates every element using it`
                          : `.${c.name} mixes custom CSS — edit it in code`
                      }
                      onMouseEnter={() =>
                        setActive(rows.findIndex((r) => r.id === `ce-applied-${c.name}`))
                      }
                      onClick={() =>
                        activate({ kind: 'applied', id: `ce-applied-${c.name}`, cls: c })
                      }
                    >
                      <span className="ss-classedit__check">
                        {isActive && <CheckIcon size={11} />}
                      </span>
                      <span className="ss-classedit__name">{c.name}</span>
                    </button>
                    <button
                      type="button"
                      className="ss-classedit__x"
                      disabled={busy}
                      title={`Remove .${c.name} from this element`}
                      aria-label={`Remove .${c.name} from this element`}
                      onClick={() => void toggle(() => onUnapply(c.name))}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}

              {matchedAvailable.length > 0 && (
                <div className="ss-classedit__group">Apply existing</div>
              )}
              {matchedAvailable.map((c) => {
                const isHi = rows[active]?.id === `ce-avail-${c.name}`;
                return (
                  <button
                    key={c.name}
                    type="button"
                    role="option"
                    id={`ce-avail-${c.name}`}
                    aria-selected={false}
                    className={`ss-classedit__item ss-classedit__item--add${isHi ? ' is-hi' : ''}`}
                    disabled={busy}
                    title={`Apply .${c.name} to this element`}
                    onMouseEnter={() =>
                      setActive(rows.findIndex((r) => r.id === `ce-avail-${c.name}`))
                    }
                    onClick={() =>
                      activate({ kind: 'available', id: `ce-avail-${c.name}`, cls: c })
                    }
                  >
                    <PlusIcon size={11} />
                    <span className="ss-classedit__name">{c.name}</span>
                  </button>
                );
              })}

              {noMatches && !canCreate && (
                <div className="ss-classedit__empty">No classes match “{trimmed}”.</div>
              )}
            </div>

            {canCreate && (
              <button
                type="button"
                role="option"
                id="ce-create"
                aria-selected={false}
                className={`ss-classedit__createrow${rows[active]?.id === 'ce-create' ? ' is-hi' : ''}`}
                disabled={!createEnabled}
                title={
                  !canCreateClasses
                    ? 'No Tailwind stylesheet found in this project to add the class to'
                    : hasUtilities
                      ? `Create .${trimmed} from this element's current styles`
                      : 'This element has no utility classes to extract'
                }
                onMouseEnter={() => setActive(rows.findIndex((r) => r.id === 'ce-create'))}
                onClick={() => activate({ kind: 'create', id: 'ce-create' })}
              >
                <PlusIcon size={11} />
                <span className="ss-classedit__name">
                  Create class <b>{trimmed}</b>
                </span>
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
