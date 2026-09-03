/**
 * Routines — the standing-instructions page.
 *
 * PROTOTYPE. Reads and writes the in-memory store in `lib/routinesStore`;
 * nothing is scheduled, spawned, or persisted. See `docs/routines-inbox.md`
 * for the architecture this stands in for.
 *
 * @module components/routines/RoutinesView
 */

import { useCallback, useState, useSyncExternalStore } from 'react';
import { PlusIcon, ZapIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/EmptyState';
import { RoutineRow } from './RoutineRow';
import { RoutineEditorModal } from './RoutineEditorModal';
import { RunHistoryModal } from './RunHistoryModal';
import { useOptionalToast } from '../../contexts/ToastContext';
import { formatTokens, summarizeWeek, type Routine } from '../../lib/routines';
import {
  getSnapshot,
  runRoutineNow,
  saveRoutine,
  setAutoRun,
  subscribe,
} from '../../lib/routinesStore';

export function RoutinesView() {
  const { routines } = useSyncExternalStore(subscribe, getSnapshot);
  const { showToast } = useOptionalToast();

  const [editing, setEditing] = useState<Routine | 'new' | null>(null);
  const [historyFor, setHistoryFor] = useState<Routine | null>(null);

  const armedCount = routines.filter(
    (routine) => routine.autoRun && routine.trigger.kind !== 'manual'
  ).length;
  const week = summarizeWeek(routines);

  const handleToggleAutoRun = useCallback(
    (routine: Routine, autoRun: boolean) => {
      setAutoRun(routine.id, autoRun);
      showToast(`Auto-run ${autoRun ? 'on' : 'off'} for ${routine.name}`, 'info');
    },
    [showToast]
  );

  const handleRunNow = useCallback(
    (routine: Routine) => {
      runRoutineNow(routine.id);
      showToast(`Running ${routine.name}…`, 'info');
    },
    [showToast]
  );

  const handleSave = useCallback(
    (routine: Routine) => {
      saveRoutine(routine);
      setEditing(null);
      showToast(`Saved ${routine.name}`, 'success');
    },
    [showToast]
  );

  return (
    <div className="dashboard-scroll-container">
      <div className="routines-page">
        <header className="routines-page-header">
          <div className="routines-page-heading">
            <h1 className="routines-page-title">Routines</h1>
            <p className="routines-page-subtitle">
              Saved instructions you run with one press. Findings land in your Inbox.
            </p>
          </div>
          <Button
            variant="primary"
            leftIcon={<PlusIcon size={14} />}
            onClick={() => setEditing('new')}
          >
            New routine
          </Button>
        </header>

        {routines.length > 0 && (
          <div className="routines-summary">
            <span className="routines-summary-item">
              <strong>{armedCount}</strong> on auto-run
            </span>
            <span className="routines-summary-sep" aria-hidden>
              ·
            </span>
            <span className="routines-summary-item">
              <strong>{week.runs}</strong> runs this week
            </span>
            <span className="routines-summary-sep" aria-hidden>
              ·
            </span>
            <span className="routines-summary-item">
              <strong>{week.findings}</strong> findings
            </span>
            <span className="routines-summary-sep" aria-hidden>
              ·
            </span>
            <span className="routines-summary-item">
              <strong>{formatTokens(week.tokens)}</strong> tokens on your own plan
            </span>
          </div>
        )}

        <section className="routines-list" aria-label="Routines">
          {routines.length === 0 ? (
            <EmptyState
              icon={<ZapIcon size={28} />}
              title="No routines yet"
              description="A routine is a prompt and a project. Press Run whenever you want it, or put it on an interval that ticks while Ship Studio is open. It uses the agent CLI you already have, and files what it finds in your Inbox."
              action={
                <Button variant="primary" onClick={() => setEditing('new')}>
                  Create your first routine
                </Button>
              }
            />
          ) : (
            routines.map((routine) => (
              <RoutineRow
                key={routine.id}
                routine={routine}
                onEdit={setEditing}
                onRunNow={handleRunNow}
                onToggleAutoRun={handleToggleAutoRun}
                onOpenHistory={setHistoryFor}
              />
            ))
          )}
        </section>

        <footer className="routines-page-footer">
          Routines run the agent CLI installed on this Mac, inside your project folder — there is no
          Ship Studio server and no copy of your code anywhere else. Nothing runs while the app is
          closed, so auto-run is an interval that only ticks while Ship Studio is open rather than a
          time of day it has to hit. Each routine is a markdown file under{' '}
          <code>.shipstudio/routines/</code>, and tokens are billed to the agent plan you already
          pay for.
        </footer>

        <div className="dashboard-bottom-spacer" aria-hidden />
      </div>

      {editing !== null && (
        <RoutineEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          routine={editing}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
      {historyFor !== null && (
        <RunHistoryModal
          key={historyFor.id}
          routine={historyFor}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  );
}
