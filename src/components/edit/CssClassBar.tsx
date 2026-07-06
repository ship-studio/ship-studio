/**
 * Class bar + state switcher for the CSS-Mode editor.
 *
 * The class bar shows the selected element's classes as chips: click a chip to
 * pick which class's rule you're editing, `×` to remove a class, `+` to open a
 * Webflow-style combobox that searches existing project classes and creates new
 * ones. The state switcher targets a pseudo-class (Default / Hover / Focus /
 * Active, plus any custom state like `:nth-child(even)` or `::before`) — in CSS
 * a state IS a selector, so the same resolve/edit engine handles it.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { CSS_BREAKPOINTS } from '../../lib/cssControls';

/** Breakpoint switcher — picks which `@media (min-width)` layer edits target. */
export function CssBreakpointBar({
  minPx,
  onChange,
}: {
  minPx: number | null;
  onChange: (minPx: number | null) => void;
}) {
  return (
    <div className="ss-cc-seg ss-css-breakpoints" role="group" aria-label="Breakpoint">
      {CSS_BREAKPOINTS.map((b) => (
        <button
          key={b.label}
          type="button"
          className={`ss-cc-seg__btn${minPx === b.minPx ? ' is-active' : ''}`}
          aria-pressed={minPx === b.minPx}
          title={b.minPx ? `≥ ${b.minPx}px` : 'All sizes'}
          onClick={() => onChange(b.minPx)}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

const COMMON_STATES: { label: string; value: string | null }[] = [
  { label: 'Default', value: null },
  { label: 'Hover', value: 'hover' },
  { label: 'Focus', value: 'focus' },
  { label: 'Active', value: 'active' },
];

/** Search-and-create combobox for adding a class (Webflow's style selector). */
function ClassCombobox({
  allClasses,
  existing,
  onPick,
  onClose,
  anchor,
}: {
  allClasses: string[];
  existing: string[];
  onPick: (name: string) => void;
  onClose: () => void;
  anchor: DOMRect;
}) {
  const [query, setQuery] = useState('');
  const popRef = useRef<HTMLDivElement>(null);
  const q = query.trim().replace(/^\./, '');
  const taken = new Set(existing);
  const matches = allClasses
    .filter((c) => !taken.has(c) && c.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 50);
  const canCreate = q !== '' && !allClasses.includes(q) && !taken.has(q);

  // The combobox is only mounted while open, so `open` is simply `true` here.
  useDismissOnOutsidePointer(true, popRef, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const left = Math.min(anchor.left, window.innerWidth - 240);
  return createPortal(
    <div
      ref={popRef}
      className="ss-css-combo"
      style={{ top: anchor.bottom + 4, left: Math.max(8, left) }}
    >
      <input
        autoFocus
        className="ss-css-combo__input"
        placeholder="Search or create a class…"
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q) onPick(q);
        }}
      />
      <div className="ss-css-combo__list">
        {canCreate && (
          <button type="button" className="ss-css-combo__create" onClick={() => onPick(q)}>
            Create <code>.{q}</code>
          </button>
        )}
        {matches.map((c) => (
          <button key={c} type="button" className="ss-css-combo__item" onClick={() => onPick(c)}>
            .{c}
          </button>
        ))}
        {!canCreate && matches.length === 0 && (
          <div className="ss-css-combo__empty">No classes</div>
        )}
      </div>
    </div>,
    document.body
  );
}

export function CssClassBar({
  classes,
  active,
  allClasses,
  onSelect,
  onRemove,
  onAdd,
}: {
  classes: string[];
  active: string | null;
  allClasses: string[];
  onSelect: (name: string) => void;
  onRemove: (name: string) => void;
  onAdd: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const openCombo = () => {
    const r = addRef.current?.getBoundingClientRect();
    if (r) setAnchor(r);
    setOpen(true);
  };
  return (
    <div className="ss-css-classbar">
      {classes.map((c) => (
        <span key={c} className={`ss-css-chip${c === active ? ' is-active' : ''}`}>
          <button type="button" className="ss-css-chip__name" onClick={() => onSelect(c)}>
            .{c}
          </button>
          <button
            type="button"
            className="ss-css-chip__x"
            onClick={() => onRemove(c)}
            aria-label={`Remove .${c}`}
            title={`Remove .${c}`}
          >
            ×
          </button>
        </span>
      ))}
      <button
        ref={addRef}
        type="button"
        className={`ss-css-chip__add${classes.length === 0 ? ' ss-css-chip__add--labeled' : ''}`}
        onClick={openCombo}
        title="Add a class"
        aria-label="Add a class"
      >
        {classes.length === 0 ? '+ Add class' : '+'}
      </button>
      {open && anchor && (
        <ClassCombobox
          allClasses={allClasses}
          existing={classes}
          anchor={anchor}
          onClose={() => setOpen(false)}
          onPick={(name) => {
            onAdd(name);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

export function CssStateSwitcher({
  pseudo,
  onChange,
}: {
  pseudo: string | null;
  onChange: (pseudo: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState('');
  const isCustom = pseudo != null && !COMMON_STATES.some((s) => s.value === pseudo);
  const commit = () => {
    const v = val.trim().replace(/^:+/, '');
    if (v) onChange(v);
    setVal('');
    setAdding(false);
  };
  return (
    <div className="ss-css-states">
      <div className="ss-cc-seg" role="group" aria-label="State">
        {COMMON_STATES.map((s) => (
          <button
            key={s.label}
            type="button"
            className={`ss-cc-seg__btn${pseudo === s.value ? ' is-active' : ''}`}
            aria-pressed={pseudo === s.value}
            onClick={() => onChange(s.value)}
          >
            {s.label}
          </button>
        ))}
        {isCustom && (
          <button
            type="button"
            className="ss-cc-seg__btn is-active"
            title={`Clear :${pseudo}`}
            onClick={() => onChange(null)}
          >
            :{pseudo} ×
          </button>
        )}
      </div>
      {adding ? (
        <input
          autoFocus
          className="ss-css-state-input"
          placeholder=":nth-child(even), ::before, …"
          value={val}
          spellCheck={false}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              setVal('');
              setAdding(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="ss-css-state-add"
          onClick={() => setAdding(true)}
          title="Custom state"
        >
          + Custom state
        </button>
      )}
    </div>
  );
}
