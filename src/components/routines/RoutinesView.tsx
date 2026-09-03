/**
 * Routines — the standing-instructions page.
 *
 * Laid out on the home screen's geometry: the same centred `dashboard-column`,
 * the same `dashboard-panel` section card, and the same
 * `dashboard-section-header` title/actions row the project list uses. Moving
 * between Home, Routines and Inbox should not move anything.
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
import { DashboardHeader } from '../dashboard/DashboardHeader';
import { DashboardSearch } from '../dashboard/DashboardSearch';
import { RoutineRow } from './RoutineRow';
import { RoutineEditorModal } from './RoutineEditorModal';
import { RunHistoryModal } from './RunHistoryModal';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useDashboardVisibility } from '../../hooks/useDashboardVisibility';
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
  const { dashboardHeaderHidden, hideDashboardHeader } = useDashboardVisibility();

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
    <div className="dashboard-with-changelog">
      <div className="dashboard-scroll-container">
        <div className="dashboard-column">
          {!dashboardHeaderHidden && (
            <DashboardHeader title="What should run today?" onHide={hideDashboardHeader} />
          )}

          <DashboardSearch />

          <section className="dashboard-panel">
            <div className="dashboard-section-header">
              <div className="dashboard-section-heading">
                <div className="dashboard-section-heading-title">
                  <span className="dashboard-section-title text-style-h4">Routines</span>
                  {routines.length > 0 && (
                    <span className="dashboard-section-count text-style-h4 font-weight-heading">
                      {routines.length}
                    </span>
                  )}
                </div>
              </div>
              <div className="dashboard-section-controls">
                <div className="dashboard-section-actions-left">
                  <Button
                    variant="primary"
                    className="dashboard-action-button text-style-control-semibold"
                    leftIcon={<PlusIcon size={14} />}
                    onClick={() => setEditing('new')}
                  >
                    New routine
                  </Button>
                </div>
                {routines.length > 0 && (
                  <div className="dashboard-section-actions-right routines-summary">
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
                      <strong>{formatTokens(week.tokens)}</strong> tokens
                    </span>
                  </div>
                )}
              </div>
            </div>

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
              <div className="routines-list">
                {routines.map((routine) => (
                  <RoutineRow
                    key={routine.id}
                    routine={routine}
                    onEdit={setEditing}
                    onRunNow={handleRunNow}
                    onToggleAutoRun={handleToggleAutoRun}
                    onOpenHistory={setHistoryFor}
                  />
                ))}
              </div>
            )}
          </section>

          <p className="routines-page-footer">
            Routines run the agent CLI installed on this Mac, inside your project folder — there is
            no Ship Studio server and no copy of your code anywhere else. Nothing runs while the app
            is closed, so auto-run is an interval that only ticks while Ship Studio is open rather
            than a time of day it has to hit. Each routine is a markdown file under{' '}
            <code>.shipstudio/routines/</code>, and tokens are billed to the agent plan you already
            pay for.
          </p>

          <div className="dashboard-bottom-spacer" aria-hidden />
        </div>
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
