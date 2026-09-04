/**
 * Routines — the standing-instructions page.
 *
 * Laid out on the home screen's geometry: the same centred `dashboard-column`,
 * the same `dashboard-panel` section card, and the same
 * `dashboard-section-header` title/actions row the project list uses. Moving
 * between Home, Routines and Inbox should not move anything.
 *
 * Reads from `lib/routinesStore`, which is backed by real files on disk. A
 * routine that appears here may have been written by the form below *or* by
 * the user's own agent through the bundled skill — the store reloads on both.
 *
 * @module components/routines/RoutinesView
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { usePolling } from '../../hooks/usePolling';
import { PlusIcon, ZapIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/EmptyState';
import { Spinner } from '../primitives/Spinner';
import { DashboardHeader } from '../dashboard/DashboardHeader';
import { DashboardSearch } from '../dashboard/DashboardSearch';
import { RoutineRow } from './RoutineRow';
import { RoutineEditorModal, type RoutineProjectOption } from './RoutineEditorModal';
import { RunHistoryModal } from './RunHistoryModal';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useDashboardVisibility } from '../../hooks/useDashboardVisibility';
import { listProjects } from '../../lib/project';
import { logger } from '../../lib/logger';
import { formatTokens, summarizeWeek, type Routine, type RoutineDraft } from '../../lib/routines';
import {
  deleteRoutine,
  getSnapshot,
  runRoutineNow,
  saveRoutine,
  setAutoRun,
  subscribe,
} from '../../lib/routinesStore';

interface RoutinesViewProps {
  /** Preselected project for a new routine, when opened from a workspace. */
  currentProjectPath?: string | null;
}

export function RoutinesView({ currentProjectPath }: RoutinesViewProps) {
  const { routines, loaded, error } = useSyncExternalStore(subscribe, getSnapshot);
  const { showToast } = useOptionalToast();
  const { dashboardHeaderHidden, hideDashboardHeader } = useDashboardVisibility();

  const [editing, setEditing] = useState<Routine | 'new' | null>(null);
  const [historyFor, setHistoryFor] = useState<Routine | null>(null);
  const [projects, setProjects] = useState<RoutineProjectOption[]>([]);

  // The project list is only needed to answer "which project does this run
  // against", so it loads once rather than on every store change.
  useEffect(() => {
    let active = true;
    listProjects()
      .then((list) => {
        if (active) setProjects(list);
      })
      .catch((err: unknown) => {
        logger.warn('[Routines] Could not load projects', { error: String(err) });
      });
    return () => {
      active = false;
    };
  }, []);

  // Re-render once a second while something is running so its elapsed time
  // moves. Idle, this does nothing at all.
  const anyRunning = routines.some((routine) => routine.isRunning);
  const [, setTick] = useState(0);
  usePolling(
    () => {
      setTick((value) => value + 1);
      return Promise.resolve();
    },
    { intervalMs: 1000, enabled: anyRunning }
  );

  const armedCount = routines.filter(
    (routine) => routine.autoRun && routine.trigger.kind !== 'manual'
  ).length;
  const week = summarizeWeek(routines);

  const handleToggleAutoRun = useCallback(
    (routine: Routine, autoRun: boolean) => {
      setAutoRun(routine, autoRun)
        .then(() => showToast(`Auto-run ${autoRun ? 'on' : 'off'} for ${routine.name}`, 'info'))
        .catch((err: unknown) => showToast(String(err), 'error'));
    },
    [showToast]
  );

  const handleRunNow = useCallback(
    (routine: Routine) => {
      showToast(`Running ${routine.name}…`, 'info');
      runRoutineNow(routine)
        .then((run) => {
          if (run.findings === 0) {
            showToast(`${routine.name}: nothing to report`, 'success');
          } else {
            const plural = run.findings === 1 ? 'finding' : 'findings';
            showToast(`${routine.name}: ${run.findings} ${plural} — see your Inbox`, 'success');
          }
        })
        .catch((err: unknown) => showToast(String(err), 'error'));
    },
    [showToast]
  );

  const handleSave = useCallback(
    async (projectPath: string, slug: string | null, draft: RoutineDraft) => {
      const saved = await saveRoutine(projectPath, slug, draft);
      setEditing(null);
      showToast(`Saved ${saved.name}`, 'success');
    },
    [showToast]
  );

  const handleDelete = useCallback(
    async (routine: Routine) => {
      await deleteRoutine(routine.projectPath, routine.slug);
      setEditing(null);
      showToast(`Deleted ${routine.name}`, 'info');
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
                    {week.tokens !== null && (
                      <>
                        <span className="routines-summary-sep" aria-hidden>
                          ·
                        </span>
                        <span className="routines-summary-item">
                          <strong>{formatTokens(week.tokens)}</strong> tokens
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {!loaded ? (
              <div className="routines-loading">
                <Spinner size="lg" />
              </div>
            ) : error ? (
              <EmptyState
                icon={<ZapIcon size={28} />}
                title="Could not read your routines"
                description={error}
              />
            ) : routines.length === 0 ? (
              <EmptyState
                icon={<ZapIcon size={28} />}
                title="No routines yet"
                description="A routine is an instruction and a project. Press Run whenever you want it, or put it on a schedule that ticks while Ship Studio is open. It uses the agent CLI you already have, and files what it finds in your Inbox. You can also just ask your agent to make you one."
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
            Routines run your own agent CLI inside your project folder, on the plan you already pay
            for. Nothing runs while Ship Studio is closed. Each one is a markdown file under{' '}
            <code>.shipstudio/routines/</code> — commit them, review them in a PR, or ask your agent
            to write you one.
          </p>

          <div className="dashboard-bottom-spacer" aria-hidden />
        </div>
      </div>

      {editing !== null && (
        <RoutineEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          routine={editing}
          projects={projects}
          defaultProjectPath={currentProjectPath}
          onClose={() => setEditing(null)}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}
      {historyFor !== null && (
        <RunHistoryModal
          key={historyFor.id}
          routine={routines.find((r) => r.id === historyFor.id) ?? historyFor}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  );
}
