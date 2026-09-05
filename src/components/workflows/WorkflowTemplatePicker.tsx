/**
 * Choosing what a new workflow should do.
 *
 * This screen carries the feature's first impression, and the question it has
 * to answer is not "which of these names do you like" but "what would I
 * actually get". A list of titles cannot answer that, so the picker is a
 * chooser and a preview: the list on the left, and on the right the one thing
 * that makes the decision — an example of the finding this template would file
 * in your Inbox, above the exact instruction it would run.
 *
 * The geometry is the Inbox's, deliberately. The first two-pane list-and-report
 * a new user sees is this one, and the second is the Inbox itself; making them
 * the same shape means the Inbox is already familiar the first time a finding
 * lands in it.
 *
 * Something is always selected, so the preview is never empty and Continue is
 * never dead. "Start from scratch" is a separate action rather than a row in
 * the list — it is the escape hatch, not a recommendation.
 *
 * @module components/workflows/WorkflowTemplatePicker
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InfoIcon, ShieldCheckIcon, TerminalIcon, ActivityIcon } from '@/components/icons';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { formatTrigger, describeTriggerReality } from '../../lib/workflows';
import {
  browsableTemplates,
  TEMPLATE_CATEGORIES,
  type WorkflowTemplate,
  type WorkflowTemplateCategory,
} from '../../lib/workflowTemplates';

interface WorkflowTemplatePickerProps {
  selectedId: string | null;
  onSelect: (template: WorkflowTemplate) => void;
}

type CategoryFilter = 'all' | WorkflowTemplateCategory;

/** Groups, in list order. "Start here" only exists in the unfiltered view. */
interface TemplateGroup {
  label: string;
  templates: WorkflowTemplate[];
}

function groupsFor(filter: CategoryFilter): TemplateGroup[] {
  const all = browsableTemplates();
  if (filter !== 'all') {
    return [{ label: filter, templates: all.filter((t) => t.category === filter) }];
  }
  // Starters first: a first-time user needs three good answers, not twenty
  // equal ones. They stay in their category groups too — this is a shortcut
  // through the list, not a separate shelf.
  return [
    { label: 'Start here', templates: all.filter((t) => t.starter) },
    ...TEMPLATE_CATEGORIES.map((category) => ({
      label: category,
      templates: all.filter((t) => t.category === category && !t.starter),
    })),
  ].filter((group) => group.templates.length > 0);
}

