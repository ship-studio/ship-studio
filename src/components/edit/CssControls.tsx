/**
 * Structured visual controls for the CSS-Mode editor (Phase 4).
 *
 * Renders one category's controls (segmented / dropdown / length / color) for a
 * resolved rule, plus an always-available "add any property" row. Each control
 * reads its value straight from the rule's declarations and writes a single CSS
 * property: a quick `onPreview` for live feedback, then `onSave` to persist.
 *
 * Dropdowns and the color popover reuse the Tailwind editor's components
 * (`EnumDropdown`, `ColorPicker`) so both editors look and behave identically.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { Button } from '../primitives/Button';
import { EnumDropdown } from './EnumDropdown';
import { ColorPicker } from './ColorPicker';
import { CSS_CATEGORIES, cssValueOf, type CssControl, type SegOption } from '../../lib/cssControls';
import type { CssDeclaration } from '../../lib/edit-css';

function cssSupports(prop: string, value: string): boolean {
  try {
    return (
      typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports(prop, value)
    );
  } catch {
    return false;
  }
}

function isValidProperty(prop: string): boolean {
  return /^-{0,2}[a-z][a-z0-9-]*$/.test(prop.trim());
}

interface ControlProps {
  value: string;
  onPreview: (property: string, value: string | null) => void;
  onSave: (property: string, value: string | null) => void;
}

/** A control label that doubles as a Reset affordance — same behavior as the
 *  Tailwind editor's ResettableLabel: when the property is set, the label is
 *  clickable and pops a floating "Reset" next to the cursor that clears it. */
