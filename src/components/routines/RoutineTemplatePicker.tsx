/**
 * Starter routines offered when creating a new one.
 *
 * PROTOTYPE. A template is just a prefilled routine file — see
 * `ROUTINE_TEMPLATES` in `lib/routines`.
 *
 * @module components/routines/RoutineTemplatePicker
 */

import { formatTrigger, ROUTINE_TEMPLATES, type RoutineTemplate } from '../../lib/routines';

interface RoutineTemplatePickerProps {
  onPick: (template: RoutineTemplate) => void;
}

const CATEGORY_ORDER: RoutineTemplate['category'][] = [
  'Security',
  'Quality',
  'Maintenance',
  'Research',
];

export function RoutineTemplatePicker({ onPick }: RoutineTemplatePickerProps) {
  const blank = ROUTINE_TEMPLATES.find((template) => template.id === 'tpl-blank');
  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    templates: ROUTINE_TEMPLATES.filter(
      (template) => template.category === category && template.id !== 'tpl-blank'
    ),
  })).filter((group) => group.templates.length > 0);

  return (
    <div className="routine-templates">
      <p className="routine-templates-lede text-style-body-medium">
        Start from one of these, or write your own. Every template is a plain markdown file you can
        edit afterwards.
      </p>

      {grouped.map((group) => (
        <div key={group.category} className="routine-template-group">
          <h4 className="routine-template-group-title text-style-label">{group.category}</h4>
          <div className="routine-template-grid">
            {group.templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="routine-template-card"
                onClick={() => onPick(template)}
              >
                <span className="routine-template-name text-style-control-semibold">
                  {template.name}
                </span>
                <span className="routine-template-description text-style-hint">
                  {template.description}
                </span>
                <span className="routine-template-trigger text-style-hint">
                  {formatTrigger(template.trigger)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}

      {blank && (
        <button type="button" className="routine-template-blank" onClick={() => onPick(blank)}>
          <span className="text-style-control-semibold">Start from a blank routine</span>
          <span className="text-style-hint">An empty prompt and a daily trigger.</span>
        </button>
      )}
    </div>
  );
}