export function WorkflowTemplatePicker({ selectedId, onSelect }: WorkflowTemplatePickerProps) {
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const listRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo(() => groupsFor(filter), [filter]);
  const flat = useMemo(() => groups.flatMap((group) => group.templates), [groups]);
  const selected = flat.find((template) => template.id === selectedId) ?? flat[0] ?? null;

  // Filtering can hide the selection. The pane then falls back to the first
  // visible template while the parent still holds the hidden one — so the
  // button would create something other than what is on screen.
  useEffect(() => {
    if (selected && selected.id !== selectedId) onSelect(selected);
  }, [selected, selectedId, onSelect]);

  const move = useCallback(
    (delta: number) => {
      if (!selected) return;
      const index = flat.findIndex((template) => template.id === selected.id);
      const next = flat[Math.min(flat.length - 1, Math.max(0, index + delta))];
      if (!next) return;
      onSelect(next);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-template-id="${CSS.escape(next.id)}"]`)
        ?.focus();
    },
    [flat, selected, onSelect]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    },
    [move]
  );

  return (
    <div className="workflow-templates">
      <div className="workflow-templates-head">
        <div className="workflow-templates-intro">
          <p className="workflow-templates-lede">
            A workflow is a standing instruction. Ship Studio runs it with the agent CLI you already
            have, inside your project, and files whatever it finds in your Inbox.
          </p>
          {/* The other way in. Most people will never open this modal a second
              time — they will just tell their agent what they want watched. */}
          <p className="workflow-templates-aside text-style-hint">
            You can also just ask your agent for one — it knows how to write these.
          </p>
        </div>
        <SegmentedControl
          aria-label="Filter templates"
          size="compact"
          className="workflow-templates-filter"
          value={filter}
          onValueChange={(value) => setFilter(value as CategoryFilter)}
          options={[
            { value: 'all', label: 'All' },
            ...TEMPLATE_CATEGORIES.map((category) => ({ value: category, label: category })),
          ]}
        />
      </div>

      <div className="workflow-templates-body">
        <div
          className="workflow-template-list"
          role="listbox"
          aria-label="Templates"
          aria-activedescendant={selected ? `template-${selected.id}` : undefined}
          ref={listRef}
          onKeyDown={handleKeyDown}
        >
          {groups.map((group) => (
            <div key={group.label} className="workflow-template-group">
              {/* Filtered to one category, the heading only repeats the chip
                  that is already lit above the list. */}
              {filter === 'all' && (
                <span className="workflow-template-group-label">{group.label}</span>
              )}
              {group.templates.map((template) => (
                <button
                  key={template.id}
                  id={`template-${template.id}`}
                  data-template-id={template.id}
                  type="button"
                  role="option"
                  aria-selected={template.id === selected?.id}
                  tabIndex={template.id === selected?.id ? 0 : -1}
                  className={`workflow-template-option${
                    template.id === selected?.id ? ' is-selected' : ''
                  }`}
                  onClick={() => onSelect(template)}
                >
                  <span className="workflow-template-option-icon" aria-hidden>
                    {template.icon}
                  </span>
                  <span className="workflow-template-option-text">
                    <span className="workflow-template-option-name">{template.name}</span>
                    <span className="workflow-template-option-description">
                      {template.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        {selected && <TemplatePreview template={selected} />}
      </div>
    </div>
  );
}

/**
 * What you would get, before you commit to anything.
 *
 * The example finding is the load-bearing part. A description tells you what a
 * workflow looks at; only an example tells you what comes back, and "what
 * comes back" is the thing worth deciding about.
 */
function TemplatePreview({ template }: { template: WorkflowTemplate }) {
  return (
    <div className="workflow-template-preview">
      {/* The scrolling half. Everything that varies in length lives here so
          the guarantees below it cannot be pushed off the bottom. */}
      <div className="workflow-template-preview-scroll">
        <div className="workflow-template-preview-head">
          <span className="workflow-template-preview-icon" aria-hidden>
            {template.icon}
          </span>
          <div className="workflow-template-preview-title">
            <h4 className="workflow-template-preview-name">{template.name}</h4>
            <span className="workflow-template-preview-meta">
              <span>{template.category}</span>
              <span aria-hidden>·</span>
              <span>{formatTrigger(template.trigger)}</span>
            </span>
          </div>
        </div>

        {/* The row beside this already says what the workflow is for; repeating
            that in bigger type teaches nothing. This says how it decides what is
            worth telling you. */}
        <p className="workflow-template-preview-description">
          {template.detail ?? template.description}
        </p>

        {template.requires && (
          <p className="workflow-template-requires">
            <InfoIcon size={12} />
            <span>Needs {template.requires}.</span>
          </p>
        )}

        {template.example && (
          <section className="workflow-template-section">
            <span className="workflow-template-section-label text-style-label">
              What lands in your Inbox
            </span>
            {/* Built to look like the real thing, because it is the real thing's
                shape — severity, one-line summary, the file it points at. */}
            <div className="workflow-template-example">
              <span
                className="workflow-template-example-severity"
                data-severity={template.example.severity}
                aria-hidden
              />
              <div className="workflow-template-example-body">
                <span className="workflow-template-example-title">{template.example.title}</span>
                <span className="workflow-template-example-summary">
                  {template.example.summary}
                </span>
                {template.example.location && (
                  <code className="workflow-template-example-location">
                    {template.example.location}
                  </code>
                )}
              </div>
            </div>
            <span className="workflow-template-example-note text-style-hint">
              An example, not a real finding — yours will come from your own code.
            </span>
          </section>
        )}

        <section className="workflow-template-section">
          <span className="workflow-template-section-label text-style-label">
            What it tells the agent
          </span>
          <pre className="workflow-template-prompt">{template.prompt}</pre>
          <span className="workflow-template-prompt-note text-style-hint">
            Yours to edit on the next step, and any time after.
          </span>
        </section>
      </div>

      {/* Outside the scroller on purpose: these three are true of every
          template and one of them is the honest limit of what a schedule
          promises. A guarantee you have to scroll to find is not one. */}
      <div className="workflow-template-facts">
        <span className="workflow-template-fact">
          <ShieldCheckIcon size={12} />
          Read-only — enforced by the agent CLI, not just asked for
        </span>
        <span className="workflow-template-fact">
          <TerminalIcon size={12} />
          Runs your own agent on the plan you already pay for
        </span>
        <span className="workflow-template-fact">
          <ActivityIcon size={12} />
          {describeTriggerReality(template.trigger)}
        </span>
      </div>
    </div>
  );
}
