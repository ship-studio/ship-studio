/**
 * Workflows — the standing-instructions page.
 *
 * Laid out on the home screen's geometry: the same centred `dashboard-column`,
 * the same `dashboard-panel` section card, and the same
 * `dashboard-section-header` title/actions row the project list uses. Moving
 * between Home, Workflows and Inbox should not move anything.
 *
 * Reads from `lib/workflowsStore`, which is backed by real files on disk. A
 * workflow that appears here may have been written by the form below *or* by
 * the user's own agent through the bundled skill — the store reloads on both.
 *
 * @module components/workflows/WorkflowsView
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { usePolling } from '../../hooks/usePolling';
import { PlusIcon, ZapIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/EmptyState';
import { Spinner } from '../primitives/Spinner';
import { DashboardHeader } from '../dashboard/DashboardHeader';
import { DashboardSearch } from '../dashboard/DashboardSearch';
import { WorkflowRow } from './WorkflowRow';
import { WorkflowEditorModal, type WorkflowProjectOption } from './WorkflowEditorModal';
import { RunHistoryModal } from './RunHistoryModal';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useDashboardVisibility } from '../../hooks/useDashboardVisibility';
import { listProjects } from '../../lib/project';
import { logger } from '../../lib/logger';
import {
  formatTokens,
  summarizeWeek,
  type ProgressLine,
  type Workflow,
  type WorkflowDraft,
} from '../../lib/workflows';
import {
  deleteWorkflow,
  getSnapshot,
  loadProgress,
  runWorkflowNow,
  saveWorkflow,
  setAutoRun,
  subscribe,
} from '../../lib/workflowsStore';

/** Stable empty array so a workflow with no activity doesn't re-render on every tick. */
const EMPTY_PROGRESS: ProgressLine[] = [];

interface WorkflowsViewProps {
  /** Preselected project for a new workflow, when opened from a workspace. */
  currentProjectPath?: string | null;
}

