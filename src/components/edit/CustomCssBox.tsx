/**
 * Custom CSS — Tailwind's native escape hatch for any property. Arbitrary-property
 * classes are rendered with the same declaration rows used by the non-Tailwind CSS
 * editor: click a property or value to edit it inline, and use Add to create another
 * row. Changes are still written back as real `[prop:value]` classes.
 */

import { useState } from 'react';
import { AddMenu } from './AddMenu';
import { DeclarationRow } from './DeclarationRow';
import {
  tokensForVariant,
  listArbitraryProps,
  parseArbitraryProp,
  type ArbitraryProp,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';
import type { Decl } from '../../lib/cssBody';
import type { ValueFieldVariable } from '../primitives/ValueField';

interface Props {
  currentClass: string;
  layer: LayerContext;
  variables?: ValueFieldVariable[];
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onReset: (spec: ResetSpec) => void;
}

interface CustomCssRow extends ArbitraryProp {
  draft?: boolean;
}

function customRowKey(row: CustomCssRow, editingToken: string | null): string {
  return `${row.token}${editingToken === row.token || row.draft ? ':editing' : ''}`;
}

export function CustomCssBox({ currentClass, layer, variables, onApplyEnum, onReset }: Props) {
  // Arbitrary properties set at the active breakpoint layer (so md edits show under md).
  const scoped = tokensForVariant(currentClass, layer.bp.prefix, layer.known);
  const props = listArbitraryProps(scoped);
  const [pendingProp, setPendingProp] = useState<string | null>(null);
  const [editingToken, setEditingToken] = useState<string | null>(null);

  const pendingRow: CustomCssRow | null = pendingProp
    ? {
        prop: pendingProp,
        value: '',
        token: `__pending__${pendingProp}`,
        draft: true,
      }
    : null;
  const rows: CustomCssRow[] = pendingRow
    ? [...props, ...(props.some((p) => p.prop === pendingRow.prop) ? [] : [pendingRow])]
    : props;
  const variableNames = variables?.map((variable) => variable.name);

  const startAdd = (property: string) => {
    const prop = property.trim().toLowerCase();
    if (!prop) return;
    const existing = props.find((p) => p.prop === prop);
    if (existing) {
      setPendingProp(null);
      setEditingToken(existing.token);
    } else {
      setEditingToken(null);
      setPendingProp(prop);
    }
  };

  const remove = (row: CustomCssRow) => {
    if (row.draft) {
      setPendingProp(null);
      return;
    }
    onReset({ match: (token) => token === row.token, cssProps: [row.prop] });
  };

  const commit = (row: CustomCssRow, next: Decl) => {
    const prop = next.prop.trim().toLowerCase();
    const value = next.value.trim();

    if (value === '') {
      remove(row);
      setEditingToken(null);
      return;
    }

    const parsed = parseArbitraryProp(`${prop}: ${value}`);
    // Keep the old declaration when an inline edit is not valid CSS. The shared
    // editor closes in the same way as the CSS editor; the next click can retry it.
    if (!parsed) return;

    if (!row.draft) remove(row);
    onApplyEnum(parsed.token, { [parsed.prop]: parsed.value });
    setPendingProp(null);
    setEditingToken(null);
  };

  const closeEditor = (row: CustomCssRow) => {
    setEditingToken((token) => (token === row.token ? null : token));
    if (row.draft) setPendingProp(null);
  };

  return (
    <div className="ss-custom-css">
      {rows.length > 0 && (
        <div className="ss-custom-css__list">
          {rows.map((row) => (
            <DeclarationRow
              key={customRowKey(row, editingToken)}
              editable
              decl={{ prop: row.prop, value: row.value, important: false }}
              overridden={false}
              showNest={false}
              nestTargets={[]}
              onNest={() => {}}
              variables={variableNames}
              autoEditValue={row.draft || editingToken === row.token}
              onChange={(next) => commit(row, next)}
              onEditClose={() => closeEditor(row)}
              onRemove={() => remove(row)}
            />
          ))}
        </div>
      )}
      <div className="ss-custom-css__add ss-cascade-card__add-row">
        <AddMenu mode="props" triggerLabel="Add" onAddProperty={startAdd} onNest={() => {}} />
      </div>
    </div>
  );
}
