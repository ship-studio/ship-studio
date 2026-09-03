/**
 * Create or edit a routine.
 *
 * PROTOTYPE. The command preview is real (it's the string a run would execute);
 * everything else writes to the in-memory store only.
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
  type Routine,
  supportsBackground,
  type RoutineHost,
  type RoutinePermission,
  type RoutineTemplate,
  type RoutineTrigger,
  type Severity,
} from '../../lib/routines';

interface RoutineEditorModalProps {
  /**
   * An existing routine, or the string `'new'` to start the create flow. The
   * parent mounts this only while open and keys it by routine, so the draft
   * state below can be seeded once instead of re-synced in an effect.
   */
  routine: Routine | 'new';
  onClose: () => void;
  onSave: (routine: Routine) => void;
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

const ALL_PROJECTS = 'all';
const PROJECTS = ['hexa-storefront', 'client-atlas', 'portfolio-v3'];

const AGENT_OPTIONS = [
  { value: 'claude-code', label: 'Claude Code', glyph: <ClaudeIcon size={12} /> },
  { value: 'codex', label: 'Codex', glyph: <CodexIcon size={12} /> },
  { value: 'opencode', label: 'Opencode', glyph: <GenericAgentIcon size={12} /> },
];

interface Draft {
  name: string;
  description: string;
  agentId: string;
  scopeProject: string;
  trigger: TriggerPreset;
  permission: RoutinePermission;
  prompt: string;
  severityFloor: Severity;
  notify: boolean;
  autoRun: boolean;
  host: RoutineHost;
}

function draftFrom(routine: Routine): Draft {
  return {
    name: routine.name,
    description: routine.description,
    agentId: routine.agentId,
    scopeProject:
      routine.scope.kind === 'all-projects'
        ? ALL_PROJECTS
        : (routine.scope.projectName ?? PROJECTS[0]),
    trigger: presetFor(routine.trigger),
    permission: routine.permission,
    prompt: routine.prompt,
    severityFloor: routine.severityFloor,
    notify: routine.notify,
    autoRun: routine.autoRun,
    host: routine.host,
  };
}

const BLANK: Draft = {
  name: '',
  description: '',
  agentId: 'claude-code',
  scopeProject: PROJECTS[0],
  // Manual is the default. Putting a routine on a timer is a deliberate,
  // separate decision with a cost attached.
  trigger: 'manual',
  permission: 'read-only',
  prompt: '',
  severityFloor: 'warning',
  notify: false,
  autoRun: true,
  host: 'app',
};