export function WorkflowsView({ currentProjectPath }: WorkflowsViewProps) {
  const { workflows, progress, loaded, error } = useSyncExternalStore(subscribe, getSnapshot);
  const { showToast } = useOptionalToast();
  const { dashboardHeaderHidden, hideDashboardHeader } = useDashboardVisibility();

  const [editing, setEditing] = useState<Workflow | 'new' | null>(null);
  const [historyFor, setHistoryFor] = useState<Workflow | null>(null);
  const [projects, setProjects] = useState<WorkflowProjectOption[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // The project list is only needed to answer "which project does this run
  // against", so it loads once rather than on every store change.
  useEffect(() => {
    let active = true;
    listProjects()
      .then((list) => {
        if (active) setProjects(list);
      })
      .catch((err: unknown) => {
        logger.warn('[Workflows] Could not load projects', { error: String(err) });
      });
    return () => {
      active = false;
    };
  }, []);

  // Re-render once a second while something is running so its elapsed time
  // moves. Idle, this does nothing at all.
  const anyRunning = workflows.some((workflow) => workflow.isRunning);
  const [, setTick] = useState(0);
  usePolling(
    () => {
      setTick((value) => value + 1);
      return Promise.resolve();
    },
    { intervalMs: 1000, enabled: anyRunning }
  );

  // Hold the switch column only if something in the list actually has one.
  const anyArmable = workflows.some((workflow) => workflow.trigger.kind !== 'manual');
  const armedCount = workflows.filter(
    (workflow) => workflow.autoRun && workflow.trigger.kind !== 'manual'
  ).length;
  const week = summarizeWeek(workflows);

  const handleToggleAutoRun = useCallback(
    (workflow: Workflow, autoRun: boolean) => {
      setAutoRun(workflow, autoRun)
        .then(() => showToast(`Auto-run ${autoRun ? 'on' : 'off'} for ${workflow.name}`, 'info'))
        .catch((err: unknown) => showToast(String(err), 'error'));
    },
    [showToast]
  );

  const handleRunNow = useCallback(
    (workflow: Workflow) => {
      showToast(`Running ${workflow.name}…`, 'info');
      runWorkflowNow(workflow)
        .then((run) => {
          if (run.findings === 0) {
            showToast(`${workflow.name}: nothing to report`, 'success');
          } else {
            const plural = run.findings === 1 ? 'finding' : 'findings';
            showToast(`${workflow.name}: ${run.findings} ${plural} — see your Inbox`, 'success');
          }
        })
        .catch((err: unknown) => showToast(String(err), 'error'));
    },
    [showToast]
  );

  // Opening a workflow mid-run has missed every event so far, so pull the
  // backend's buffer once; the live stream continues from there.
  const handleToggleExpanded = useCallback((workflow: Workflow) => {
    setExpandedId((current) => {
      if (current === workflow.id) return null;
      void loadProgress(workflow.id);
      return workflow.id;
    });
  }, []);

  const handleSave = useCallback(
    async (projectPath: string, slug: string | null, draft: WorkflowDraft) => {
      const saved = await saveWorkflow(projectPath, slug, draft);
      setEditing(null);
      showToast(`Saved ${saved.name}`, 'success');
    },
    [showToast]
  );

  const handleDelete = useCallback(
    async (workflow: Workflow) => {
      await deleteWorkflow(workflow.projectPath, workflow.slug);
      setEditing(null);
      showToast(`Deleted ${workflow.name}`, 'info');
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
                  <span className="dashboard-section-title text-style-h4">Workflows</span>
                  {workflows.length > 0 && (
                    <span className="dashboard-section-count text-style-h4 font-weight-heading">
                      {workflows.length}
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
                    New workflow
                  </Button>
                </div>
                {workflows.length > 0 && (
                  <div className="dashboard-section-actions-right workflows-summary">
                    <span className="workflows-summary-item">
                      <strong>{armedCount}</strong> on auto-run
                    </span>
                    <span className="workflows-summary-sep" aria-hidden>
                      ·
                    </span>
                    <span className="workflows-summary-item">
                      <strong>{week.runs}</strong> runs this week
                    </span>
                    {week.tokens !== null && (
                      <>
                        <span className="workflows-summary-sep" aria-hidden>
                          ·
                        </span>
                        <span className="workflows-summary-item">
                          <strong>{formatTokens(week.tokens)}</strong> tokens
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {!loaded ? (
              <div className="workflows-loading">
                <Spinner size="lg" />
              </div>
            ) : error ? (
              <EmptyState
                icon={<ZapIcon size={28} />}
                title="Could not read your workflows"
                description={error}
              />
            ) : workflows.length === 0 ? (
              <EmptyState
                icon={<ZapIcon size={28} />}
                title="No workflows yet"
                description="A workflow is an instruction and a project. Press Run whenever you want it, or put it on a schedule that ticks while Ship Studio is open. It uses the agent CLI you already have, and files what it finds in your Inbox. You can also just ask your agent to make you one."
                action={
                  <Button variant="primary" onClick={() => setEditing('new')}>
                    Create your first workflow
                  </Button>
                }
              />
            ) : (
              <div className="workflows-list">
                {workflows.map((workflow) => (
                  <WorkflowRow
                    key={workflow.id}
                    workflow={workflow}
                    progress={progress[workflow.id] ?? EMPTY_PROGRESS}
                    isExpanded={expandedId === workflow.id}
                    reserveToggleSlot={anyArmable}
                    onToggleExpanded={handleToggleExpanded}
                    onEdit={setEditing}
                    onRunNow={handleRunNow}
                    onToggleAutoRun={handleToggleAutoRun}
                    onOpenHistory={setHistoryFor}
                  />
                ))}
              </div>
            )}
          </section>

          <p className="workflows-page-footer">
            Workflows run your own agent CLI inside your project folder, on the plan you already pay
            for. Nothing runs while Ship Studio is closed. Each one is a markdown file under{' '}
            <code>.shipstudio/workflows/</code> — commit them, review them in a PR, or ask your
            agent to write you one.
          </p>

          <div className="dashboard-bottom-spacer" aria-hidden />
        </div>
      </div>

      {editing !== null && (
        <WorkflowEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          workflow={editing}
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
          workflow={workflows.find((r) => r.id === historyFor.id) ?? historyFor}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  );
}
