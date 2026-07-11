/**
 * One `property: value` row. The prop and value render as plain (wrapping) text;
 * clicking either opens an `EditPopover` next to it — the editing convention (a text
 * input now; a color picker / dragger later). `!` toggles `!important`, ✕ removes it.
 * Overridden declarations render struck-through, with a tooltip naming what wins.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { CloseIcon } from '../icons/common';
import { PlusIcon } from '../icons/utility';
import { EditPopover } from './EditPopover';
import { CSS_PROPERTIES, colorSwatch, suggestValues } from '../../lib/cssProperties';
import type { Decl } from '../../lib/cssBody';

interface EditableProps {
  decl: Decl;
  overridden: boolean;
  /** What wins the cascade for this property (for the overridden tooltip). */
  overriddenBy?: string;
  editable: true;
  onChange: (decl: Decl) => void;
  /** Remove this declaration. Receives this row's DOM element so the caller can move
   *  focus to a surviving sibling before the row unmounts (#14). */
  onRemove: (rowEl: HTMLElement | null) => void;
  /** Existing nested-rule selectors in this card (targets to nest this decl into). */
  nestTargets: string[];
  /** Move this declaration into a nested rule for `selector` (created if missing). */
  onNest: (selector: string) => void;
  /** Project CSS variables (e.g. `--accent`) for `var(--…)` value autocomplete. */
  variables?: string[];
  /** Project `@keyframes` names, suggested as `animation` values. */
  animations?: string[];
  /** Open the value editor automatically on mount — for the editing flow (right after
   *  adding a property, land in its value input without a second click). */
  autoEditValue?: boolean;
}
interface ReadonlyProps {
  decl: Decl;
  overridden: boolean;
  overriddenBy?: string;
  editable: false;
}
type Props = EditableProps | ReadonlyProps;

/** Hover tooltip for an overridden declaration, naming what wins the cascade.
 *  Portaled + fixed-positioned so it's never clipped by the scrolling panel, and
 *  instant (unlike the native `title` delay). */
function useOverriddenTip(overridden: boolean, by?: string) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const handlers = overridden
    ? {
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ top: r.top - 6, left: r.left });
        },
        onMouseLeave: () => setPos(null),
      }
    : {};
  const tip =
    overridden && pos
      ? createPortal(
          <div
            className="ss-decl-tip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform: 'translateY(-100%)',
            }}
          >
            Overridden by <code className="ss-decl-tip__sel">{by || 'a later rule'}</code>
          </div>,
          document.body
        )
      : null;
  return { handlers, tip };
}

/** A color swatch chip when the value is a color. */
function Swatch({ value }: { value: string }) {
  const c = colorSwatch(value);
  if (!c) return null;
  return <span className="ss-decl__swatch" style={{ background: c }} aria-hidden="true" />;
}

