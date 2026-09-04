/**
 * Starting points for a new routine.
 *
 * A flat, single-column option list rather than Create Project's `stack-grid`.
 * That grid is three-up and earns its shape from a dozen framework tiles; here
 * there are seven options spread over four categories, so a grid left an empty
 * cell beside every single-template category. A list has no empty cells at any
 * count, and it lets the cadence and category sit on the same line as the name
 * instead of stacking into a tall card.
 *
 * Selection follows the app's list convention (`.inbox-item.is-selected`):
 * a filled surface and the ordinary border, plus an inline check against the
 * name. There is deliberately no floating badge — the corner disc in
 * `stack-card` is sized for a short tile and strands itself in a tall one —
 * and no accent ring, which outshouted every other border on the screen.
 * The trailing category and cadence are muted text with a middot, matching
 * how `.routine-row-meta` renders the same two facts in the list.
 *
 * A template is just a prefilled routine file; see `ROUTINE_TEMPLATES` in
 * `lib/routines`.
 *
 * @module components/routines/RoutineTemplatePicker
 */

import { CheckIcon } from '@/components/icons';
import { formatTrigger, ROUTINE_TEMPLATES, type RoutineTemplate } from '../../lib/routines';

interface RoutineTemplatePickerProps {
  selectedId: string | null;
  onSelect: (template: RoutineTemplate) => void;
}

const CATEGORY_ORDER: RoutineTemplate['category'][] = [
  'Security',
  'Quality',
  'Maintenance',
  'Research',
];

/** Blank last: it's the escape hatch, not the recommendation. */
function orderedTemplates(): RoutineTemplate[] {
  const rank = (template: RoutineTemplate) => {
    const index = CATEGORY_ORDER.indexOf(template.category);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };
  const blanks = ROUTINE_TEMPLATES.filter((template) => template.id === 'tpl-blank');
  const rest = ROUTINE_TEMPLATES.filter((template) => template.id !== 'tpl-blank');
  return [...rest.sort((a, b) => rank(a) - rank(b)), ...blanks];
}

export function RoutineTemplatePicker({ selectedId, onSelect }: RoutineTemplatePickerProps) {
  const templates = orderedTemplates();

  return (
    <div className="routine-templates">
      <p className="routine-templates-lede">
        Pick a starting point. Each one is a plain markdown file you can rewrite afterwards — the
        template only decides what it says on day one.
      </p>

      <div className="routine-template-list" role="radiogroup" aria-label="Starting point">
        {templates.map((template) => {
          const isBlank = template.id === 'tpl-blank';
          const selected = selectedId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`routine-template-option${selected ? ' is-selected' : ''}`}
              onClick={() => onSelect(template)}
            >
              <span className="routine-template-option-head">
                <span className="routine-template-option-name">
                  {isBlank ? 'Blank routine' : template.name}
                </span>
                {selected && (
                  <CheckIcon size={12} className="routine-template-option-check" aria-hidden />
                )}
                <span className="routine-template-option-tags">
                  {!isBlank && (
                    <>
                      <span>{template.category}</span>
                      <span className="routine-template-tag-sep" aria-hidden>
                        ·
                      </span>
                    </>
                  )}
                  <span>{formatTrigger(template.trigger)}</span>
                </span>
              </span>
              <span className="routine-template-option-description">
                {isBlank
                  ? 'An empty prompt. Write the instruction yourself.'
                  : template.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
