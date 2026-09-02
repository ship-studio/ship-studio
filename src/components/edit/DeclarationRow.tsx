/**
 * One `property: value` row. The prop and value render as plain (wrapping) text;
 * clicking either replaces that text with an editor in the same grid column.
 * `!` toggles `!important`, ✕ removes it.
 * Overridden declarations render struck-through, with a tooltip naming what wins.
 */

import { useEffect, useRef, useState } from 'react';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { CloseIcon, NestRuleIcon, PlusIcon } from '@/components/icons';
import { EditPopover } from './EditPopover';
import { CssValueText } from './CssValueText';
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
  /** Hide the nest affordance when the containing editor has no nested rules. */
  showNest?: boolean;
  /** Project CSS variables (e.g. `--accent`) for `var(--…)` value autocomplete. */
  variables?: string[];
  /** Project `@keyframes` names, suggested as `animation` values. */
  animations?: string[];
  /** Open the value editor automatically on mount — for the editing flow (right after
   *  adding a property, land in its value input without a second click). */
  autoEditValue?: boolean;
  /** Called whenever an inline editor closes, including cancellation. */
  onEditClose?: () => void;
}
interface ReadonlyProps {
  decl: Decl;
  overridden: boolean;
  overriddenBy?: string;
  editable: false;
}
type Props = EditableProps | ReadonlyProps;

/** Shared tooltip content for an overridden declaration, naming what wins the cascade. */
function overriddenTooltipProps(overridden: boolean, by?: string) {
  return overridden ? { 'data-tooltip-content': `Overridden by ${by || 'a later rule'}` } : {};
}

/** A color swatch chip when the value is a color. */
function Swatch({ value }: { value: string }) {
  const c = colorSwatch(value);
  if (!c) return null;
  return <span className="ss-decl__swatch" style={{ background: c }} aria-hidden="true" />;
}

export function DeclarationRow(props: Props) {
  const { decl, overridden } = props;
  const tipProps = overriddenTooltipProps(overridden, props.overriddenBy);
  const autoEditValue = props.editable && props.autoEditValue;
  // Editing-flow: a newly added row mounts directly into its inline value input.
  const [editing, setEditing] = useState<null | 'prop' | 'value'>(autoEditValue ? 'value' : null);

  if (!props.editable) {
    return (
      <div className={`ss-decl is-readonly${overridden ? ' is-overridden' : ''}`} {...tipProps}>
        <span className="ss-decl__prop">{decl.prop}</span>
        <span className="ss-decl__colon">:</span>
        <span className="ss-decl__value">
          <Swatch value={decl.value} />
          <CssValueText value={decl.value} />
          {decl.important && <span className="ss-decl__imp"> !important</span>}
        </span>
      </div>
    );
  }

  const { onChange, onRemove, onNest, nestTargets } = props;

  return (
    <div className={`ss-decl${overridden ? ' is-overridden' : ''}`} {...tipProps}>
      {editing === 'prop' ? (
        <EditPopover
          inline
          anchor={null}
          initial={decl.prop}
          options={CSS_PROPERTIES}
          enableColorPicker={false}
          placeholder="property"
          onCommit={(prop) => onChange({ ...decl, prop })}
          onClose={() => {
            setEditing(null);
            props.onEditClose?.();
          }}
        />
      ) : (
        <button
          type="button"
          className="ss-decl__prop ss-decl__edit"
          onClick={() => setEditing('prop')}
        >
          {decl.prop || <span className="ss-decl__ph">property</span>}
        </button>
      )}
      <span className="ss-decl__colon">:</span>
      {editing === 'value' ? (
        <EditPopover
          inline
          anchor={null}
          initial={decl.important ? `${decl.value} !important` : decl.value}
          options={suggestValues(decl.prop, props.variables ?? [], props.animations ?? [])}
          enableColorPicker={false}
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
          onClose={() => {
            setEditing(null);
            props.onEditClose?.();
          }}
        />
      ) : (
        <button
          type="button"
          className="ss-decl__value ss-decl__edit"
          onClick={() => setEditing('value')}
        >
          <Swatch value={decl.value} />
          {decl.value ? (
            <CssValueText value={decl.value} />
          ) : (
            <span className="ss-decl__ph">value</span>
          )}
          {decl.important && <span className="ss-decl__imp"> !important</span>}
        </button>
      )}

      <span className="ss-decl__actions">
        {props.showNest !== false && <NestControl nestTargets={nestTargets} onNest={onNest} />}
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
        <NestRuleIcon />
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
