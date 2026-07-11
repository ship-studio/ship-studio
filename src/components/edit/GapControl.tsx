/**
 * Gap control: a stepper (−/＋) around an editable field. The field accepts a
 * Tailwind scale step (a bare integer → `gap-6`) or any valid CSS length
 * (`10rem`, `50%` → `gap-[10rem]`); bad input flags the field. Reads the effective
 * value across the breakpoint cascade and writes at the active layer via the hook.
 */

import { useState } from 'react';
import { Button } from '../primitives/Button';
import { ResettableLabel } from './ResettableLabel';
import {
  spacingValue,
  spacingCss,
  spacingDisplay,
  spacingTokenFor,
  parseSpacingInput,
  spacingResetSpec,
  readLayer,
  type SpacingValue,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';

/** Editable gap value field. Click to type, Enter/blur to apply; ArrowUp/Down step
 *  the value like the −/＋ buttons (Shift ×10, Alt fine). Bad input marks the field
 *  invalid. Stays in sync when +/- steppers change it (prev-value pattern). */
function GapField({
  value,
  onSet,
  onStep,
}: {
  value: SpacingValue | null;
  onSet: (v: SpacingValue) => void;
  onStep: (dir: 1 | -1, step?: number) => void;
}) {
  const display = spacingDisplay(value);
  const [text, setText] = useState(display);
  const [lastDisplay, setLastDisplay] = useState(display);
  const [invalid, setInvalid] = useState(false);
  if (display !== lastDisplay && !invalid) {
    setLastDisplay(display);
    setText(display);
  }

  const commit = () => {
    const parsed = parseSpacingInput(text, 'gap');
    if (parsed.kind === 'invalid') {
      setInvalid(true);
      return false;
    }
    setInvalid(false);
    onSet(parsed);
    return true;
  };

  return (
    <input
      className={`ss-edit-panel__num${invalid ? ' ss-edit-panel__num--invalid' : ''}`}
      inputMode="text"
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
      spellCheck={false}
      aria-label="Gap"
      aria-invalid={invalid}
      title={invalid ? 'Use a valid value or unit (e.g. 8, 10rem, 50%)' : undefined}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (invalid) setInvalid(false);
      }}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        if (!commit()) {
          setText(display);
          setInvalid(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && commit()) e.currentTarget.blur();
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          // Same path as the −/＋ buttons; Shift ×10, Alt fine (÷10 on unit
          // values — the Tailwind scale stays on whole steps).
          const fine = value?.kind === 'arbitrary' ? 0.1 : 1;
          onStep(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 10 : e.altKey ? fine : 1);
        }
      }}
    />
  );
}

interface Props {
  currentClass: string;
  layer: LayerContext;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onReset: (spec: ResetSpec) => void;
  onStepGap: (dir: 1 | -1, step?: number) => void;
}

export function GapControl({ currentClass, layer, onApplyEnum, onReset, onStepGap }: Props) {
  const gap = readLayer(currentClass, layer, (s) => spacingValue(s, 'gap'));
  return (
    <div className="ss-edit-panel__control">
      <ResettableLabel
        label="Gap"
        definedAt={gap.definedAt}
        active={layer.bp}
        onReset={() => onReset(spacingResetSpec('gap', 'gap'))}
      />
      <div className="ss-edit-panel__stepper">
        <Button
          size="sm"
          variant="secondary"
          aria-label="Decrease gap"
          onClick={() => onStepGap(-1)}
        >
          −
        </Button>
        <GapField
          value={gap.value}
          onSet={(v) => onApplyEnum(spacingTokenFor('gap', v), { gap: spacingCss(v) })}
          onStep={onStepGap}
        />
        <Button
          size="sm"
          variant="secondary"
          aria-label="Increase gap"
          onClick={() => onStepGap(1)}
        >
          ＋
        </Button>
      </div>
    </div>
  );
}
