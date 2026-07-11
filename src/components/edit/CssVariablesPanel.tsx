/**
 * Variables editor — the project's CSS custom properties as design tokens. `:root`
 * tokens are editable (click a value → color picker / drag-scrub / text, with live
 * preview as you go); tokens scoped to other selectors are listed read-only, grouped by
 * their scope, so the panel stays truthful about where each is defined.
 */

import { useMemo, useState } from 'react';
import { PlusIcon } from '../icons/utility';
import { Spinner } from '../primitives/Spinner';
import { EditPopover } from './EditPopover';
import { colorSwatch } from '../../lib/cssProperties';
import type { VariableRow } from '../../hooks/useCssVariables';

interface Props {
  variables: VariableRow[];
  loading: boolean;
  variableNames: string[];
  onSetValue: (name: string, file: string, value: string) => void;
  onAddVariable: (name: string, value: string) => void;
}

export function CssVariablesPanel({
  variables,
  loading,
  variableNames,
  onSetValue,
  onAddVariable,
}: Props) {
  const rootVars = variables.filter((v) => v.editable);
  // Read-only tokens defined on other selectors, grouped by that selector.
  const scopedGroups = useMemo(() => {
    const map = new Map<string, VariableRow[]>();
    for (const v of variables) {
      if (v.editable) continue;
      const list = map.get(v.selector) ?? [];
      list.push(v);
      map.set(v.selector, list);
    }
    return [...map.entries()];
  }, [variables]);

  if (loading && variables.length === 0) {
    return (
      <div className="ss-cascade-loading">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <div className="ss-vars">
      <div className="ss-vars__scope">
        <code className="ss-vars__scope-sel">:root</code>
        <span className="ss-vars__scope-note">project tokens</span>
      </div>

      {rootVars.length === 0 ? (
        <p className="ss-cascade-empty">No variables defined on :root yet.</p>
      ) : (
        <div className="ss-vars__list">
          {rootVars.map((v) => (
            <EditableVarRow
              key={v.name}
              variable={v}
              variableNames={variableNames}
              onSetValue={(val) => onSetValue(v.name, v.file, val)}
            />
          ))}
        </div>
      )}

      <AddVariable existing={new Set(rootVars.map((v) => v.name))} onAdd={onAddVariable} />

      {scopedGroups.map(([selector, vars]) => (
        <section key={selector} className="ss-vars__scoped">
          <div className="ss-vars__scope">
            <code className="ss-vars__scope-sel">{selector}</code>
            <span className="ss-vars__scope-note">read-only</span>
          </div>
          <div className="ss-vars__list">
            {vars.map((v) => (
              <div key={`${selector}-${v.name}`} className="ss-var-row is-readonly">
                <Swatch value={v.value} />
                <code className="ss-var-row__name">{v.name}</code>
                <span className="ss-var-row__value ss-var-row__value--ro">{v.value}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Swatch({ value }: { value: string }) {
  const c = colorSwatch(value);
  if (!c) return null;
  return <span className="ss-var-row__swatch" style={{ background: c }} aria-hidden="true" />;
}

function EditableVarRow({
  variable,
  variableNames,
  onSetValue,
}: {
  variable: VariableRow;
  variableNames: string[];
  onSetValue: (value: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // Offer the other tokens as `var(--…)` so a token can alias another.
  const options = useMemo(
    () => variableNames.filter((n) => n !== variable.name).map((n) => `var(${n})`),
    [variableNames, variable.name]
  );

  return (
    <div className="ss-var-row">
      <Swatch value={variable.value} />
      <code className="ss-var-row__name">{variable.name}</code>
      <button
        type="button"
        className="ss-var-row__value"
        title="Click to edit"
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        {variable.value || <span className="ss-var-row__empty">empty</span>}
      </button>
      {anchor && (
        <EditPopover
          anchor={anchor}
          initial={variable.value}
          options={options}
          placeholder="value"
          onCommit={onSetValue}
          onClose={() => setAnchor(null)}
        />
      )}
    </div>
  );
}

/** "+ Add variable": expands to name + value inputs that create a `:root` token. */
function AddVariable({
  existing,
  onAdd,
}: {
  existing: Set<string>;
  onAdd: (name: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  const submit = () => {
    const n = name.trim();
    if (n) onAdd(n, value.trim());
    setName('');
    setValue('');
    setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="ss-cascade-add-selector" onClick={() => setOpen(true)}>
        <PlusIcon size={11} /> Add variable
      </button>
    );
  }

  const norm = name.trim().startsWith('--') ? name.trim() : `--${name.trim()}`;
  const dupe = name.trim().length > 0 && existing.has(norm);

  return (
    <div className="ss-vars__add">
      <input
        className="ss-var-input ss-var-input--name"
        autoFocus
        value={name}
        spellCheck={false}
        autoComplete="off"
        placeholder="--token"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') document.getElementById('ss-var-add-value')?.focus();
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      <span className="ss-var-row__colon">:</span>
      <input
        id="ss-var-add-value"
        className="ss-var-input"
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder="value"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !dupe) submit();
          else if (e.key === 'Escape') setOpen(false);
        }}
        onBlur={submit}
      />
    </div>
  );
}