export function RoutineEditorModal({ routine, onClose, onSave }: RoutineEditorModalProps) {
  const isNew = routine === 'new';
  const [step, setStep] = useState<'template' | 'form'>(isNew ? 'template' : 'form');
  const [template, setTemplate] = useState<RoutineTemplate | null>(null);
  const [draft, setDraft] = useState<Draft>(() => (isNew ? BLANK : draftFrom(routine)));

  const trigger = TRIGGER_PRESETS[draft.trigger];
  const canAutoRun = trigger.kind !== 'manual';
  const canRunInBackground = supportsBackground(trigger);
  const host: RoutineHost = canRunInBackground ? draft.host : 'app';
  // Nobody is watching a background run, so it never gets write access.
  const permission = host === 'background' ? 'read-only' : draft.permission;

  const commandPreview = useMemo(
    () => buildCommandPreview({ agentId: draft.agentId, permission: draft.permission }),
    [draft.agentId, draft.permission]
  );

  const selectTemplate = (next: RoutineTemplate) => {
    const isBlank = next.id === 'tpl-blank';
    setTemplate(next);
    setDraft({
      ...BLANK,
      name: isBlank ? '' : next.name,
      description: isBlank ? '' : next.description,
      scopeProject: next.scopeKind === 'all-projects' ? ALL_PROJECTS : PROJECTS[0],
      trigger: presetFor(next.trigger),
      permission: next.permission,
      prompt: next.prompt,
    });
  };

  /**
   * Templates ship angle-bracket blanks (`<competitor 1>`). Creating a routine
   * that still contains them produces an agent run that does nothing useful, so
   * the form says so instead of letting it through silently.
   */
  const placeholders = draft.prompt.match(/<[^<>\n]{2,40}>/g) ?? [];
  const promptIsEmpty = draft.prompt.trim().length === 0;

  const commit = () => {
    const base = routine === 'new' ? null : routine;
    const slug =
      draft.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'untitled-routine';

    onSave({
      id: base?.id ?? slug,
      name: draft.name.trim() || 'Untitled routine',
      description: draft.description.trim() || 'No description yet.',
      agentId: draft.agentId,
      scope:
        draft.scopeProject === ALL_PROJECTS
          ? { kind: 'all-projects' }
          : {
              kind: 'project',
              projectName: draft.scopeProject,
              projectPath: `~/ShipStudio/${draft.scopeProject}`,
            },
      trigger,
      permission,
      prompt: draft.prompt,
      severityFloor: draft.severityFloor,
      notify: draft.notify,
      autoRun: canAutoRun ? draft.autoRun : false,
      host,
      filePath:
        base?.filePath ??
        (draft.scopeProject === ALL_PROJECTS
          ? `~/ShipStudio/.shipstudio/routines/${slug}.md`
          : `${draft.scopeProject}/.shipstudio/routines/${slug}.md`),
      nextRunAt:
        canAutoRun && draft.autoRun && trigger.kind === 'interval'
          ? Date.now() + trigger.everyMinutes * 60_000
          : null,
      runs: base?.runs ?? [],
    });
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

  const scopeLabel = draft.scopeProject === ALL_PROJECTS ? 'All projects' : draft.scopeProject;

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title={isNew ? 'New routine' : draft.name || 'Routine'}
      className="routine-editor-modal"
    >
      <div className="routine-editor">
        {isNew && template && (
          <p className="routine-editor-context">
            Starting from <strong>{template.name}</strong>
          </p>
        )}

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
              rows={9}
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
                Ship Studio prepends the diff since the last run, the findings this routine already
                filed, and how to report new ones. Everything else is yours.
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
                    <span className="routine-scope-label">{scopeLabel}</span>
                    <ChevronIcon
                      size={10}
                      className={props['aria-expanded'] ? 'chevron-flipped' : undefined}
                    />
                  </MenuButton>
                )}
              >
                <DropdownItem
                  active={draft.scopeProject === ALL_PROJECTS}
                  onSelect={() => setDraft({ ...draft, scopeProject: ALL_PROJECTS })}
                >
                  All projects
                </DropdownItem>
                {PROJECTS.map((project) => (
                  <DropdownItem
                    key={project}
                    active={draft.scopeProject === project}
                    onSelect={() => setDraft({ ...draft, scopeProject: project })}
                  >
                    {project}
                  </DropdownItem>
                ))}
              </Dropdown>
            </div>

            <div className="routine-field">
              <span className="routine-field-label text-style-label">Agent</span>
              <SegmentedControl
                aria-label="Agent"
                size="default"
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
              value={draft.trigger}
              onValueChange={(value) => setDraft({ ...draft, trigger: value })}
              options={[
                { value: 'manual', label: 'Manual' },
                { value: '15m', label: 'Every 15m' },
                { value: '30m', label: 'Every 30m' },
                { value: '1h', label: 'Hourly' },
                { value: 'daily', label: 'Daily' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'push', label: 'On push' },
                { value: 'pr-opened', label: 'On PR' },
              ]}
            />

            <div className="routine-trigger-detail">
              {canRunInBackground && (
                <div className="routine-field routine-host-field">
                  <span className="routine-field-label text-style-label">
                    Even when Ship Studio is closed
                  </span>
                  <SegmentedControl
                    aria-label="Where it runs"
                    size="default"
                    value={host}
                    onValueChange={(value) => setDraft({ ...draft, host: value })}
                    options={[
                      { value: 'app', label: 'Only while the app is open' },
                      { value: 'background', label: 'Run in the background' },
                    ]}
                  />
                </div>
              )}

              <div className="routine-note">
                <InfoIcon size={12} />
                <span className="routine-note-text">
                  <strong>{formatTrigger(trigger)}.</strong> {describeTriggerReality(trigger, host)}
                </span>
              </div>

              {host === 'background' && (
                <ul className="routine-conditions">
                  <li>
                    Installs a login-scoped scheduled job (<code>~/Library/LaunchAgents</code>)
                    running the exact command below. Deleting the routine removes it.
                  </li>
                  <li>
                    Needs this Mac powered on or asleep, and you signed in. Shut down or signed out,
                    nothing runs until the next scheduled time.
                  </li>
                  <li>
                    Read-only is enforced — nobody is watching, so it reports but never edits.
                  </li>
                </ul>
              )}

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
              value={permission}
              onValueChange={(value) => setDraft({ ...draft, permission: value })}
              options={[
                { value: 'read-only', label: 'Read-only' },
                {
                  value: 'can-edit',
                  label: 'Can edit files',
                  disabled: host === 'background',
                },
              ]}
            />
            <span className="routine-field-hint">
              {host === 'background'
                ? 'Background runs are read-only. The agent reads the repository and reports; it cannot change anything while nobody is watching.'
                : permission === 'read-only'
                  ? 'The agent can read the repository and report. It cannot change anything.'
                  : 'The agent may edit files unattended. Every change lands in git, but nobody is watching it happen.'}
            </span>
          </div>

          <div className="routine-command">
            <div className="routine-command-header">
              <TerminalIcon size={12} />
              <span className="text-style-label">What actually runs</span>
            </div>
            <pre className="routine-command-body">{commandPreview}</pre>
          </div>
        </section>
      </div>

      <div className="routine-editor-actions">
        {isNew && (
          <Button
            variant="ghost"
            className="routine-editor-back"
            onClick={() => setStep('template')}
          >
            Back
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={promptIsEmpty} onClick={commit}>
          {isNew ? 'Create routine' : 'Save changes'}
        </Button>
      </div>
    </ModalFrame>
  );
}
