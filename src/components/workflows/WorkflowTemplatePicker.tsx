/**
 * Starting points for a new workflow.
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
 * how `.workflow-row-meta` renders the same two facts in the list.
 *
 * A template is just a prefilled workflow file; see `WORKFLOW_TEMPLATES` in
 * `lib/workflows`.
 *
 * @module components/workflows/WorkflowTemplatePicker
 */

import { CheckIcon } from '@/components/icons';
import { formatTrigger, WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../../lib/workflows';

interface WorkflowTemplatePickerProps {
  selectedId: string | null;
  onSelect: (template: WorkflowTemplate) => void;
}

const CATEGORY_ORDER: WorkflowTemplate['category'][] = [
  'Security',
  'Quality',
  'Maintenance',
  'Research',
];

/** Blank last: it's the escape hatch, not the recommendation. */
function orderedTemplates(): WorkflowTemplate[] {
  const rank = (template: WorkflowTemplate) => {
    const index = CATEGORY_ORDER.indexOf(template.category);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };
  const blanks = WORKFLOW_TEMPLATES.filter((template) => template.id === 'tpl-blank');
  const rest = WORKFLOW_TEMPLATES.filter((template) => template.id !== 'tpl-blank');
  return [...rest.sort((a, b) => rank(a) - rank(b)), ...blanks];
}

export function WorkflowTemplatePicker({ selectedId, onSelect }: WorkflowTemplatePickerProps) {
  const templates = orderedTemplates();

  return (
    <div className="workflow-templates">
      <p className="workflow-templates-lede">
        Pick a starting point. Each one is a plain markdown file you can rewrite afterwards — the
        template only decides what it says on day one.
      </p>

      <div className="workflow-template-list" role="radiogroup" aria-label="Starting point">
        {templates.map((template) => {
          const isBlank = template.id === 'tpl-blank';
          const selected = selectedId === template.id;
          return (
            <button
              key={template.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`workflow-template-option${selected ? ' is-selected' : ''}`}
              onClick={() => onSelect(template)}
            >
              <span className="workflow-template-option-head">
                <span className="workflow-template-option-name">
                  {isBlank ? 'Blank workflow' : template.name}
                </span>
                {selected && (
                  <CheckIcon size={12} className="workflow-template-option-check" aria-hidden />
                )}
                <span className="workflow-template-option-tags">
                  {!isBlank && (
                    <>
                      <span>{template.category}</span>
                      <span className="workflow-template-tag-sep" aria-hidden>
                        ·
                      </span>
                    </>
                  )}
                  <span>{formatTrigger(template.trigger)}</span>
                </span>
              </span>
              <span className="workflow-template-option-description">
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
