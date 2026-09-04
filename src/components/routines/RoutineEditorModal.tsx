/**
 * Create or edit a routine.
 *
 * Two steps for a new routine (pick a starting point, then fill it in) and one
 * for an existing one. Saving writes the markdown file — this form and the
 * agent-authored path (see the bundled `shipstudio-routines` skill) produce
 * exactly the same artifact, which is why the editor shows the frontmatter
 * phrase for the trigger and the literal command a run executes.
 *
 * @module components/routines/RoutineEditorModal
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
import { RoutineTemplatePicker } from './RoutineTemplatePicker';
import {
  buildCommandPreview,
  describeTriggerReality,
  formatTrigger,
  triggerPhrase,
  type Routine,
  type RoutineDraft,
  type RoutinePermission,
  type RoutineTemplate,
  type RoutineTrigger,
  type Severity,
} from '../../lib/routines';

/** A project the routine can be attached to. */
export interface RoutineProjectOption {
  name: string;
  path: string;
}

interface RoutineEditorModalProps {
  /**
   * An existing routine, or the string `'new'` to start the create flow. The
   * parent mounts this only while open and keys it by routine, so the draft
   * state below can be seeded once instead of re-synced in an effect.
   */
  routine: Routine | 'new';
  /** Projects the routine can run against. Empty while they're still loading. */
  projects: RoutineProjectOption[];
  /** Preselected project for a new routine, e.g. the workspace you're in. */
  defaultProjectPath?: string | null;
  onClose: () => void;
  onSave: (projectPath: string, slug: string | null, draft: RoutineDraft) => Promise<void>;
  onDelete?: (routine: Routine) => Promise<void>;
}

type TriggerPreset = 'manual' | '15m' | '30m' | '1h' | 'daily' | 'weekly' | 'push' | 'pr-opened';

