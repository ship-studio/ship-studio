import { colorSwatch } from '../../lib/cssProperties';
import { resolveColorVariable, type ColorVariableDefinition } from '../../lib/colorContrast';

/** Keep a usable draft for the picker, falling back without committing invalid text. */
export function colorPickerDraftOrFallback(
  draft: string,
  fallback: string,
  variables?: readonly ColorVariableDefinition[],
  selector?: string
): string {
  const importantSuffix = /\s*!\s*important\s*$/i.exec(draft)?.[0] ?? '';
  const candidate = importantSuffix ? draft.slice(0, -importantSuffix.length).trim() : draft;
  const resolved = resolveColorVariable(candidate, variables ?? [], selector) ?? candidate;
  return colorSwatch(resolved) ? draft : fallback;
}