export function DeclarationRow(props: Props) {
  const { decl, overridden } = props;
  const { handlers: tipHandlers, tip } = useOverriddenTip(overridden, props.overriddenBy);
  // The anchor element is captured from the click event (never read from a ref
  // during render). Clicking the same field again toggles the popover closed.
  const [editing, setEditing] = useState<null | { field: 'prop' | 'value'; anchor: HTMLElement }>(
    null
  );
  const toggle = (field: 'prop' | 'value') => (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    setEditing((cur) => (cur?.field === field ? null : { field, anchor }));
  };

  // Editing-flow: when this row was just added, open its value editor on mount so the
  // user lands straight in the value input (anchored to the value button).
  const valueBtnRef = useRef<HTMLButtonElement>(null);
  const autoEditValue = props.editable && props.autoEditValue;
  useEffect(() => {
    if (autoEditValue && valueBtnRef.current) {
      setEditing({ field: 'value', anchor: valueBtnRef.current });
    }
  }, [autoEditValue]);

  if (!props.editable) {
    return (
      <div className={`ss-decl is-readonly${overridden ? ' is-overridden' : ''}`} {...tipHandlers}>
        <span className="ss-decl__prop">{decl.prop}</span>
        <span className="ss-decl__colon">:</span>
        <span className="ss-decl__value">
          <Swatch value={decl.value} />
          {decl.value}
          {decl.important && <span className="ss-decl__imp"> !important</span>}
        </span>
        {tip}
      </div>
    );
  }

  const { onChange, onRemove, onNest, nestTargets } = props;

  return (
    <div className={`ss-decl${overridden ? ' is-overridden' : ''}`} {...tipHandlers}>
      {tip}
      <button type="button" className="ss-decl__prop ss-decl__edit" onClick={toggle('prop')}>
        {decl.prop || <span className="ss-decl__ph">property</span>}
      </button>
      <span className="ss-decl__colon">:</span>
      <button
        ref={valueBtnRef}
        type="button"
        className="ss-decl__value ss-decl__edit"
        onClick={toggle('value')}
      >
        <Swatch value={decl.value} />
        {decl.value || <span className="ss-decl__ph">value</span>}
        {decl.important && <span className="ss-decl__imp"> !important</span>}
      </button>

      <span className="ss-decl__actions">
        <NestControl nestTargets={nestTargets} onNest={onNest} />
        <button
          type="button"
          className="ss-decl__remove"
          title="Remove property"
          aria-label="Remove property"
          onClick={(e) => onRemove(e.currentTarget.closest('.ss-decl'))}
        >
          <CloseIcon size={11} />
        </button>
      </span>

      {editing?.field === 'prop' && (
        <EditPopover
          anchor={editing.anchor}
          initial={decl.prop}
          options={CSS_PROPERTIES}
          placeholder="property"
          onCommit={(prop) => onChange({ ...decl, prop })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.field === 'value' && (
        <EditPopover
          anchor={editing.anchor}
          initial={decl.important ? `${decl.value} !important` : decl.value}
          options={suggestValues(decl.prop, props.variables ?? [], props.animations ?? [])}
          placeholder="value"
          onCommit={(raw) => {
            // `!important` is typed inline (no toggle button) — split it back out.
            const m = /\s*!\s*important\s*$/i.exec(raw);
            onChange(
              m
                ? { ...decl, value: raw.slice(0, m.index).trim(), important: true }
                : { ...decl, value: raw.trim(), important: false }
            );
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** "Nest this declaration" control: a ⤵ button opening a tiny menu of this card's
 *  existing nested selectors plus a "new nested rule" option. */
function NestControl({
  nestTargets,
  onNest,
}: {
  nestTargets: string[];
  onNest: (selector: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Dismiss on Escape (returning focus to the trigger) or an outside click — a
  // keyboard user can't reach an onMouseLeave, so both are required to close it.
  // Mirrors the mousedown-capture click-outside pattern used by AddMenu.
  useDismissOnOutsidePointer(open, wrapRef, () => setOpen(false), { event: 'mousedown' });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <span className="ss-decl__nest" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`ss-decl__nest-btn${open ? ' is-open' : ''}`}
        title="Move into a nested rule"
        aria-label="Move into a nested rule"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <NestGlyph />
      </button>
      {open && (
        <span className="ss-decl__nest-menu" role="menu" aria-label="Move into a nested rule">
          {nestTargets.map((sel) => (
            <button
              key={sel}
              type="button"
              role="menuitem"
              className="ss-decl__nest-item"
              onClick={() => {
                onNest(sel);
                setOpen(false);
              }}
            >
              {sel}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="ss-decl__nest-item ss-decl__nest-item--new"
            onClick={() => {
              onNest('&:hover');
              setOpen(false);
            }}
          >
            <PlusIcon size={10} /> new nested rule
          </button>
        </span>
      )}
    </span>
  );
}

/** "Move into a nested rule" affordance — a corner-down-right turn arrow. */
function NestGlyph() {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}
