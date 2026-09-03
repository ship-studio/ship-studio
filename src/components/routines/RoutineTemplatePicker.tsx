/**
 * Starting points for a new routine.
 *
 * Uses the same picker vocabulary as Create Project — grouped `TemplateCard`s
 * with a selected state and an explicit Continue — rather than a parallel
 * invention. Selecting does not advance: you can compare, and the card you
 * chose is still visible when you press Continue.
 *
 * A template is just a prefilled routine file; see `ROUTINE_TEMPLATES` in
 * `lib/routines`.
 *
 * @module components/routines/RoutineTemplatePicker
 */

import { TemplateCard } from '../dashboard/TemplateCard';
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

export function RoutineTemplatePicker({ selectedId, onSelect }: RoutineTemplatePickerProps) {
  const blank = ROUTINE_TEMPLATES.find((template) => template.id === 'tpl-blank');
  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    templates: ROUTINE_TEMPLATES.filter(
      (template) => template.category === category && template.id !== 'tpl-blank'
    ),
  })).filter((group) => group.templates.length > 0);

  return (
    <div className="routine-templates">
      <p className="routine-templates-lede">
        Pick a starting point. Each one is a plain markdown file you can rewrite afterwards — the
        template only decides what it says on day one.
      </p>

      {grouped.map((group) => (
        <div key={group.category} className="stack-group">
          <h3 className="stack-group-title">{group.category}</h3>
          <div className="stack-grid routine-template-grid">
            {group.templates.map((template) => (
              <TemplateCard
                key={template.id}
                name={template.name}
                description={template.description}
                meta={formatTrigger(template.trigger)}
                selected={selectedId === template.id}
                onSelect={() => onSelect(template)}
              />
            ))}
          </div>
        </div>
      ))}

      {blank && (
        <div className="stack-group">
          <h3 className="stack-group-title">From scratch</h3>
          <div className="stack-grid routine-template-grid">
            <TemplateCard
              name="Blank routine"
              description="An empty prompt. Write the instruction yourself."
              meta={formatTrigger(blank.trigger)}
              selected={selectedId === blank.id}
              onSelect={() => onSelect(blank)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
