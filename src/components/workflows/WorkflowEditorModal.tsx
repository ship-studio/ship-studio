/**
 * Create or edit a workflow.
 *
 * Two steps for a new workflow (pick a starting point, then fill it in) and one
 * for an existing one. Saving writes the markdown file — this form and the
 * agent-authored path (see the bundled `shipstudio-workflows` skill) produce
 * exactly the same artifact, which is why the editor shows the frontmatter
 * phrase for the trigger and the literal command a run executes.
 *
 * @module components/workflows/WorkflowEditorModal
 */

import { useMemo, useState } from 'react';
import {
  ChevronIcon,
  ClaudeIcon,
  CodexIcon,
  GenericAgentIcon,
  InfoIcon,
  TerminalIcon,
  TrashIcon,
} from '@/components/icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { MenuButton } from '../primitives/MenuButton';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { TextField } from '../primitives/TextField';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { WorkflowTemplatePicker } from './WorkflowTemplatePicker';
import { WorkflowIconPicker } from './WorkflowIconPicker';
import {
  buildCommandPreview,
  describeTriggerReality,
  formatTrigger,
  triggerPhrase,
  type Workflow,
  type WorkflowDraft,
  type WorkflowPermission,
  type WorkflowTemplate,
  type WorkflowTrigger,
  type Severity,
} from '../../lib/workflows';

/** A project the workflow can be attached to. */
export interface WorkflowProjectOption {
  name: string;
  path: string;
}

interface WorkflowEditorModalProps {
  /**
   * An existing workflow, or the string `'new'` to start the create flow. The
   * parent mounts this only while open and keys it by workflow, so the draft
   * state below can be seeded once instead of re-synced in an effect.
   */
  workflow: Workflow | 'new';
  /** Projects the workflow can run against. Empty while they're still loading. */
  projects: WorkflowProjectOption[];
  /** Preselected project for a new workflow, e.g. the workspace you're in. */
  defaultProjectPath?: string | null;
  onClose: () => void;
  onSave: (projectPath: string, slug: string | null, draft: WorkflowDraft) => Promise<void>;
  onDelete?: (workflow: Workflow) => Promise<void>;
}

type TriggerPreset = 'manual' | '15m' | '30m' | '1h' | 'daily' | 'weekly' | 'push' | 'pr-opened';

const TRIGGER_PRESETS: Record<TriggerPreset, WorkflowTrigger> = {
  manual: { kind: 'manual' },
  '15m': { kind: 'interval', everyMinutes: 15 },
  '30m': { kind: 'interval', everyMinutes: 30 },
  '1h': { kind: 'interval', everyMinutes: 60 },
  daily: { kind: 'daily', atHour: 10, atMinute: 0 },
  weekly: { kind: 'weekly', weekday: 1, atHour: 10, atMinute: 0 },
  push: { kind: 'event', event: 'push' },
  'pr-opened': { kind: 'event', event: 'pr-opened' },
};

/**
 * The coarse choice, which is the one that actually changes the mental model:
 * you press it, it repeats, or something you do in the repo sets it off. The
 * specific cadence is a detail *within* a shape, so it gets its own control —
 * eight peer segments in one rail read as eight equally-weighted decisions and
 * crammed to the point of illegibility.
 */
type TriggerShape = 'manual' | 'repeating' | 'event';

const EVENT_PRESETS: readonly TriggerPreset[] = ['push', 'pr-opened'];
const DEFAULT_REPEATING: TriggerPreset = '30m';
const DEFAULT_EVENT: TriggerPreset = 'push';

function shapeFor(preset: TriggerPreset): TriggerShape {
  if (preset === 'manual') return 'manual';
  return EVENT_PRESETS.includes(preset) ? 'event' : 'repeating';
}

