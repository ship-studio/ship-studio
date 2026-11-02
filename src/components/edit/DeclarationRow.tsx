/**
 * One `property: value` row. The prop and value render as plain (wrapping) text;
 * clicking either replaces that text with an editor in the same grid column.
 * `!` toggles `!important`, ✕ removes it.
 * Overridden declarations render struck-through, with a tooltip naming what wins.
 */

import { useEffect, useRef, useState } from 'react';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { CloseIcon, NestRuleIcon, PlusIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { EditPopover } from './EditPopover';
import { CssValueText } from './CssValueText';
import { CSS_PROPERTIES, colorSwatch, suggestValues } from '../../lib/cssProperties';
import type { Decl } from '../../lib/cssBody';
import {
  resolveColorVariable,
  type ColorContrastContexts,
  type ColorVariableDefinition,
} from '../../lib/colorContrast';

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
  /** Resolved project token values for color display and variable authoring. */
  colorVariables?: readonly ColorVariableDefinition[];
  /** Selector used to resolve scoped custom properties for this rule. */
  variableSelector?: string;
  projectPath?: string;
  colorContrast?: ColorContrastContexts;
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
  colorVariables?: readonly ColorVariableDefinition[];
  variableSelector?: string;
}
type Props = EditableProps | ReadonlyProps;

/** Shared tooltip content for an overridden declaration, naming what wins the cascade. */
function overriddenTooltipProps(overridden: boolean, by?: string) {
  return overridden ? { 'data-tooltip-content': `Overridden by ${by || 'a later rule'}` } : {};
}

const TEXT_COLOR_PROPERTIES = new Set([
  'color',
  '-webkit-text-fill-color',
  'text-decoration-color',
  'text-emphasis-color',
]);

const COLOR_VALUE_PROPERTIES = new Set([
  ...TEXT_COLOR_PROPERTIES,
  'accent-color',
  'background',
  'background-color',
  'border',
  'border-block',
  'border-block-color',
  'border-block-end',
  'border-block-end-color',
  'border-block-start',
  'border-block-start-color',
  'border-bottom',
  'border-bottom-color',
  'border-color',
  'border-inline',
  'border-inline-color',
  'border-inline-end',
  'border-inline-end-color',
  'border-inline-start',
  'border-inline-start-color',
  'border-left',
  'border-left-color',
  'border-right',
  'border-right-color',
  'border-top',
  'border-top-color',
  'box-shadow',
  'caret-color',
  'column-rule',
  'column-rule-color',
  'fill',
  'flood-color',
  'lighting-color',
  'outline',
  'outline-color',
  'scrollbar-color',
  'stop-color',
  'stroke',
  'text-decoration',
  'text-emphasis',
  'text-shadow',
  '-webkit-text-stroke',
  '-webkit-text-stroke-color',
]);

function isColorValueProperty(property: string): boolean {
  return COLOR_VALUE_PROPERTIES.has(property.trim().toLowerCase());
}

function contrastContextForProperty(property: string, contexts?: ColorContrastContexts) {
  const normalized = property.trim().toLowerCase();
  if (TEXT_COLOR_PROPERTIES.has(normalized)) return contexts?.text;
  return isColorValueProperty(normalized) ? contexts?.graphics : undefined;
}

function resolveSwatchColor(
  value: string,
  variables: readonly ColorVariableDefinition[] | undefined,
  selector?: string
): string | null {
  const resolved = resolveColorVariable(value, variables ?? [], selector);
  return colorSwatch(resolved ?? value);
}

/** A color swatch chip for literal colors and resolvable color variables. */
function Swatch({ color }: { color: string | null }) {
  if (!color) return null;
  return <span className="ss-decl__swatch" style={{ background: color }} aria-hidden="true" />;
}

function valueText(value: string) {
  return value ? <CssValueText value={value} /> : <span className="ss-decl__ph">value</span>;
}

function colorPickerTitle(property: string) {
  return `Open color picker for ${property}`;
}

