/**
 * An agent's schedule, anchored to the chat header: the check-ins it set for
 * itself and the routines you gave it, and one line to add another.
 *
 * The trigger reads "N scheduled", or is a quiet clock when there's nothing.
 * The composer takes "when: what" in one line and reads the time back as the
 * backend resolved it, so what you see is what will fire. Edit puts a row's
 * own words back in that composer; Run now wakes the agent with it at once,
 * leaving its next time alone. Changes apply at once and the list follows
 * the agent registry.
 *
 * @module components/agents/AgentSchedulePopover
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  CloseIcon,
  EditFieldIcon,
  HistoryIcon,
  PauseIcon,
  PlayIcon,
  SkipNextIcon,
} from '@/components/icons';
import { Dropdown } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { Button } from '../primitives/Button';
import { TextField } from '../primitives/TextField';
import {
  cancelCheckIn,
  createCheckIn,
  describeCheckInTime,
  describeRepeat,
  formatWhen,
  pauseCheckIn,
  previewSchedule,
  runCheckInNow,
  scheduleWhenPhrase,
  sortCheckIns,
  splitScheduleInput,
  updateCheckIn,
  type Agent,
  type CheckIn,
  type SchedulePreview,
} from '../../lib/agents';
import { refreshAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAsyncState } from '../../hooks/useAsyncState';

/** A Validation error's reason, without the examples meant for an agent. */
function reasonOf(err: unknown): string {
  const e = asCommandError(err);
  const text = e.type === 'Validation' ? e.reason : formatCommandError(e);
  return text.split(' Examples:')[0];
}

/** "Every weekday at 9:00 AM, first tomorrow 9:00 AM" / "Tomorrow 9:00 AM". */
function readBack(p: SchedulePreview): string {
  if (!p.repeat) return formatWhen(p.nextAt);
  const first = formatWhen(p.nextAt).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase());
  return `${describeRepeat(p.repeat)}, first ${first}`;
}

interface AgentSchedulePopoverProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentSchedulePopover({ agent, open, onOpenChange }: AgentSchedulePopoverProps) {
  const count = agent.checkIns?.length ?? 0;
  return (
    <Dropdown
      align="right"
      portal
      open={open}
      onOpenChange={onOpenChange}
      menuClassName="agent-schedule"
      trigger={(p) =>
        count > 0 ? (
          <Button
            {...p}
            tabIndex={0}
            variant="ghost"
            className="agent-chat__scheduled"
            leftIcon={<HistoryIcon size={12} />}
            title="Scheduled check-ins"
          >
            {count} scheduled
          </Button>
        ) : (
          <IconButton
            {...p}
            tabIndex={0}
            variant="ghost"
            icon={<HistoryIcon size={14} />}
            title="Schedule a check-in"
            aria-label={`Schedule a check-in for ${agent.name}`}
          />
        )
      }
    >
      <ScheduleBody agent={agent} onRan={() => onOpenChange(false)} />
    </Dropdown>
  );
}

