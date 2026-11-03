/**
 * Variables editor — the project's CSS custom properties as design tokens. Values in
 * `:root` and scoped selectors share the same inline editor and live preview. Add and
 * reorder stay in the root section; delete keeps its global, name-based behavior there.
 * Scoped rows expose value editing only.
 */

import { useCallback, useMemo, useState } from 'react';
import { ColorIcon, MoreHorizontalIcon, PlusIcon, TrashIcon } from '@/components/icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import type { CssVariableDeleteImpact } from '../../lib/edit-css';
import type { DragSortMove } from '../../lib/drag-sort/types';
import { cssVariableId, type VariableRow } from '../../hooks/useCssVariables';
import { Button } from '../primitives/Button';
import { DragSortHandle, DragSortItem, DragSortScope } from '../primitives/DragSort';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { ModalFrame } from '../primitives/ModalFrame';
import { PropertyField } from '../primitives/PropertyField';
import { Spinner } from '../primitives/Spinner';
import { EditPopover } from './EditPopover';
import { CssValueText } from './CssValueText';
import { hasColorTransparency } from '../../lib/color';
import { colorSwatch } from '../../lib/cssProperties';
import { resolveColorVariable } from '../../lib/colorContrast';
import type { ValueFieldVariable } from '../primitives/ValueField';
import { TextButton } from '../primitives/TextButton';
import { colorPickerDraftOrFallback } from './colorPickerDraft';

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
  /** Persist a projected order within one exact `:root` source rule. */
  onReorderVariables?: (ordered: VariableRow[]) => Promise<void>;
  projectPath?: string;
  onOpenInCode?: (file: string, line: number) => void;
  onOpenSource?: (source: Pick<VariableRow, 'file' | 'line' | 'selector'>) => void;
}