function presetFor(trigger: WorkflowTrigger): TriggerPreset {
  switch (trigger.kind) {
    case 'manual':
      return 'manual';
    case 'event':
      return trigger.event === 'pr-opened' ? 'pr-opened' : 'push';
    case 'daily':
      return 'daily';
    case 'weekly':
      return 'weekly';
    case 'interval':
      if (trigger.everyMinutes <= 15) return '15m';
      return trigger.everyMinutes <= 30 ? '30m' : '1h';
  }
}

/** Above this many options a dropdown gets a filter field instead of a scroll. */
const SEARCH_THRESHOLD = 8;

/** `null` means "use whatever agent is set as the default". */
const DEFAULT_AGENT = '__default__';

const AGENT_OPTIONS = [
  { value: DEFAULT_AGENT, label: 'Default', glyph: <GenericAgentIcon size={12} /> },
  { value: 'claude-code', label: 'Claude Code', glyph: <ClaudeIcon size={12} /> },
  { value: 'codex', label: 'Codex', glyph: <CodexIcon size={12} /> },
];

interface Draft {
  name: string;
  icon: string | null;
  description: string;
  agentId: string;
  projectPath: string;
  trigger: TriggerPreset;
  permission: WorkflowPermission;
  prompt: string;
  severityFloor: Severity;
  autoRun: boolean;
}

function draftFrom(workflow: Workflow): Draft {
  return {
    name: workflow.name,
    icon: workflow.icon,
    description: workflow.description,
    agentId: workflow.agentId ?? DEFAULT_AGENT,
    projectPath: workflow.projectPath,
    trigger: presetFor(workflow.trigger),
    permission: workflow.permission,
    prompt: workflow.prompt,
    severityFloor: workflow.severityFloor,
    autoRun: workflow.autoRun,
  };
}

function blankDraft(projectPath: string): Draft {
  return {
    name: '',
    icon: null,
    description: '',
    agentId: DEFAULT_AGENT,
    projectPath,
    // Manual is the default. Putting a workflow on a timer is a deliberate,
    // separate decision with a cost attached — it spends the user's own
    // agent subscription every time it fires.
    trigger: 'manual',
    permission: 'read-only',
    prompt: '',
    severityFloor: 'info',
    autoRun: true,
  };
}

