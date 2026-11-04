/**
 * The "Scheduled" section of the agent editor: the check-ins an agent set for
 * itself and the routines the user gave it, each cancellable, plus a line to
 * add one. Changes apply at once, not on Save — they're actions, not fields.
 *
 * The time is typed in words ("every weekday 9am") and read back as the
 * backend resolved it, so what the user sees is what will fire.
 *
 * @module components/agents/AgentSchedule
 */

import { useEffect, useState, type KeyboardEvent } from 'react';
import { CloseIcon, PauseIcon, PlayIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextField } from '../primitives/TextField';
import {
  cancelCheckIn,
  createCheckIn,
  describeRepeat,
  formatWhen,
  pauseCheckIn,
  previewSchedule,
  sortCheckIns,
  type Agent,
  type CheckIn,
  type SchedulePreview,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAsyncState } from '../../hooks/useAsyncState';

/** A Validation error's reason, without the examples meant for an agent. */
function reasonOf(err: unknown): string {
  const e = asCommandError(err);
  const text = e.type === 'Validation' ? e.reason : formatCommandError(e);
  return text.split(' Examples:')[0];
}

export function AgentSchedule({ agent }: { agent: Agent }) {
  const [items, setItems] = useState<CheckIn[]>(agent.checkIns ?? []);
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<SchedulePreview | string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read the phrase back as the user types, after a short pause.
  useEffect(() => {
    if (!when.trim()) return;
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
  const shown = when.trim() ? preview : null;

  const action = useAsyncState(async (change: () => Promise<void>) => {
    setError(null);
    try {
      await change();
    } catch (err) {
      setError(reasonOf(err));
    }
  });
  const run = action.execute;
  const busy = action.isLoading;

  const add = () =>
    run(async () => {
      const made = await createCheckIn(agent.id, when, note);
      setItems((list) => [...list, made]);
      setWhen('');
      setNote('');
    });

  const remove = (id: string) =>
    run(async () => {
      await cancelCheckIn(agent.id, id);
      setItems((list) => list.filter((c) => c.id !== id));
    });

  const togglePause = (c: CheckIn) =>
    run(async () => {
      await pauseCheckIn(agent.id, c.id, !c.paused);
      setItems((list) => list.map((x) => (x.id === c.id ? { ...x, paused: !c.paused } : x)));
    });

  const canAdd = when.trim().length > 0 && note.trim().length > 0 && !busy;
  // Enter adds the routine rather than submitting the whole editor.
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (canAdd) void add();
  };

  return (
    <section className="agent-schedule" aria-label="Scheduled">
      <h3 className="agent-editor__section-title">Scheduled</h3>

      {items.length > 0 && (
        <ul className="agent-schedule__list">
          {sortCheckIns(items).map((c) => (
            <li key={c.id} className="agent-schedule__item" data-paused={c.paused || undefined}>
              <div className="agent-schedule__text">
                <span className="agent-schedule__when">
                  {c.repeat
                    ? `${describeRepeat(c.repeat)} · ${c.paused ? 'paused' : `next ${formatWhen(c.nextAt)}`}`
                    : formatWhen(c.nextAt)}
                </span>
                <span className="agent-schedule__note">{c.note}</span>
              </div>
              {c.repeat && (
                <IconButton
                  variant="ghost"
                  size="compact"
                  icon={c.paused ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
                  onClick={() => void togglePause(c)}
                  disabled={busy}
                  title={c.paused ? 'Resume' : 'Pause'}
                  aria-label={c.paused ? 'Resume routine' : 'Pause routine'}
                />
              )}
              <IconButton
                variant="ghost"
                size="compact"
                icon={<CloseIcon size={12} />}
                onClick={() => void remove(c.id)}
                disabled={busy}
                title="Cancel"
                aria-label="Cancel check-in"
              />
            </li>
          ))}
        </ul>
      )}

      <div className="agent-schedule__add">
        <TextField
          placeholder="When: every weekday 9am, tomorrow 14:00…"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          onKeyDown={onEnter}
          aria-label="When"
        />
        <div className="agent-schedule__row">
          <TextField
            placeholder="What should it do? e.g. Brief me on Acme"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={onEnter}
            aria-label="What it should do"
            maxLength={600}
          />
          <Button type="button" onClick={() => void add()} disabled={!canAdd}>
            Add
          </Button>
        </div>
        {shown && (
          <p className="agent-editor__hint" data-invalid={typeof shown === 'string' || undefined}>
            {typeof shown === 'string'
              ? shown
              : shown.repeat
                ? `${shown.repeat[0].toUpperCase()}${shown.repeat.slice(1)}, first ${formatWhen(shown.nextAt)}`
                : formatWhen(shown.nextAt)}
          </p>
        )}
      </div>

      {error && (
        <p className="agent-editor__error" role="alert">
          {error}
        </p>
      )}
      <p className="agent-editor__hint">
        Runs only while Ship Studio is open. A check-in missed while it&rsquo;s closed runs once,
        late, when it reopens; a missed routine waits for its next time.
      </p>
    </section>
  );
}