/** Mounted each time the popover opens, so it starts fresh with focus in the composer. */
function ScheduleBody({ agent, onRan }: { agent: Agent; onRan: () => void }) {
  const items = sortCheckIns(agent.checkIns ?? []);
  const [text, setText] = useState('');
  /** The row whose words are in the composer, if it's an edit. */
  const [editing, setEditing] = useState<CheckIn | null>(null);
  const [preview, setPreview] = useState<SchedulePreview | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { when, note } = splitScheduleInput(text);

  // After the Dropdown's own focus handling, which would park it on the menu.
  useEffect(() => inputRef.current?.focus(), []);

  // Read the time back as it's typed, after a short pause.
  useEffect(() => {
    if (!when) return;
    let live = true;
    const timer = window.setTimeout(() => {
      previewSchedule(when)
        .then((p) => live && setPreview(p))
        .catch((err) => live && setPreview(reasonOf(err)));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [when]);

  const { execute: run, isLoading: busy } = useAsyncState(async (change: () => Promise<void>) => {
    setError(null);
    try {
      await change();
      await refreshAgents();
    } catch (err) {
      setError(reasonOf(err));
    }
  });

  const parsed = when && preview !== null && typeof preview !== 'string' ? preview : null;
  const canAdd = parsed !== null && note.length > 0 && !busy;

  const reset = () => {
    setEditing(null);
    setText('');
    setPreview(null);
    setError(null);
  };

  const startEdit = (c: CheckIn) => {
    setEditing(c);
    setError(null);
    setText(`${scheduleWhenPhrase(c)}: ${c.note}`);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && editing) {
      // Leave the edit, not the popover.
      e.preventDefault();
      e.stopPropagation();
      reset();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!canAdd) return;
    void run(async () => {
      if (editing) await updateCheckIn(agent.id, editing.id, when, note);
      else await createCheckIn(agent.id, when, note);
      reset();
    });
  };

  const reason = when && typeof preview === 'string' ? preview : null;
  const problem = error ?? reason;
  const invalid = problem !== null;
  let readback = 'A time, a colon, then what to do. Return adds it.';
  if (problem) readback = problem;
  else if (parsed && !note) readback = `${readBack(parsed)} · then a colon and what to do`;
  else if (parsed) readback = readBack(parsed);
  else if (when) readback = '\u00a0';

  return (
    <div className="agent-schedule__body">
      {items.length > 0 ? (
        <ul className="agent-schedule__list" aria-label="Scheduled">
          {items.map((c) => (
            <ScheduleRow
              key={c.id}
              item={c}
              busy={busy}
              editing={editing?.id === c.id}
              onRunNow={() =>
                void run(async () => {
                  await runCheckInNow(agent.id, c.id);
                  onRan();
                })
              }
              onEdit={() => startEdit(c)}
              onTogglePause={() => void run(() => pauseCheckIn(agent.id, c.id, !c.paused))}
              onCancel={() => void run(() => cancelCheckIn(agent.id, c.id))}
            />
          ))}
        </ul>
      ) : (
        <p className="agent-schedule__empty">Nothing scheduled for {agent.name} yet.</p>
      )}

      <div className="agent-schedule__composer">
        <TextField
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. every weekday 9am: brief me on Acme"
          aria-label={
            editing
              ? `Edit “${editing.note}”: when, a colon, then what to do`
              : 'New check-in: when, a colon, then what to do'
          }
          invalid={invalid}
          maxLength={640}
        />
        <p
          className="agent-schedule__readback"
          data-invalid={invalid || undefined}
          aria-live="polite"
        >
          {readback}
        </p>
      </div>

      <p className="agent-schedule__foot">
        {editing
          ? 'Return saves the change; Esc leaves it as it was.'
          : 'Runs only while Ship Studio is open; a missed check-in runs once when it reopens.'}
      </p>
    </div>
  );
}

function ScheduleRow({
  item,
  busy,
  editing,
  onRunNow,
  onEdit,
  onTogglePause,
  onCancel,
}: {
  item: CheckIn;
  busy: boolean;
  editing: boolean;
  onRunNow: () => void;
  onEdit: () => void;
  onTogglePause: () => void;
  onCancel: () => void;
}) {
  return (
    <li
      className="agent-schedule__item"
      data-paused={item.paused || undefined}
      data-editing={editing || undefined}
    >
      <div className="agent-schedule__text">
        <span className="agent-schedule__note">{item.note}</span>
        <span className="agent-schedule__when">{describeCheckInTime(item)}</span>
      </div>
      <div className="agent-schedule__actions">
        <IconButton
          tabIndex={0}
          variant="ghost"
          size="compact"
          icon={<SkipNextIcon size={12} />}
          onClick={onRunNow}
          disabled={busy}
          title="Run now"
          aria-label={`Run “${item.note}” now`}
        />
        <IconButton
          tabIndex={0}
          variant="ghost"
          size="compact"
          icon={<EditFieldIcon size={12} />}
          onClick={onEdit}
          disabled={busy}
          title="Edit"
          aria-label={`Edit “${item.note}”`}
        />
        {item.repeat && (
          <IconButton
            tabIndex={0}
            variant="ghost"
            size="compact"
            icon={item.paused ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
            onClick={onTogglePause}
            disabled={busy}
            title={item.paused ? 'Resume' : 'Pause'}
            aria-label={item.paused ? `Resume “${item.note}”` : `Pause “${item.note}”`}
          />
        )}
        <IconButton
          tabIndex={0}
          variant="ghost"
          size="compact"
          icon={<CloseIcon size={12} />}
          onClick={onCancel}
          disabled={busy}
          title="Cancel"
          aria-label={`Cancel “${item.note}”`}
        />
      </div>
    </li>
  );
}