export function WorkflowEditorModal({
  workflow,
  projects,
  defaultProjectPath,
  onClose,
  onSave,
  onDelete,
}: WorkflowEditorModalProps) {
  const isNew = workflow === 'new';
  const initialProject =
    (isNew ? (defaultProjectPath ?? projects[0]?.path) : workflow.projectPath) ?? '';

  const [step, setStep] = useState<'template' | 'form'>(isNew ? 'template' : 'form');
  const [template, setTemplate] = useState<WorkflowTemplate | null>(null);
  const [draft, setDraft] = useState<Draft>(() =>
    isNew ? blankDraft(initialProject) : draftFrom(workflow)
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [projectQuery, setProjectQuery] = useState('');

  const trigger = TRIGGER_PRESETS[draft.trigger];
  const triggerShape = shapeFor(draft.trigger);
  const canAutoRun = trigger.kind !== 'manual';

  /** Switching shape keeps the current preset when it already fits. */
  const selectShape = (next: TriggerShape) => {
    if (next === shapeFor(draft.trigger)) return;
    const preset: TriggerPreset =
      next === 'manual' ? 'manual' : next === 'event' ? DEFAULT_EVENT : DEFAULT_REPEATING;
    setDraft({ ...draft, trigger: preset });
  };

  const agentId = draft.agentId === DEFAULT_AGENT ? null : draft.agentId;

  const commandPreview = useMemo(
    () => buildCommandPreview({ agentId, permission: draft.permission }),
    [agentId, draft.permission]
  );

  const selectTemplate = (next: WorkflowTemplate) => {
    const isBlank = next.id === 'tpl-blank';
    setTemplate(next);
    setDraft({
      ...blankDraft(draft.projectPath),
      name: isBlank ? '' : next.name,
      icon: isBlank ? null : next.icon,
      description: isBlank ? '' : next.description,
      trigger: presetFor(next.trigger),
      permission: next.permission,
      prompt: next.prompt,
    });
  };

  /**
   * Templates ship angle-bracket blanks (`<competitor 1>`). Creating a workflow
   * that still contains them produces a run that does nothing useful, so the
   * form says so instead of letting it through silently.
   */
  const placeholders = draft.prompt.match(/<[^<>\n]{2,40}>/g) ?? [];
  const promptIsEmpty = draft.prompt.trim().length === 0;
  const nameIsEmpty = draft.name.trim().length === 0;
  const hasProject = draft.projectPath.length > 0;
  const canSave = !promptIsEmpty && !nameIsEmpty && hasProject && !saving;

  const commit = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft.projectPath, isNew ? null : workflow.slug, {
        name: draft.name.trim(),
        icon: draft.icon,
        description: draft.description.trim(),
        agentId,
        trigger,
        permission: draft.permission,
        prompt: draft.prompt,
        severityFloor: draft.severityFloor,
        autoRun: canAutoRun ? draft.autoRun : false,
      });
    } catch (err) {
      // Saving writes a file, which can genuinely fail (read-only volume, a
      // project unmounted since the list loaded). Failing silently here would
      // lose whatever the user just typed.
      setSaveError(String(err));
      setSaving(false);
    }
  };

  if (step === 'template') {
    return (
      <ModalFrame
        isOpen
        onClose={onClose}
        title="New workflow"
        className="workflow-editor-modal workflow-template-modal"
      >
        <WorkflowTemplatePicker selectedId={template?.id ?? null} onSelect={selectTemplate} />

        <div className="workflow-editor-actions">
          <span className="workflow-editor-step text-style-hint">Step 1 of 2</span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!template} onClick={() => setStep('form')}>
            Continue
          </Button>
        </div>
      </ModalFrame>
    );
  }

  // Substring, not fuzzy: project names are short and typed from memory, and a
  // fuzzy match over 160 of them surfaces more noise than it saves.
  const matchingProjects = projectQuery.trim()
    ? projects.filter((project) =>
        project.name.toLowerCase().includes(projectQuery.trim().toLowerCase())
      )
    : projects;

  const projectLabel =
    projects.find((project) => project.path === draft.projectPath)?.name ??
    (hasProject ? draft.projectPath : 'Pick a project');

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title={isNew ? 'New workflow' : draft.name || 'Workflow'}
      className="workflow-editor-modal"
    >
      <div className="workflow-editor">
        {/* What it does — the instruction is the workflow. Everything below it
            is configuration with a sensible default. */}
        <section className="workflow-section">
          <h4 className="workflow-section-title">What it does</h4>

          <div className="workflow-name-row">
            <WorkflowIconPicker
              value={draft.icon}
              name={draft.name}
              onChange={(icon) => setDraft({ ...draft, icon })}
            />
            <div className="workflow-field workflow-name-field">
              <TextField
                className="workflow-name-input"
                value={draft.name}
                placeholder="Name this workflow"
                aria-label="Workflow name"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
          </div>

          <label className="workflow-field">
            <span className="workflow-field-label text-style-label">Instructions</span>
            <textarea
              className="workflow-prompt"
              rows={7}
              value={draft.prompt}
              spellCheck={false}
              placeholder="Tell the agent what to look for, and what not to bother you about."
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
            {placeholders.length > 0 ? (
              <span className="workflow-field-warning">
                Replace{' '}
                {placeholders.slice(0, 3).map((token, index) => (
                  <span key={token}>
                    {index > 0 && ', '}
                    <code>{token}</code>
                  </span>
                ))}
                {placeholders.length > 3 && ` and ${placeholders.length - 3} more`} before this
                workflow will be any use.
              </span>
            ) : (
              <span className="workflow-field-hint">
                Ship Studio prepends what changed since the last run, the findings this workflow
                already filed, and how to report new ones. Everything else is yours.
              </span>
            )}
          </label>
        </section>

        {/* How it runs — configuration, deliberately secondary. */}
        <section className="workflow-section workflow-section--config">
          <h4 className="workflow-section-title">How it runs</h4>

          <div className="workflow-field-pair">
            <div className="workflow-field">
              <span className="workflow-field-label text-style-label">Runs against</span>
              <Dropdown
                menuClassName="workflow-project-menu"
                search={
                  projects.length > SEARCH_THRESHOLD
                    ? {
                        value: projectQuery,
                        onChange: setProjectQuery,
                        placeholder: 'Search projects…',
                      }
                    : undefined
                }
                onOpenChange={(open) => {
                  if (!open) setProjectQuery('');
                }}
                trigger={(props) => (
                  <MenuButton
                    variant="secondary"
                    width="fill"
                    className="workflow-scope-trigger"
                    expanded={props['aria-expanded']}
                    {...props}
                  >
                    <span className="workflow-scope-label">{projectLabel}</span>
                    <ChevronIcon
                      size={10}
                      className={props['aria-expanded'] ? 'chevron-flipped' : undefined}
                    />
                  </MenuButton>
                )}
              >
                {projects.length === 0 && (
                  <DropdownItem disabled onSelect={() => undefined}>
                    No projects yet
                  </DropdownItem>
                )}
                {projects.length > 0 && matchingProjects.length === 0 && (
                  <DropdownItem disabled onSelect={() => undefined}>
                    No project matches “{projectQuery}”
                  </DropdownItem>
                )}
                {matchingProjects.map((project) => (
                  <DropdownItem
                    key={project.path}
                    active={draft.projectPath === project.path}
                    onSelect={() => setDraft({ ...draft, projectPath: project.path })}
                  >
                    {project.name}
                  </DropdownItem>
                ))}
              </Dropdown>
            </div>

            <div className="workflow-field">
              <span className="workflow-field-label text-style-label">Agent</span>
              <SegmentedControl
                aria-label="Agent"
                size="default"
                className="workflow-segments-fill"
                value={draft.agentId}
                onValueChange={(value) => setDraft({ ...draft, agentId: value })}
                options={AGENT_OPTIONS.map((option) => ({
                  value: option.value,
                  ariaLabel: option.label,
                  label: (
                    <>
                      {option.glyph}
                      {option.label}
                    </>
                  ),
                }))}
              />
            </div>
          </div>

          <div className="workflow-field">
            <span className="workflow-field-label text-style-label">When it runs</span>
            <SegmentedControl
              aria-label="When it runs"
              size="default"
              className="workflow-segments-fill"
              value={triggerShape}
              onValueChange={selectShape}
              options={[
                { value: 'manual', label: 'When I press Run' },
                { value: 'repeating', label: 'On a schedule' },
                { value: 'event', label: 'On an event' },
              ]}
            />

            <div className="workflow-trigger-detail">
              {triggerShape === 'repeating' && (
                <SegmentedControl
                  aria-label="How often"
                  size="default"
                  className="workflow-segments-fill"
                  value={draft.trigger}
                  onValueChange={(value) => setDraft({ ...draft, trigger: value })}
                  options={[
                    { value: '15m', label: 'Every 15m' },
                    { value: '30m', label: 'Every 30m' },
                    { value: '1h', label: 'Hourly' },
                    { value: 'daily', label: 'Daily' },
                    { value: 'weekly', label: 'Weekly' },
                  ]}
                />
              )}

              {triggerShape === 'event' && (
                <SegmentedControl
                  aria-label="Which event"
                  size="default"
                  className="workflow-segments-fill"
                  value={draft.trigger}
                  onValueChange={(value) => setDraft({ ...draft, trigger: value })}
                  options={[
                    { value: 'push', label: 'After a push' },
                    { value: 'pr-opened', label: 'When a PR opens' },
                  ]}
                />
              )}

              <div className="workflow-note">
                <InfoIcon size={12} />
                <span className="workflow-note-text">
                  <strong>{formatTrigger(trigger)}.</strong> {describeTriggerReality(trigger)}
                </span>
              </div>

              {canAutoRun && (
                <label className="settings-form-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.autoRun}
                    onChange={(event) => setDraft({ ...draft, autoRun: event.target.checked })}
                  />
                  <span className="settings-form-checkbox-copy">
                    <span className="settings-form-checkbox-title">Arm this trigger</span>
                    <span className="settings-form-checkbox-description">
                      Leave it off to keep the workflow on the list and run it by hand. You can flip
                      this from the row without opening the editor.
                    </span>
                  </span>
                </label>
              )}
            </div>
          </div>

          <div className="workflow-field">
            <span className="workflow-field-label text-style-label">Permission</span>
            <SegmentedControl
              aria-label="Permission"
              size="default"
              className="workflow-segments-fill"
              value={draft.permission}
              onValueChange={(value) => setDraft({ ...draft, permission: value })}
              options={[
                { value: 'read-only', label: 'Read-only' },
                { value: 'can-edit', label: 'Can edit files' },
              ]}
            />
            <span className="workflow-field-hint">
              {draft.permission === 'read-only'
                ? 'Enforced by the agent itself — Claude Code runs in plan mode, Codex in a read-only sandbox. It reads the repository and reports; it cannot change anything.'
                : 'The agent may edit files unattended. Every change lands in git, but nobody is watching it happen.'}
            </span>
          </div>

          <div className="workflow-field">
            <span className="workflow-field-label text-style-label">File in my Inbox</span>
            <SegmentedControl
              aria-label="Severity floor"
              size="default"
              className="workflow-segments-fill"
              value={draft.severityFloor}
              onValueChange={(value) => setDraft({ ...draft, severityFloor: value })}
              options={[
                { value: 'info', label: 'Everything' },
                { value: 'warning', label: 'Warnings and up' },
                { value: 'critical', label: 'Critical only' },
              ]}
            />
            <span className="workflow-field-hint">
              {draft.severityFloor === 'info'
                ? 'Every finding is filed. Start here, and raise the floor if this workflow turns out to be chatty.'
                : draft.severityFloor === 'warning'
                  ? 'Findings the agent rates as informational are dropped rather than filed.'
                  : 'Only critical findings reach your Inbox. Everything else is dropped, not held back.'}
            </span>
          </div>

          <div className="workflow-command">
            <div className="workflow-command-header">
              <TerminalIcon size={12} />
              <span className="text-style-label">What actually runs</span>
            </div>
            <pre className="workflow-command-body">{commandPreview}</pre>
            <p className="workflow-command-note text-style-hint">
              Saved as <code>.shipstudio/workflows/</code> in the project, with{' '}
              <code>trigger: {triggerPhrase(trigger)}</code>. Your agent can read and write these
              files too — ask it to make you one.
            </p>
          </div>
        </section>

        {saveError && <p className="workflow-field-warning">{saveError}</p>}
      </div>

      <div className="workflow-editor-actions">
        {isNew ? (
          <Button
            variant="ghost"
            className="workflow-editor-back"
            onClick={() => setStep('template')}
          >
            Back
          </Button>
        ) : (
          onDelete && (
            <Button
              variant="ghost"
              className="workflow-editor-back"
              leftIcon={<TrashIcon size={12} />}
              onClick={() => void onDelete(workflow)}
            >
              Delete
            </Button>
          )
        )}
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canSave} onClick={() => void commit()}>
          {saving ? 'Saving…' : isNew ? 'Create workflow' : 'Save changes'}
        </Button>
      </div>
    </ModalFrame>
  );
}
