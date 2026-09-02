/**
 * Variables editor — the project's CSS custom properties as design tokens. `:root`
 * tokens are editable (click a value → text editor; click a color swatch → picker),
 * with live preview as you go; tokens scoped to other selectors are listed read-only,
 * grouped by their scope, so the panel stays truthful about where each is defined.
 */

import { useMemo, useState } from 'react';
import { MoreHorizontalIcon, PlusIcon, TrashIcon } from '@/components/icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import type { CssVariableDeleteImpact } from '../../lib/edit-css';
import { Button } from '../primitives/Button';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { ModalFrame } from '../primitives/ModalFrame';
import { PropertyField } from '../primitives/PropertyField';
import { Spinner } from '../primitives/Spinner';
import { EditPopover } from './EditPopover';
import { CssValueText } from './CssValueText';
import { hasColorTransparency } from '../../lib/color';
import { colorSwatch } from '../../lib/cssProperties';
import type { VariableRow } from '../../hooks/useCssVariables';

interface Props {
  variables: VariableRow[];
  loading: boolean;
  variableNames: string[];
  onSetValue: (variable: VariableRow, value: string) => void;
  onAddVariable: (name: string, value: string) => void;
  onAnalyzeDelete: (variable: VariableRow) => Promise<CssVariableDeleteImpact>;
  onDeleteVariable: (
    variable: VariableRow,
    impact: CssVariableDeleteImpact
  ) => Promise<CssVariableDeleteImpact>;
}

export function CssVariablesPanel({
  variables,
  loading,
  variableNames,
  onSetValue,
  onAddVariable,
  onAnalyzeDelete,
  onDeleteVariable,
}: Props) {
  const [deleteTarget, setDeleteTarget] = useState<VariableRow | null>(null);
  const deleteImpact = useAsyncState(onAnalyzeDelete);
  const deletion = useAsyncState(onDeleteVariable, {
    onSuccess: () => {
      setDeleteTarget(null);
      deleteImpact.reset();
    },
    onError: () => {
      if (deleteTarget) void deleteImpact.execute(deleteTarget);
    },
  });
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

  const requestDelete = (variable: VariableRow) => {
    setDeleteTarget(variable);
    deleteImpact.reset();
    void deleteImpact.execute(variable);
  };

  const closeDeleteModal = () => {
    if (deletion.isLoading) return;
    setDeleteTarget(null);
    deleteImpact.reset();
    deletion.reset();
  };

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
              onSetValue={(val) => onSetValue(v, val)}
              onRequestDelete={() => requestDelete(v)}
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
                <span className="ss-var-row__name">
                  <VariableValueMarker value={v.value} />
                  <code>{v.name}</code>
                </span>
                <span className="ss-var-row__colon">:</span>
                <span className="ss-var-row__value-group">
                  <ColorSwatch value={v.value} />
                  <span className="ss-var-row__value ss-var-row__value--ro">
                    <CssValueText value={v.value} />
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}

      <DeleteVariableModal
        variable={deleteTarget}
        impact={deleteImpact.data}
        analyzing={deleteImpact.isLoading}
        analysisError={deleteImpact.error}
        deleting={deletion.isLoading}
        onRetry={() => deleteTarget && void deleteImpact.execute(deleteTarget)}
        onCancel={closeDeleteModal}
        onConfirm={() => {
          if (deleteTarget && deleteImpact.data) {
            void deletion.execute(deleteTarget, deleteImpact.data);
          }
        }}
      />
    </div>
  );
}