export function DeclarationRow(props: Props) {
  const { decl, overridden } = props;
  const tipProps = overriddenTooltipProps(overridden, props.overriddenBy);
  const autoEditValue = props.editable && props.autoEditValue;
  const swatchColor = resolveSwatchColor(decl.value, props.colorVariables, props.variableSelector);
  // Editing-flow: a newly added row mounts directly into its inline value input.
  const [editing, setEditing] = useState<null | 'prop' | 'value' | 'color'>(
    autoEditValue ? 'value' : null
  );
  // The clicked value or swatch button anchors its editor or color picker.
  const [valueAnchor, setValueAnchor] = useState<HTMLElement | null>(null);

  if (!props.editable) {
    return (
      <div className={`ss-decl is-readonly${overridden ? ' is-overridden' : ''}`} {...tipProps}>
        <span className="ss-decl__prop">{decl.prop}</span>
        <span className="ss-decl__colon">:</span>
        <span className="ss-decl__value">
          <Swatch color={swatchColor} />
          <CssValueText value={decl.value} />
          {decl.important && <span className="ss-decl__imp"> !important</span>}
        </span>
      </div>
    );
  }

  const { onChange, onRemove, onNest, nestTargets } = props;
  const colorProperty = isColorValueProperty(decl.prop);
  const initialValue = decl.important ? `${decl.value} !important` : decl.value;
  const options = suggestValues(decl.prop, props.variables ?? [], props.animations ?? []);
  const commitValue = (raw: string) => {
    // `!important` is typed inline (no toggle button) — split it back out.
    const m = /\s*!\s*important\s*$/i.exec(raw);
    onChange(
      m
        ? { ...decl, value: raw.slice(0, m.index).trim(), important: true }
        : { ...decl, value: raw.trim(), important: false }
    );
  };
  const closeValueEditor = () => {
    setEditing(null);
    props.onEditClose?.();
  };

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
          anchor={valueAnchor}
          initial={initialValue}
          initialSwatch={Boolean(swatchColor)}
          colorSwatchTrigger={
            swatchColor
              ? (value) => {
                  const liveSwatchColor =
                    resolveSwatchColor(value, props.colorVariables, props.variableSelector) ??
                    swatchColor;
                  return (
                    <Button
                      className="ss-decl__swatch-trigger"
                      size="compact"
                      variant="ghost"
                      aria-label={colorPickerTitle(decl.prop)}
                      title={colorPickerTitle(decl.prop)}
                      aria-haspopup="dialog"
                      aria-expanded={false}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        setValueAnchor(event.currentTarget.closest<HTMLElement>('.ss-decl'));
                        setEditing('color');
                      }}
                    >
                      <Swatch color={liveSwatchColor} />
                    </Button>
                  );
                }
              : undefined
          }
          options={options}
          variables={props.colorVariables}
          variableSelector={props.variableSelector}
          projectPath={props.projectPath}
          enableColorPicker={false}
          contrastContext={contrastContextForProperty(decl.prop, props.colorContrast)}
          placeholder="value"
          onCommit={commitValue}
          onClose={closeValueEditor}
        />
      ) : (
        <div className="ss-decl__value">
          <Button
            className={`ss-decl__edit ss-decl__value-text${
              swatchColor ? ' ss-decl__value-text--has-swatch' : ''
            }`}
            size="compact"
            variant="ghost"
            onClick={(event) => {
              setValueAnchor(event.currentTarget);
              setEditing('value');
            }}
          >
            {swatchColor && <span className="ss-decl__swatch-space" aria-hidden="true" />}
            {valueText(decl.value)}
            {decl.important && <span className="ss-decl__imp"> !important</span>}
          </Button>
          {swatchColor && (
            <Button
              className="ss-decl__swatch-trigger"
              size="compact"
              variant="ghost"
              aria-label={colorPickerTitle(decl.prop)}
              title={colorPickerTitle(decl.prop)}
              aria-haspopup="dialog"
              aria-expanded={editing === 'color'}
              onClick={(event) => {
                setValueAnchor(event.currentTarget);
                setEditing((current) => (current === 'color' ? null : 'color'));
              }}
            >
              <Swatch color={swatchColor} />
            </Button>
          )}
          {editing === 'color' && (
            <EditPopover
              inline
              anchor={valueAnchor}
              initial={initialValue}
              options={options}
              variables={props.colorVariables}
              variableSelector={props.variableSelector}
              projectPath={props.projectPath}
              enableColorPicker
              colorProperty={colorProperty}
              contrastContext={contrastContextForProperty(decl.prop, props.colorContrast)}
              placeholder="value"
              onCommit={commitValue}
              onClose={closeValueEditor}
            />
          )}
          {editing !== 'prop' && (
            <span className="ss-decl__actions">
              {props.showNest !== false && (
                <NestControl nestTargets={nestTargets} onNest={onNest} />
              )}
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
          )}
        </div>
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
