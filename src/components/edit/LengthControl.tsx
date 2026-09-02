/**
 * Sizing control (width / height / min/max variants). The ValueField primitive
 * keeps the editable magnitude separate from its unit while still accepting a
 * complete pasted value (`480px`) and CSS keywords/functions.
 */

import {
  ValueField,
  type ValueFieldOption,
  type ValueFieldVariable,
} from '../primitives/ValueField';
import { ResettableLabel } from './ResettableLabel';
import {
  lengthValue,
  parseLengthInput,
  lengthResetSpec,
  readLayer,
  LENGTH_PRESETS,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';

interface Props {
  label: string;
  prefix: string;
  css: string;
  valueType: 'size' | 'min-size' | 'max-size';
  currentClass: string;
  layer: LayerContext;
  variables?: ValueFieldVariable[];
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onReset: (spec: ResetSpec) => void;
}

const CONTENT_KEYWORDS: ValueFieldOption[] = [
  { value: 'min', label: 'MIN CONTENT', kind: 'keyword' },
  { value: 'max', label: 'MAX CONTENT', kind: 'keyword' },
  { value: 'fit', label: 'FIT CONTENT', kind: 'keyword' },
];

/** The sizing presets (`full`, `screen`, `1/2`…) offered in the field's picker —
 *  `parseLengthInput` turns each into its named Tailwind token (`w-full`, `w-1/2`)
 *  rather than an arbitrary value. */
function presetKeywords(valueType: Props['valueType']): ValueFieldOption[] {
  return LENGTH_PRESETS.filter((preset) =>
    valueType === 'max-size' ? preset !== 'auto' : true
  ).map((preset) => ({
    value: preset,
    // Words read as units in the picker (AUTO, FULL); fractions stay literal.
    label: /^[a-z]+$/.test(preset) ? preset.toUpperCase() : preset,
    kind: 'keyword' as const,
  }));
}

function keywordsFor(valueType: Props['valueType']): ValueFieldOption[] {
  if (valueType === 'max-size') {
    return [
      { value: 'none', label: 'NONE', kind: 'keyword' },
      ...presetKeywords(valueType),
      ...CONTENT_KEYWORDS,
    ];
  }
  return [...presetKeywords(valueType), ...CONTENT_KEYWORDS];
}

export function LengthControl({
  label,
  prefix,
  css,
  valueType,
  currentClass,
  layer,
  variables,
  onApplyEnum,
  onReset,
}: Props) {
  const { value, definedAt } = readLayer(currentClass, layer, (s) => lengthValue(s, prefix));
  const display = value ?? '';
  const commit = (next: string) => {
    const parsed = parseLengthInput(next, prefix, css);
    if (parsed.kind === 'invalid') {
      return false;
    }
    onApplyEnum(parsed.token, { [css]: parsed.css });
    return true;
  };

  return (
    <div className="ss-edit-panel__control">
      <ResettableLabel
        label={label}
        definedAt={definedAt}
        active={layer.bp}
        onReset={() => onReset(lengthResetSpec(prefix, css))}
      />
      <ValueField
        className="ss-edit-panel__text"
        variant="length"
        keywords={keywordsFor(valueType)}
        variables={variables}
        value={display}
        onCommit={commit}
        // Sizes have no meaning below zero — arrow-stepping stops at 0 instead of
        // committing `-1px`, which the parser rejects.
        min={0}
        inputMode="text"
        aria-label={label}
        placeholder={valueType === 'max-size' ? 'none' : 'auto'}
        title={label}
      />
    </div>
  );
}
