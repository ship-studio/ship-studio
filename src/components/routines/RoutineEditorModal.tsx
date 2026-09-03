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

type TriggerPreset = '15m' | '30m' | '1h' | 'daily' | 'weekly' | 'push' | 'pr-opened';

const TRIGGER_PRESETS: Record<TriggerPreset, RoutineTrigger> = {
  '15m': { kind: 'interval', everyMinutes: 15 },
  '30m': { kind: 'interval', everyMinutes: 30 },
  '1h': { kind: 'interval', everyMinutes: 60 },
  daily: { kind: 'daily', atHour: 9, atMinute: 0 },
  weekly: { kind: 'weekly', weekday: 1, atHour: 8, atMinute: 30 },
  push: { kind: 'event', event: 'push' },
  'pr-opened': { kind: 'event', event: 'pr-opened' },
};

function presetFor(trigger: RoutineTrigger): TriggerPreset {
  if (trigger.kind === 'interval') {
    if (trigger.everyMinutes <= 15) return '15m';
    if (trigger.everyMinutes <= 30) return '30m';
    return '1h';
  }
  if (trigger.kind === 'daily') return 'daily';
  if (trigger.kind === 'weekly') return 'weekly';
  return trigger.event === 'pr-opened' ? 'pr-opened' : 'push';
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
  catchUpOnLaunch: boolean;
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
    catchUpOnLaunch: routine.catchUpOnLaunch,
  };
}

const BLANK: Draft = {
  name: '',
  description: '',
  agentId: 'claude-code',
  scopeProject: PROJECTS[0],
  trigger: '30m',
  permission: 'read-only',
  prompt: '',
  severityFloor: 'warning',
  notify: false,
  catchUpOnLaunch: true,
};

export function RoutineEditorModal({ routine, onClose, onSave }: RoutineEditorModalProps) {
  const isNew = routine === 'new';
  const [pickingTemplate, setPickingTemplate] = useState(isNew);
  const [draft, setDraft] = useState<Draft>(() => (isNew ? BLANK : draftFrom(routine)));

  const trigger = TRIGGER_PRESETS[draft.trigger];
  const isTimeTrigger = trigger.kind !== 'event';

  const commandPreview = useMemo(
    () => buildCommandPreview({ agentId: draft.agentId, permission: draft.permission }),
    [draft.agentId, draft.permission]
  );

  const applyTemplate = (template: RoutineTemplate) => {
    const isBlank = template.id === 'tpl-blank';
    setDraft({
      ...BLANK,
      name: isBlank ? '' : template.name,
      description: isBlank ? '' : template.description,
      scopeProject: template.scopeKind === 'all-projects' ? ALL_PROJECTS : PROJECTS[0],
      trigger: presetFor(template.trigger),
      permission: template.permission,
      prompt: template.prompt,
    });
    setPickingTemplate(false);
  };

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
      permission: draft.permission,
      prompt: draft.prompt,
      severityFloor: draft.severityFloor,
      notify: draft.notify,
      enabled: base?.enabled ?? true,
      filePath:
        base?.filePath ??
        (draft.scopeProject === ALL_PROJECTS
          ? `~/ShipStudio/.shipstudio/routines/${slug}.md`
          : `${draft.scopeProject}/.shipstudio/routines/${slug}.md`),
      nextRunAt: isTimeTrigger ? Date.now() + 30 * 60_000 : null,
      catchUpOnLaunch: isTimeTrigger ? draft.catchUpOnLaunch : false,
      missedSince: base?.missedSince ?? null,
      runs: base?.runs ?? [],
    });
  };

  if (pickingTemplate) {
    return (
      <ModalFrame
        isOpen
        onClose={onClose}
        title="New routine"
        className="routine-editor-modal routine-template-modal"
      >
        <RoutineTemplatePicker onPick={applyTemplate} />
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
        <label className="routine-field">
          <span className="routine-field-label text-style-label">Name</span>
          <TextField
            value={draft.name}
            placeholder="Security sweep"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>

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
          <span className="routine-field-label text-style-label">Trigger</span>
          <SegmentedControl
            aria-label="Trigger"
            size="default"
            value={draft.trigger}
            onValueChange={(value) => setDraft({ ...draft, trigger: value })}
            options={[
              { value: '15m', label: '15 min' },
              { value: '30m', label: '30 min' },
              { value: '1h', label: 'Hourly' },
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'push', label: 'On push' },
              { value: 'pr-opened', label: 'On PR' },
            ]}
          />

          <div className="routine-note">
            <InfoIcon size={12} />
            <span className="routine-note-text text-style-hint">
              <strong>{formatTrigger(trigger)}.</strong> {describeTriggerReality(trigger)}
            </span>
          </div>

          {isTimeTrigger && (
            <label className="settings-form-checkbox">
              <input
                type="checkbox"
                checked={draft.catchUpOnLaunch}
                onChange={(event) => setDraft({ ...draft, catchUpOnLaunch: event.target.checked })}
              />
              <span className="settings-form-checkbox-copy">
                <span className="settings-form-checkbox-title">
                  Catch up when Ship Studio next opens
                </span>
                <span className="settings-form-checkbox-description">
                  Runs once for the window that passed while the app was closed, instead of waiting
                  for the next one.
                </span>
              </span>
            </label>
          )}
        </div>

        <label className="routine-field">
          <span className="routine-field-label text-style-label">Instructions</span>
          <textarea
            className="routine-prompt"
            rows={10}
            value={draft.prompt}
            spellCheck={false}
            placeholder="Tell the agent what to look for, and what not to bother you about."
            onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
          />
          <span className="routine-field-hint text-style-hint">
            Ship Studio prepends the diff since the last run, the findings this routine already
            filed, and how to report new ones. Everything else is yours.
          </span>
        </label>

        <div className="routine-field">
          <span className="routine-field-label text-style-label">Permission</span>
          <SegmentedControl
            aria-label="Permission"
            size="default"
            value={draft.permission}
            onValueChange={(value) => setDraft({ ...draft, permission: value })}
            options={[
              { value: 'read-only', label: 'Read-only' },
              { value: 'can-edit', label: 'Can edit files' },
            ]}
          />
          <span className="routine-field-hint text-style-hint">
            {draft.permission === 'read-only'
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
      </div>

      <div className="routine-editor-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={commit}>
          {isNew ? 'Create routine' : 'Save changes'}
        </Button>
      </div>
    </ModalFrame>
  );
}