const TRIGGER_PRESETS: Record<TriggerPreset, RoutineTrigger> = {
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
 * you press it, it repeats, or something in your workflow sets it off. The
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

function presetFor(trigger: RoutineTrigger): TriggerPreset {
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

/** `null` means "use whatever agent is set as the default". */
const DEFAULT_AGENT = '__default__';

const AGENT_OPTIONS = [
  { value: DEFAULT_AGENT, label: 'Default', glyph: <GenericAgentIcon size={12} /> },
  { value: 'claude-code', label: 'Claude Code', glyph: <ClaudeIcon size={12} /> },
  { value: 'codex', label: 'Codex', glyph: <CodexIcon size={12} /> },
];

interface Draft {
  name: string;
  description: string;
  agentId: string;
  projectPath: string;
  trigger: TriggerPreset;
  permission: RoutinePermission;
  prompt: string;
  severityFloor: Severity;
  notify: boolean;
  autoRun: boolean;
}

function draftFrom(routine: Routine): Draft {
  return {
    name: routine.name,
    description: routine.description,
    agentId: routine.agentId ?? DEFAULT_AGENT,
    projectPath: routine.projectPath,
    trigger: presetFor(routine.trigger),
    permission: routine.permission,
    prompt: routine.prompt,
    severityFloor: routine.severityFloor,
    notify: routine.notify,
    autoRun: routine.autoRun,
  };
}

function blankDraft(projectPath: string): Draft {
  return {
    name: '',
    description: '',
    agentId: DEFAULT_AGENT,
    projectPath,
    // Manual is the default. Putting a routine on a timer is a deliberate,
    // separate decision with a cost attached — it spends the user's own
    // agent subscription every time it fires.
    trigger: 'manual',
    permission: 'read-only',
    prompt: '',
    severityFloor: 'info',
    notify: false,
    autoRun: true,
  };
}

export function RoutineEditorModal({
  routine,
  projects,
  defaultProjectPath,
  onClose,
  onSave,
  onDelete,
}: RoutineEditorModalProps) {
  const isNew = routine === 'new';
  const initialProject =
    (isNew ? (defaultProjectPath ?? projects[0]?.path) : routine.projectPath) ?? '';

  const [step, setStep] = useState<'template' | 'form'>(isNew ? 'template' : 'form');
  const [template, setTemplate] = useState<RoutineTemplate | null>(null);
  const [draft, setDraft] = useState<Draft>(() =>
    isNew ? blankDraft(initialProject) : draftFrom(routine)
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  const selectTemplate = (next: RoutineTemplate) => {
    const isBlank = next.id === 'tpl-blank';
    setTemplate(next);
    setDraft({
      ...blankDraft(draft.projectPath),
      name: isBlank ? '' : next.name,
      description: isBlank ? '' : next.description,
      trigger: presetFor(next.trigger),
      permission: next.permission,
      prompt: next.prompt,
    });
  };

  /**
   * Templates ship angle-bracket blanks (`<competitor 1>`). Creating a routine
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
      await onSave(draft.projectPath, isNew ? null : routine.slug, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        agentId,
        trigger,
        permission: draft.permission,
        prompt: draft.prompt,
        severityFloor: draft.severityFloor,
        notify: draft.notify,
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
        title="New routine"
        className="routine-editor-modal routine-template-modal"
      >
        <RoutineTemplatePicker selectedId={template?.id ?? null} onSelect={selectTemplate} />

        <div className="routine-editor-actions">
          <span className="routine-editor-step text-style-hint">Step 1 of 2</span>
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

  const projectLabel =
    projects.find((project) => project.path === draft.projectPath)?.name ??
    (hasProject ? draft.projectPath : 'Pick a project');

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title={isNew ? 'New routine' : draft.name || 'Routine'}
      className="routine-editor-modal"
    >
      <div className="routine-editor">
        {/* What it does — the instruction is the routine. Everything below it
            is configuration with a sensible default. */}
        <section className="routine-section">
          <h4 className="routine-section-title">What it does</h4>

          <label className="routine-field">
            <span className="routine-field-label text-style-label">Name</span>
            <TextField
              value={draft.name}
              placeholder="Security sweep"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>

          <label className="routine-field">
            <span className="routine-field-label text-style-label">Instructions</span>
            <textarea
              className="routine-prompt"
              rows={7}
              value={draft.prompt}
              spellCheck={false}
              placeholder="Tell the agent what to look for, and what not to bother you about."
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
            {placeholders.length > 0 ? (
              <span className="routine-field-warning">
                Replace{' '}
                {placeholders.slice(0, 3).map((token, index) => (
                  <span key={token}>
                    {index > 0 && ', '}
                    <code>{token}</code>
                  </span>
                ))}
                {placeholders.length > 3 && ` and ${placeholders.length - 3} more`} before this
                routine will be any use.
              </span>
            ) : (
              <span className="routine-field-hint">
                Ship Studio prepends what changed since the last run, the findings this routine
                already filed, and how to report new ones. Everything else is yours.
              </span>
            )}
          </label>
        </section>

        {/* How it runs — configuration, deliberately secondary. */}
        <section className="routine-section routine-section--config">
          <h4 className="routine-section-title">How it runs</h4>

          <div className="routine-field-pair">
            <div className="routine-field">
              <span className="routine-field-label text-style-label">Runs against</span>
              <Dropdown
                trigger={(props) => (
                  <MenuButton
                    variant="secondary"
                    width="fill"
                    className="routine-scope-trigger"
                    expanded={props['aria-expanded']}
                    {...props}
                  >
                    <span className="routine-scope-label">{projectLabel}</span>
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
                {projects.map((project) => (
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

            <div className="routine-field">
              <span className="routine-field-label text-style-label">Agent</span>
              <SegmentedControl
                aria-label="Agent"
                size="default"
                className="routine-segments-fill"
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

          <div className="routine-field">
            <span className="routine-field-label text-style-label">When it runs</span>
            <SegmentedControl
              aria-label="When it runs"
              size="default"
              className="routine-segments-fill"
              value={triggerShape}
              onValueChange={selectShape}
              options={[
                { value: 'manual', label: 'When I press Run' },
                { value: 'repeating', label: 'On a schedule' },
                { value: 'event', label: 'On an event' },
              ]}
            />

            <div className="routine-trigger-detail">
              {triggerShape === 'repeating' && (
                <SegmentedControl
                  aria-label="How often"
                  size="default"
                  className="routine-segments-fill"
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
                  className="routine-segments-fill"
                  value={draft.trigger}
                  onValueChange={(value) => setDraft({ ...draft, trigger: value })}
                  options={[
                    { value: 'push', label: 'After a push' },
                    { value: 'pr-opened', label: 'When a PR opens' },
                  ]}
                />
              )}

              <div className="routine-note">
                <InfoIcon size={12} />
                <span className="routine-note-text">
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
                      Leave it off to keep the routine on the list and run it by hand. You can flip
                      this from the row without opening the editor.
                    </span>
                  </span>
                </label>
              )}
            </div>
          </div>

          <div className="routine-field">
            <span className="routine-field-label text-style-label">Permission</span>
            <SegmentedControl
              aria-label="Permission"
              size="default"
              className="routine-segments-fill"
              value={draft.permission}
              onValueChange={(value) => setDraft({ ...draft, permission: value })}
              options={[
                { value: 'read-only', label: 'Read-only' },
                { value: 'can-edit', label: 'Can edit files' },
              ]}
            />
            <span className="routine-field-hint">
              {draft.permission === 'read-only'
                ? 'Enforced by the agent itself — Claude Code runs in plan mode, Codex in a read-only sandbox. It reads the repository and reports; it cannot change anything.'
                : 'The agent may edit files unattended. Every change lands in git, but nobody is watching it happen.'}
            </span>
          </div>

          <div className="routine-command">
            <div className="routine-command-header">
              <TerminalIcon size={12} />
              <span className="text-style-label">What actually runs</span>
            </div>
            <pre className="routine-command-body">{commandPreview}</pre>
            <p className="routine-command-note text-style-hint">
              Saved as <code>.shipstudio/routines/</code> in the project, with{' '}
              <code>trigger: {triggerPhrase(trigger)}</code>. Your agent can read and write these
              files too — ask it to make you one.
            </p>
          </div>
        </section>

        {saveError && <p className="routine-field-warning">{saveError}</p>}
      </div>

      <div className="routine-editor-actions">
        {isNew ? (
          <Button
            variant="ghost"
            className="routine-editor-back"
            onClick={() => setStep('template')}
          >
            Back
          </Button>
        ) : (
          onDelete && (
            <Button
              variant="ghost"
              className="routine-editor-back"
              leftIcon={<TrashIcon size={12} />}
              onClick={() => void onDelete(routine)}
            >
              Delete
            </Button>
          )
        )}
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canSave} onClick={() => void commit()}>
          {saving ? 'Saving…' : isNew ? 'Create routine' : 'Save changes'}
        </Button>
      </div>
    </ModalFrame>
  );
}