export function CssVariablesPanel({
  variables,
  loading,
  variableNames,
  onSetValue,
  onAddVariable,
  onAnalyzeDelete,
  onDeleteVariable,
  onReorderVariables,
  projectPath,
  onOpenInCode,
  onOpenSource,
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
  const rootVars = variables.filter((v) => v.selector === ':root');
  const variableIdCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const variable of variables) {
      const id = cssVariableId(variable);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [variables]);
  const rowKey = (variable: VariableRow, index: number) => {
    const id = cssVariableId(variable);
    return (variableIdCounts.get(id) ?? 0) > 1 ? `${id}\0${index}` : id;
  };
  // Keep each selector's definitions together, including duplicate names in separate rules.
  const scopedGroups = useMemo(() => {
    const map = new Map<string, VariableRow[]>();
    for (const v of variables) {
      if (v.selector === ':root') continue;
      const list = map.get(v.selector) ?? [];
      list.push(v);
      map.set(v.selector, list);
    }
    return [...map.entries()];
  }, [variables]);

  const rootGroupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const blockedSources = new Set(
      rootVars.filter((variable) => !variable.editable).map(variableSourceKey)
    );
    for (const variable of rootVars) {
      const key = variableSourceKey(variable);
      if (blockedSources.has(key)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [rootVars]);
  const canSortRoot =
    Boolean(onReorderVariables) && [...rootGroupCounts.values()].some((count) => count > 1);
  const rootIds = useMemo(
    () =>
      rootVars
        .filter(
          (variable) =>
            variable.editable && (rootGroupCounts.get(variableSourceKey(variable)) ?? 0) > 1
        )
        .map(cssVariableId),
    [rootGroupCounts, rootVars]
  );
  const handleRootMove = useCallback(
    async (move: DragSortMove) => {
      if (!onReorderVariables || !move.projectedOrder) return;
      const byId = new Map(rootVars.map((variable) => [cssVariableId(variable), variable]));
      const ordered = move.projectedOrder
        .map((id) => byId.get(String(id)))
        .filter((variable): variable is VariableRow => variable !== undefined);
      if (ordered.length !== move.projectedOrder.length) return;
      await onReorderVariables(ordered);
    },
    [onReorderVariables, rootVars]
  );

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
        <VariableScopeLink
          selector=":root"
          variables={rootVars}
          onOpenInCode={onOpenInCode}
          onOpenSource={onOpenSource}
        />
        <span className="ss-vars__scope-note">project tokens</span>
      </div>

      {rootVars.length === 0 ? (
        <p className="ss-cascade-empty">No variables defined on :root yet.</p>
      ) : canSortRoot ? (
        <DragSortScope
          axis="vertical"
          items={rootIds}
          label=":root variables"
          onMove={handleRootMove}
        >
          <div className="ss-vars__list">
            {rootVars.map((v, index) =>
              v.editable ? (
                <EditableVarRow
                  key={rowKey(v, index)}
                  variable={v}
                  variableNames={variableNames}
                  variables={variables}
                  projectPath={projectPath}
                  sortable={(rootGroupCounts.get(variableSourceKey(v)) ?? 0) > 1}
                  sortGroup={variableSourceKey(v)}
                  sortIndex={
                    rootVars
                      .slice(0, index)
                      .filter(
                        (candidate) =>
                          candidate.editable &&
                          variableSourceKey(candidate) === variableSourceKey(v) &&
                          (rootGroupCounts.get(variableSourceKey(candidate)) ?? 0) > 1
                      ).length
                  }
                  onSetValue={(val) => onSetValue(v, val)}
                  onRequestDelete={() => requestDelete(v)}
                />
              ) : (
                <ReadonlyVarRow key={rowKey(v, index)} variable={v} />
              )
            )}
          </div>
        </DragSortScope>
      ) : (
        <div className="ss-vars__list">
          {rootVars.map((v, index) =>
            v.editable ? (
              <EditableVarRow
                key={rowKey(v, index)}
                variable={v}
                variableNames={variableNames}
                variables={variables}
                projectPath={projectPath}
                onSetValue={(val) => onSetValue(v, val)}
                onRequestDelete={() => requestDelete(v)}
              />
            ) : (
              <ReadonlyVarRow key={rowKey(v, index)} variable={v} />
            )
          )}
        </div>
      )}

      <AddVariable existing={new Set(rootVars.map((v) => v.name))} onAdd={onAddVariable} />

      {scopedGroups.map(([selector, vars]) => (
        <section key={selector} className="ss-vars__scoped">
          <div className="ss-vars__scope">
            <VariableScopeLink
              selector={selector}
              variables={vars}
              onOpenInCode={onOpenInCode}
              onOpenSource={onOpenSource}
            />
            <span className="ss-vars__scope-note">scoped tokens</span>
          </div>
          <div className="ss-vars__list">
            {vars.map((v, index) =>
              v.editable ? (
                <EditableVarRow
                  key={rowKey(v, index)}
                  variable={v}
                  variableNames={variableNames}
                  variables={variables}
                  projectPath={projectPath}
                  onSetValue={(value) => onSetValue(v, value)}
                />
              ) : (
                <ReadonlyVarRow key={rowKey(v, index)} variable={v} />
              )
            )}
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

function uniqueRules(vars: VariableRow[]): VariableRow[] {
  return [
    ...new Map(
      vars.map((variable) => [`${variable.file}\0${variable.selector}\0${variable.line}`, variable])
    ).values(),
  ];
}

function VariableScopeLink({
  selector,
  variables,
  onOpenInCode,
  onOpenSource,
}: {
  selector: string;
  variables: VariableRow[];
  onOpenInCode?: (file: string, line: number) => void;
  onOpenSource?: (source: Pick<VariableRow, 'file' | 'line' | 'selector'>) => void;
}) {
  const sources = uniqueRules(variables);
  const openSource = (source: VariableRow) => {
    if (onOpenSource) onOpenSource(source);
    else onOpenInCode?.(source.file, source.line);
  };
  if ((!onOpenInCode && !onOpenSource) || sources.length === 0) {
    return <code className="ss-vars__scope-sel">{selector}</code>;
  }

  if (sources.length === 1) {
    const [source] = sources;
    return (
      <TextButton
        className="ss-vars__scope-sel"
        title={`Open ${source.file}:${source.line} in Code tab`}
        aria-label={`Open ${selector} in ${source.file} at line ${source.line} in Code tab`}
        onClick={() => openSource(source)}
      >
        {selector}
      </TextButton>
    );
  }

  const sourceDetails = sources.map((source) => `${source.file}:${source.line}`).join('\n');
  return (
    <Dropdown
      align="left"
      portal
      menuClassName="ss-vars__scope-menu"
      trigger={(triggerProps) => (
        <TextButton
          {...triggerProps}
          className="ss-vars__scope-sel"
          title={sourceDetails}
          aria-label={`Choose a source for ${selector}`}
        >
          {selector}
        </TextButton>
      )}
    >
      {sources.map((source) => {
        const location = `${source.file}:${source.line}`;
        return (
          <DropdownItem
            key={`${source.file}\0${source.selector}\0${source.line}`}
            onSelect={() => openSource(source)}
          >
            <span title={`Open ${location} in Code tab`}>{location}</span>
          </DropdownItem>
        );
      })}
    </Dropdown>
  );
}

function ReadonlyVarRow({ variable }: { variable: VariableRow }) {
  return (
    <div className="ss-var-row is-readonly">
      <span className="ss-var-row__name">
        <VariableValueMarker value={variable.value} />
        <code>{variable.name}</code>
      </span>
      <span className="ss-var-row__colon">:</span>
      <span className="ss-var-row__value-group">
        <ColorSwatch value={variable.value} />
        <span className="ss-var-row__value ss-var-row__value--ro">
          <CssValueText value={variable.value} />
        </span>
      </span>
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
    type === 'variable'
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
      {type === 'color' ? <ColorIcon size={12} /> : glyph}
    </span>
  );
}

function ColorSwatch({
  value,
  onClick,
  editorTrigger = false,
  expanded = false,
}: {
  value: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Match the CSS declaration swatch when rendered inside the shared value editor. */
  editorTrigger?: boolean;
  expanded?: boolean;
}) {
  const c = colorSwatch(value);
  if (!c) return null;
  const className = [
    'ss-var-row__swatch',
    onClick ? 'ss-var-row__swatch--button' : null,
    editorTrigger ? 'ss-decl__swatch-trigger' : null,
    editorTrigger ? 'ss-var-row__swatch--editor' : null,
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
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onMouseDown={(event) => {
        if (editorTrigger) event.preventDefault();
      }}
      onClick={onClick}
    >
      {color}
    </button>
  );
}

function EditableVarRow({
  variable,
  variableNames,
  variables,
  projectPath,
  onSetValue,
  onRequestDelete,
  sortable = false,
  sortGroup,
  sortIndex = 0,
}: {
  variable: VariableRow;
  variableNames: string[];
  variables: readonly ValueFieldVariable[];
  projectPath?: string;
  onSetValue: (value: string) => void;
  onRequestDelete?: () => void;
  sortable?: boolean;
  sortGroup?: string;
  sortIndex?: number;
}) {
  const [editing, setEditing] = useState<
    null | { kind: 'value' } | { kind: 'color'; anchor: HTMLElement; value: string }
  >(null);
  const toggleColorPicker = (anchor: HTMLElement, value = variable.value) => {
    setEditing((current) => (current?.kind === 'color' ? null : { kind: 'color', anchor, value }));
  };
  // Offer the other tokens as `var(--…)` so a token can alias another.
  const options = useMemo(
    () => variableNames.filter((n) => n !== variable.name).map((n) => `var(${n})`),
    [variableNames, variable.name]
  );
  const colorVariables = useMemo(
    () => variables.filter((candidate) => candidate.name !== variable.name),
    [variables, variable.name]
  );
  const initialColorValue =
    resolveColorVariable(variable.value, colorVariables, variable.selector) ?? variable.value;
  const initialSwatchColor = colorSwatch(initialColorValue);
  const editingValue = editing?.kind === 'value';
  const valueGroupClassName = [
    'ss-var-row__value-group',
    'ss-var-row__value-group--editable',
    initialSwatchColor ? 'ss-var-row__value-group--has-swatch' : null,
  ]
    .filter(Boolean)
    .join(' ');

  const row = (
    <div className="ss-var-row">
      {sortable && (
        <DragSortHandle
          className="ss-var-row__drag-handle"
          visibility="hover"
          revealOn="row"
          label={`Move ${variable.name} variable`}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      <span className="ss-var-row__name">
        <VariableValueMarker value={variable.value} />
        <code>{variable.name}</code>
        {onRequestDelete && (
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
            <DropdownItem
              variant="danger"
              icon={<TrashIcon size={14} />}
              onSelect={onRequestDelete}
            >
              Delete
            </DropdownItem>
          </Dropdown>
        )}
      </span>
      <span className="ss-var-row__colon">:</span>
      <span className={valueGroupClassName}>
        {!editingValue && initialSwatchColor && (
          <ColorSwatch
            value={initialColorValue}
            expanded={editing?.kind === 'color'}
            onClick={(event) => toggleColorPicker(event.currentTarget)}
          />
        )}
        <PropertyField
          variant="variable"
          size="compact"
          className="ss-var-row__value"
          title="Click to edit"
          aria-hidden={editingValue || undefined}
          tabIndex={editingValue ? -1 : undefined}
          onClick={() => setEditing({ kind: 'value' })}
        >
          {variable.value ? (
            <CssValueText value={variable.value} />
          ) : (
            <span className="ss-var-row__empty">empty</span>
          )}
        </PropertyField>
        {editingValue && (
          <EditPopover
            inline
            anchor={null}
            initial={variable.value}
            initialSwatch={Boolean(initialSwatchColor)}
            colorSwatchTrigger={
              initialSwatchColor
                ? (value, fullValue) => {
                    const resolved = resolveColorVariable(value, colorVariables, variable.selector);
                    const liveSwatchColor = colorSwatch(resolved ?? value) ?? initialSwatchColor;
                    return (
                      <ColorSwatch
                        value={liveSwatchColor}
                        editorTrigger
                        onClick={(event) => {
                          const row = event.currentTarget.closest<HTMLElement>('.ss-var-row');
                          if (row) {
                            toggleColorPicker(
                              row,
                              colorPickerDraftOrFallback(
                                fullValue,
                                initialColorValue,
                                colorVariables,
                                variable.selector
                              )
                            );
                          }
                        }}
                      />
                    );
                  }
                : undefined
            }
            options={options}
            variables={colorVariables}
            variableSelector={variable.selector}
            projectPath={projectPath}
            enableColorPicker={false}
            placeholder="value"
            onCommit={onSetValue}
            onClose={() => setEditing(null)}
          />
        )}
      </span>
      {editing?.kind === 'color' && (
        <EditPopover
          anchor={editing.anchor}
          initial={editing.value}
          variables={colorVariables}
          variableSelector={variable.selector}
          projectPath={projectPath}
          enableColorPicker
          placeholder="value"
          onCommit={onSetValue}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );

  if (!sortable) return row;
  return (
    <DragSortItem
      id={cssVariableId(variable)}
      group={sortGroup}
      index={sortIndex}
      label={`Move ${variable.name} variable`}
      className="ss-var-sort-item"
    >
      {row}
    </DragSortItem>
  );
}

function variableSourceKey(variable: Pick<VariableRow, 'file' | 'selector' | 'line'>): string {
  return `${variable.file}\0${variable.selector}\0${variable.line}`;
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

  const norm = name.trim().startsWith('--') ? name.trim() : `--${name.trim()}`;
  const dupe = name.trim().length > 0 && existing.has(norm);

  return (
    <>
      {open && (
        <div className="ss-var-row">
          <span className="ss-var-row__name">
            <VariableValueMarker value={value} />
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
                  aria-label="Cancel adding variable"
                  title="Cancel adding variable"
                  icon={<MoreHorizontalIcon size={12} />}
                />
              )}
            >
              <DropdownItem
                variant="danger"
                icon={<TrashIcon size={14} />}
                onSelect={() => setOpen(false)}
              >
                Cancel
              </DropdownItem>
            </Dropdown>
          </span>
          <span className="ss-var-row__colon">:</span>
          <span className="ss-var-row__value-group">
            <ColorSwatch value={value} />
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
          </span>
        </div>
      )}
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
    </>
  );
}