function ResettableCcLabel({
  label,
  isSet,
  onReset,
}: {
  label: string;
  isSet: boolean;
  onReset: () => void;
}) {
  const [pop, setPop] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLButtonElement>(null);

  useDismissOnOutsidePointer(pop !== null, popRef, () => setPop(null), {
    isOutside: (t) => !popRef.current?.contains(t) && !btnRef.current?.contains(t),
  });
  useEffect(() => {
    if (!pop) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPop(null);
    const onScroll = () => setPop(null);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [pop]);

  if (!isSet) return <span className="ss-cc-label">{label}</span>;

  const openAt = (e: ReactMouseEvent) => {
    const M = 8;
    const W = 72;
    const H = 28;
    setPop({
      left: Math.min(e.clientX + 10, window.innerWidth - W - M),
      top: Math.min(e.clientY + 10, window.innerHeight - H - M),
    });
  };

  return (
    <span className="ss-cc-label ss-cc-label--resettable">
      <button
        ref={btnRef}
        type="button"
        className="ss-cc-labelbtn"
        aria-expanded={pop !== null}
        onClick={openAt}
        title={`${label} is set — click to reset`}
      >
        {label}
        <span className="ss-cc-setdot" aria-hidden />
      </button>
      {pop &&
        createPortal(
          <button
            ref={popRef}
            type="button"
            className="ss-reset-pop"
            style={{ top: pop.top, left: pop.left }}
            onClick={() => {
              onReset();
              setPop(null);
            }}
          >
            Reset
          </button>,
          document.body
        )}
    </span>
  );
}

function Field({
  label,
  isSet,
  onReset,
  children,
}: {
  label: string;
  isSet?: boolean;
  onReset?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="ss-cc-field">
      {onReset ? (
        <ResettableCcLabel label={label} isSet={!!isSet} onReset={onReset} />
      ) : (
        <span className="ss-cc-label">{label}</span>
      )}
      {children}
    </div>
  );
}

function Segmented({
  prop,
  label,
  options,
  value,
  onPreview,
  onSave,
}: ControlProps & { prop: string; label: string; options: SegOption[] }) {
  return (
    <Field
      label={label}
      isSet={value.trim() !== ''}
      onReset={() => {
        onPreview(prop, null);
        onSave(prop, null);
      }}
    >
      <div className="ss-cc-seg" role="group" aria-label={label}>
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              className={`ss-cc-seg__btn${active ? ' is-active' : ''}`}
              title={o.title ?? o.label ?? o.value}
              aria-pressed={active}
              onClick={() => {
                const next = active ? null : o.value; // click active again to clear
                onPreview(prop, next);
                onSave(prop, next);
              }}
            >
              {o.glyph ?? o.label ?? o.value}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function SelectControl({
  prop,
  label,
  options,
  value,
  onPreview,
  onSave,
}: ControlProps & { prop: string; label: string; options: { value: string; label: string }[] }) {
  return (
    <Field
      label={label}
      isSet={value.trim() !== ''}
      onReset={() => {
        onPreview(prop, null);
        onSave(prop, null);
      }}
    >
      <EnumDropdown
        label={label}
        value={value || null}
        options={[
          { label: '—', token: '' },
          ...options.map((o) => ({ label: o.label, token: o.value })),
        ]}
        onChange={(token) => {
          const v = token || null;
          onPreview(prop, v);
          onSave(prop, v);
        }}
      />
    </Field>
  );
}

function LengthControl({
  prop,
  label,
  placeholder,
  value,
  onPreview,
  onSave,
}: ControlProps & { prop: string; label: string; placeholder?: string }) {
  const [v, setV] = useState(value);
  const valid = v.trim() === '' || cssSupports(prop, v.trim());
  const commit = () => {
    const next = v.trim();
    if (next === value) return;
    if (next !== '' && !valid) {
      setV(value);
      onPreview(prop, value || null);
      return;
    }
    onSave(prop, next === '' ? null : next);
  };
  return (
    <Field
      label={label}
      isSet={value.trim() !== ''}
      onReset={() => {
        onPreview(prop, null);
        onSave(prop, null);
      }}
    >
      <input
        className={`ss-cc-input${!valid ? ' is-invalid' : ''}`}
        value={v}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setV(e.target.value);
          const t = e.target.value.trim();
          if (t && cssSupports(prop, t)) onPreview(prop, t);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setV(value);
            onPreview(prop, value || null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </Field>
  );
}

/** Color control: a swatch that opens the shared ColorPicker popover. Previews
 *  live while dragging; commits the final value when the popover closes. */
function ColorControl({
  prop,
  label,
  value,
  onPreview,
  onSave,
}: ControlProps & { prop: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  const [local, setLocal] = useState(value || '');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef(value);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = 216;
    const H = 250;
    const M = 8;
    let left = r.left - W - M;
    if (left < M) left = r.right + M;
    left = Math.min(Math.max(M, left), window.innerWidth - W - M);
    const top = Math.min(Math.max(M, r.top), window.innerHeight - H - M);
    setRect({ top, left });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    if (latestRef.current !== value) onSave(prop, latestRef.current || null);
  }, [prop, value, onSave]);

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

  useDismissOnOutsidePointer(open, popRef, close, {
    isOutside: (t) => !triggerRef.current?.contains(t) && !popRef.current?.contains(t),
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const commitText = () => {
    const next = local.trim();
    if (next === (value || '')) return;
    if (next !== '' && !cssSupports(prop, next)) {
      setLocal(value || '');
      return;
    }
    onSave(prop, next === '' ? null : next);
  };

  return (
    <Field
      label={label}
      isSet={value.trim() !== ''}
      onReset={() => {
        onPreview(prop, null);
        onSave(prop, null);
      }}
    >
      <div className="ss-cc-color">
        <button
          ref={triggerRef}
          type="button"
          className="ss-color-swatch"
          title={`${label} color`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            if (open) {
              close();
            } else {
              latestRef.current = value;
              setLocal(value || '');
              setOpen(true);
            }
          }}
        >
          {value ? (
            <span className="ss-color-swatch__chip" style={{ background: value }} />
          ) : (
            <span className="ss-color-swatch__empty">—</span>
          )}
        </button>
        <input
          className="ss-cc-input"
          value={local}
          placeholder="—"
          spellCheck={false}
          aria-label={`${label} value`}
          onChange={(e) => {
            setLocal(e.target.value);
            latestRef.current = e.target.value;
            const t = e.target.value.trim();
            if (t && cssSupports(prop, t)) onPreview(prop, t);
          }}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      {open &&
        rect &&
        createPortal(
          <div ref={popRef} className="ss-color-popover" style={{ top: rect.top, left: rect.left }}>
            <ColorPicker
              value={local || '#000000'}
              onChange={(css) => {
                setLocal(css);
                latestRef.current = css;
                onPreview(prop, css);
              }}
            />
          </div>,
          document.body
        )}
    </Field>
  );
}

/** Expand a `padding`/`margin` shorthand into its four sides (CSS rules). */
function expandShorthand(value: string): Record<'top' | 'right' | 'bottom' | 'left', string> {
  const p = value.trim().split(/\s+/);
  if (p.length === 1) return { top: p[0], right: p[0], bottom: p[0], left: p[0] };
  if (p.length === 2) return { top: p[0], right: p[1], bottom: p[0], left: p[1] };
  if (p.length === 3) return { top: p[0], right: p[1], bottom: p[2], left: p[1] };
  return { top: p[0], right: p[1], bottom: p[2], left: p[3] };
}

/** Effective value of one box side: an explicit longhand wins, else the side
 *  derived from the shorthand, else empty. */
function sideValue(
  declarations: CssDeclaration[],
  type: 'padding' | 'margin',
  side: string
): string {
  const long = cssValueOf(declarations, `${type}-${side}`);
  if (long) return long;
  const short = cssValueOf(declarations, type);
  if (short) return expandShorthand(short)[side as 'top'];
  return '';
}

/** One side input of the box-model editor. Writes the longhand (`padding-top`). */
function BoxSide({
  type,
  side,
  edge,
  value,
  onPreview,
  onSave,
}: {
  type: 'padding' | 'margin';
  side: string;
  edge: string;
  value: string;
} & Pick<ControlProps, 'onPreview' | 'onSave'>) {
  const prop = `${type}-${side}`;
  const [text, setText] = useState(value);
  const valid = text.trim() === '' || cssSupports(type, text.trim());
  const commit = () => {
    const next = text.trim();
    if (next === value) return;
    if (next !== '' && !valid) {
      setText(value);
      onPreview(prop, value || null);
      return;
    }
    onSave(prop, next === '' ? null : next);
  };
  return (
    <input
      className={`ss-box__field ss-box__edge--${edge}${valid ? '' : ' ss-box__field--invalid'}`}
      aria-label={`${type} ${side}`}
      placeholder="0"
      spellCheck={false}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.trim();
        if (t && cssSupports(type, t)) onPreview(prop, t);
      }}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** Webflow-style box-model editor (margin wrapping padding), CSS-native: each
 *  side reads its effective value (longhand or shorthand) and writes a longhand.
 *  Reuses the Tailwind editor's `ss-box` styling so the two look identical. */
function CssSpacingBox({
  declarations,
  onPreview,
  onSave,
}: Omit<ControlProps, 'value'> & { declarations: CssDeclaration[] }) {
  const f = (type: 'padding' | 'margin', side: string, edge: string) => {
    const v = sideValue(declarations, type, side);
    return (
      <BoxSide
        key={`${type}-${side}-${v}`}
        type={type}
        side={side}
        edge={edge}
        value={v}
        onPreview={onPreview}
        onSave={onSave}
      />
    );
  };
  return (
    <div className="ss-box" data-testid="css-spacing-box">
      <span className="ss-box__tag">MARGIN</span>
      {f('margin', 'top', 't')}
      {f('margin', 'bottom', 'b')}
      {f('margin', 'left', 'l')}
      {f('margin', 'right', 'r')}
      <div className="ss-box__inner">
        <span className="ss-box__tag">PADDING</span>
        {f('padding', 'top', 't')}
        {f('padding', 'bottom', 'b')}
        {f('padding', 'left', 'l')}
        {f('padding', 'right', 'r')}
        <div className="ss-box__core" />
      </div>
    </div>
  );
}

function Control({
  control,
  value,
  onPreview,
  onSave,
  highlight,
}: { control: CssControl; highlight?: boolean } & ControlProps) {
  const key = `${control.prop}:${value}`;
  let inner: ReactNode;
  switch (control.kind) {
    case 'segmented':
      inner = (
        <Segmented
          prop={control.prop}
          label={control.label}
          options={control.options}
          value={value}
          onPreview={onPreview}
          onSave={onSave}
        />
      );
      break;
    case 'select':
      inner = (
        <SelectControl
          prop={control.prop}
          label={control.label}
          options={control.options}
          value={value}
          onPreview={onPreview}
          onSave={onSave}
        />
      );
      break;
    case 'length':
      inner = (
        <LengthControl
          key={key}
          prop={control.prop}
          label={control.label}
          placeholder={control.placeholder}
          value={value}
          onPreview={onPreview}
          onSave={onSave}
        />
      );
      break;
    case 'color':
      inner = (
        <ColorControl
          key={key}
          prop={control.prop}
          label={control.label}
          value={value}
          onPreview={onPreview}
          onSave={onSave}
        />
      );
      break;
  }
  return (
    <div data-prop={control.prop} className={`ss-cc-ctrl${highlight ? ' ss-cc-hl' : ''}`}>
      {inner}
    </div>
  );
}

/** Type any CSS property + value and add it to the rule. Always available so no
 *  property is ever out of reach of the visual editor. `onAdded` fires with the
 *  property so the panel can jump to (and highlight) its structured control. */
export function AddProp({
  onSave,
  onAdded,
}: {
  onSave: (property: string, value: string | null) => void;
  onAdded?: (property: string) => void;
}) {
  const [prop, setProp] = useState('');
  const [value, setValue] = useState('');
  const ready =
    isValidProperty(prop) && value.trim() !== '' && cssSupports(prop.trim(), value.trim());
  const add = () => {
    if (!ready) return;
    const p = prop.trim().toLowerCase();
    onSave(p, value.trim());
    onAdded?.(p);
    setProp('');
    setValue('');
  };
  return (
    <div className="ss-cc-add">
      <span className="ss-cc-label">Add property</span>
      <div className="ss-cc-add__row">
        <input
          className="ss-cc-input"
          placeholder="property"
          value={prop}
          spellCheck={false}
          onChange={(e) => setProp(e.target.value)}
        />
        <input
          className="ss-cc-input"
          placeholder="value"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <Button variant="secondary" size="sm" onClick={add} disabled={!ready}>
          Add
        </Button>
      </div>
    </div>
  );
}

export function CssControls({
  category,
  declarations,
  onPreview,
  onSave,
  highlightProp,
}: {
  category: string;
  declarations: CssDeclaration[];
  onPreview: (property: string, value: string | null) => void;
  onSave: (property: string, value: string | null) => void;
  highlightProp?: string | null;
}) {
  const get = (p: string) => cssValueOf(declarations, p);
  const cat = CSS_CATEGORIES.find((c) => c.id === category);
  if (!cat) return null;
  const controls = cat.controls.filter((c) => !c.showIf || c.showIf(get));
  return (
    <div className="ss-cc">
      {category === 'spacing' ? (
        <CssSpacingBox declarations={declarations} onPreview={onPreview} onSave={onSave} />
      ) : (
        controls.map((c) => (
          <Control
            key={c.prop}
            control={c}
            value={get(c.prop)}
            onPreview={onPreview}
            onSave={onSave}
            highlight={highlightProp === c.prop}
          />
        ))
      )}
    </div>
  );
}
