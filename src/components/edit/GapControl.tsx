/**
 * Gap control: a stepper (−/＋) around an editable field. The field accepts a
 * Tailwind scale step (a bare integer → `gap-6`) or any valid CSS length
 * (`10rem`, `50%` → `gap-[10rem]`); bad input flags the field. Reads the effective
 * value across the breakpoint cascade and writes at the active layer via the hook.
 */

import { Button } from '../primitives/Button';
import { ValueField } from '../primitives/ValueField';
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
  return (
    <ValueField
      className="ss-edit-panel__num"
      aria-label="Gap"
      variant="length"
      defaultUnit="px"
      value={spacingDisplay(value)}
      onCommit={(next) => {
        const parsed = parseSpacingInput(next, 'gap');
        if (parsed.kind === 'invalid') return false;
        onSet(parsed);
        return true;
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
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
          size="medium"
          variant="default"
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
          size="medium"
          variant="default"
          aria-label="Increase gap"
          onClick={() => onStepGap(1)}
        >
          ＋
        </Button>
      </div>
    </div>
  );
}