function VariableValueMarker({ value }: { value: string }) {
  const trimmed = value.trim();
  const type = colorSwatch(value)
    ? 'color'
    : /^var\(/i.test(trimmed)
      ? 'variable'
      : /^url\(/i.test(trimmed)
        ? 'url'
        : /^[-+]?\d*\.?\d+(?:ms|s)$/i.test(trimmed)
          ? 'time'
          : /^[-+]?\d*\.?\d+(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex|in|cm|mm|pt|pc)$/i.test(trimmed)
            ? 'length'
            : /^[-+]?\d*\.?\d+$/.test(trimmed)
              ? 'number'
              : /\(/.test(trimmed)
                ? 'function'
                : 'text';
  const glyph =
    type === 'color'
      ? '●'
      : type === 'variable'
        ? '◆'
        : type === 'url'
          ? '↗'
          : type === 'time'
            ? '◷'
            : type === 'length'
              ? '↔'
              : type === 'number'
                ? '#'
                : type === 'function'
                  ? 'ƒ'
                  : 'T';
  return (
    <span className="ss-var-row__type-icon" role="img" aria-label={`${type} variable`}>
      {glyph}
    </span>
  );
}

function ColorSwatch({
  value,
  onClick,
}: {
  value: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const c = colorSwatch(value);
  if (!c) return null;
  const className = [
    'ss-var-row__swatch',
    onClick ? 'ss-var-row__swatch--button' : null,
    hasColorTransparency(c) ? 'ss-color-swatch__chip--checkerboard' : null,
  ]
    .filter(Boolean)
    .join(' ');
  const color = <span className="ss-var-row__swatch-color" style={{ backgroundColor: c }} />;
  if (!onClick) {
    return (
      <span className={className} aria-hidden="true">
        {color}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      aria-label="Open color picker"
      title="Open color picker"
      onClick={onClick}
    >
      {color}
    </button>
  );
}

function EditableVarRow({
  variable,
  variableNames,
  onSetValue,
  onRequestDelete,
}: {
  variable: VariableRow;
  variableNames: string[];
  onSetValue: (value: string) => void;
  onRequestDelete: () => void;
}) {
  const [editing, setEditing] = useState<
    null | { kind: 'value' } | { kind: 'color'; anchor: HTMLElement }
  >(null);
  const toggleColorPicker = (anchor: HTMLElement) => {
    setEditing((current) =>
      current?.kind === 'color' && current.anchor === anchor ? null : { kind: 'color', anchor }
    );
  };
  // Offer the other tokens as `var(--…)` so a token can alias another.
  const options = useMemo(
    () => variableNames.filter((n) => n !== variable.name).map((n) => `var(${n})`),
    [variableNames, variable.name]
  );

  return (
    <div className="ss-var-row">
      <span className="ss-var-row__name">
        <VariableValueMarker value={variable.value} />
        <code>{variable.name}</code>
        <Dropdown
          align="right"
          portal
          menuClassName="ss-var-row__menu"
          trigger={(triggerProps) => (
            <IconButton
              {...triggerProps}
              variant="ghost"
              size="compact"
              className="ss-var-row__menu-trigger"
              aria-label={`Actions for ${variable.name}`}
              title={`Actions for ${variable.name}`}
              icon={<MoreHorizontalIcon size={12} />}
            />
          )}
        >
          <DropdownItem variant="danger" icon={<TrashIcon size={14} />} onSelect={onRequestDelete}>
            Delete
          </DropdownItem>
        </Dropdown>
      </span>
      <span className="ss-var-row__colon">:</span>
      <span className="ss-var-row__value-group">
        <ColorSwatch
          value={variable.value}
          onClick={(event) => toggleColorPicker(event.currentTarget)}
        />
        {editing?.kind === 'value' ? (
          <EditPopover
            inline
            anchor={null}
            initial={variable.value}
            options={options}
            enableColorPicker={false}
            placeholder="value"
            onCommit={onSetValue}
            onClose={() => setEditing(null)}
          />
        ) : (
          <PropertyField
            variant="variable"
            size="compact"
            className="ss-var-row__value"
            title="Click to edit"
            onClick={() => setEditing({ kind: 'value' })}
          >
            {variable.value ? (
              <CssValueText value={variable.value} />
            ) : (
              <span className="ss-var-row__empty">empty</span>
            )}
          </PropertyField>
        )}
      </span>
      {editing?.kind === 'color' && (
        <EditPopover
          anchor={editing.anchor}
          initial={variable.value}
          enableColorPicker
          placeholder="value"
          onCommit={onSetValue}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function DeleteVariableModal({
  variable,
  impact,
  analyzing,
  analysisError,
  deleting,
  onRetry,
  onCancel,
  onConfirm,
}: {
  variable: VariableRow | null;
  impact: CssVariableDeleteImpact | null;
  analyzing: boolean;
  analysisError: Error | null;
  deleting: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalFrame
      isOpen={variable !== null}
      onClose={onCancel}
      title="Delete variable?"
      dismissable={!deleting}
      showCloseButton={false}
      className="ss-variable-delete-modal"
    >
      <div className="ss-variable-delete-modal__body">
        {analyzing && <p>Searching the project for usages…</p>}
        {!analyzing && analysisError && (
          <>
            <p>Ship Studio couldn’t verify where this variable is used.</p>
            <p className="text-style-hint">{analysisError.message}</p>
          </>
        )}
        {!analyzing && impact && variable && (
          <>
            <p>
              <code>{variable.name}</code> is used{' '}
              <strong>{plural(impact.usageCount, 'time')}</strong> across{' '}
              <strong>{plural(impact.ruleCount, 'CSS rule')}</strong> in{' '}
              <strong>{plural(impact.fileCount, 'file')}</strong>.
            </p>
            <p className="text-style-hint">
              Deleting it will replace every authored use with the raw value{' '}
              <code>{impact.replacementValue || '(empty)'}</code>, then remove{' '}
              {plural(impact.definitionCount, 'definition')} from the project.
            </p>
          </>
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          {analysisError ? (
            <Button variant="default" onClick={onRetry} disabled={analyzing}>
              Try again
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={onConfirm}
              disabled={!impact || analyzing || deleting}
            >
              {deleting ? 'Deleting…' : 'Delete variable'}
            </Button>
          )}
        </div>
      </div>
    </ModalFrame>
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
      <div className="ss-cascade-action">
        <Button
          variant="default"
          width="fill"
          leftIcon={<PlusIcon size={11} />}
          onClick={() => setOpen(true)}
        >
          Add variable
        </Button>
      </div>
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
