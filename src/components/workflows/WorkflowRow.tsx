/**
 * One workflow in the Workflows list.
 *
 * Run is the primary action and is always visible: a workflow is something you
 * press, and auto-run is an opt-in on top of that. There is deliberately no
 * "missed" state — see the WorkflowTrigger docs in `lib/workflows`.
 *
 * @module components/workflows/WorkflowRow
 */

import {
  ChevronIcon,
  ClaudeIcon,
  CodexIcon,
  GenericAgentIcon,
  HistoryIcon,
  PlayIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { PixelLoaderRings } from '../workspace/PixelLoaderRings';
import {
  agentForWorkflow,
  formatAgo,
  formatCountdown,
  formatElapsed,
  describeSchedule,
  type ProgressLine,
  type Workflow,
} from '../../lib/workflows';

interface WorkflowRowProps {
  workflow: Workflow;
  /** Live activity for this workflow, oldest first. */
  progress: ProgressLine[];
  isExpanded: boolean;
  onToggleExpanded: (workflow: Workflow) => void;
  /**
   * Whether any workflow in the list has an auto-run switch. Only then is the
   * empty slot worth holding — with an all-manual list it reserves space for a
   * control that appears nowhere.
   */
  reserveToggleSlot: boolean;
  onEdit: (workflow: Workflow) => void;
  onRunNow: (workflow: Workflow) => void;
  onToggleAutoRun: (workflow: Workflow, autoRun: boolean) => void;
  onOpenHistory: (workflow: Workflow) => void;
}

function AgentGlyph({ agentId }: { agentId: string | null }) {
  if (agentId === 'claude-code') return <ClaudeIcon size={12} />;
  if (agentId === 'codex') return <CodexIcon size={12} />;
  return <GenericAgentIcon size={12} />;
}

/** "1 finding 18m ago" / "Running · 1m 12s" / "Never run". */
function lastRunLabel(workflow: Workflow): string {
  if (workflow.isRunning) {
    // A workflow run is 30s–2min of silence. Elapsed time is the difference
    // between "it's working" and "is this thing broken?".
    return workflow.runningSince === null
      ? 'Running'
      : `Running · ${formatElapsed(workflow.runningSince)}`;
  }
  const run = workflow.runs[0];
  if (!run) return 'Never run';
  if (run.status === 'failed') return `Failed ${formatAgo(run.startedAt)}`;
  if (run.findings === 0) return `Clean ${formatAgo(run.startedAt)}`;
  const plural = run.findings === 1 ? 'finding' : 'findings';
  return `${run.findings} ${plural} ${formatAgo(run.startedAt)}`;
}

export function WorkflowRow({
  workflow,
  progress,
  isExpanded,
  onToggleExpanded,
  reserveToggleSlot,
  onEdit,
  onRunNow,
  onToggleAutoRun,
  onOpenHistory,
}: WorkflowRowProps) {
  const agent = agentForWorkflow(workflow.agentId);
  // Authority is the backend's in-flight set, not the newest run record: a run
  // started in another window has no local record yet but is still running.
  const isRunning = workflow.isRunning;
  const lastStatus = workflow.runs[0]?.status ?? 'ok';

  // A manual workflow has no trigger to arm, so it shows no auto-run switch.
  const canAutoRun = workflow.trigger.kind !== 'manual';
  const isArmed = canAutoRun && workflow.autoRun;
  const countdown = isArmed ? formatCountdown(workflow.nextRunAt) : null;

  const dotState = isRunning
    ? 'running'
    : lastStatus === 'failed'
      ? 'failed'
      : canAutoRun && !workflow.autoRun
        ? 'off'
        : 'ok';

  const latest = progress.length > 0 ? progress[progress.length - 1] : null;

  return (
    <div className={`workflow-row${isExpanded ? ' is-expanded' : ''}`}>
      <div className="workflow-row-main-line">
        <button
          type="button"
          className="workflow-row-main"
          onClick={() => onEdit(workflow)}
          aria-label={`Edit ${workflow.name}`}
        >
          <span className="workflow-row-mark">
            {isRunning ? (
              <PixelLoaderRings size="sm" label={`${workflow.name} is running`} />
            ) : workflow.icon ? (
              <span className="workflow-row-icon" aria-hidden>
                {workflow.icon}
              </span>
            ) : (
              <span className="workflow-row-dot" data-state={dotState} aria-hidden />
            )}
          </span>

          <span className="workflow-row-body">
            <span className="workflow-row-title-line">
              <span className="workflow-row-name">{workflow.name}</span>
              {workflow.permission === 'can-edit' && (
                <span className="workflow-badge workflow-badge--edit">Can edit</span>
              )}
            </span>

            <span className="workflow-row-description">{workflow.description}</span>

            <span className="workflow-row-meta">
              <span className="workflow-row-meta-item">{workflow.projectName}</span>
              <span className="workflow-row-meta-sep" aria-hidden>
                ·
              </span>
              <span className="workflow-row-meta-item workflow-row-agent">
                <AgentGlyph agentId={workflow.agentId} />
                {agent.displayName}
              </span>
              <span className="workflow-row-meta-sep" aria-hidden>
                ·
              </span>
              <span className="workflow-row-meta-item">{describeSchedule(workflow)}</span>
            </span>
          </span>
        </button>

        <div className="workflow-row-side">
          {progress.length > 0 && (
            <IconButton
              variant="ghost"
              size="compact"
              className={`workflow-row-expand${isExpanded ? ' is-open' : ''}`}
              icon={<ChevronIcon size={10} />}
              onClick={() => onToggleExpanded(workflow)}
              title={isExpanded ? 'Hide activity' : 'Show what it is doing'}
              aria-label={isExpanded ? 'Hide activity' : 'Show what it is doing'}
              aria-expanded={isExpanded}
            />
          )}
          <div className="workflow-row-status">
            <span className="workflow-row-last" data-state={dotState}>
              {lastRunLabel(workflow)}
            </span>
            {countdown && <span className="workflow-row-next">Due {countdown}</span>}
          </div>

          <div className="workflow-row-actions">
            <IconButton
              variant="ghost"
              size="compact"
              className="workflow-row-history"
              icon={<HistoryIcon size={12} />}
              onClick={() => onOpenHistory(workflow)}
              title="Run history"
              aria-label={`Run history for ${workflow.name}`}
            />
            <Button
              variant="secondary"
              size="compact"
              leftIcon={<PlayIcon size={12} />}
              onClick={() => onRunNow(workflow)}
              disabled={isRunning}
            >
              {isRunning ? 'Running' : 'Run'}
            </Button>
            {canAutoRun ? (
              <button
                type="button"
                className={`settings-toggle ${workflow.autoRun ? 'on' : 'off'}`}
                role="switch"
                aria-checked={workflow.autoRun}
                aria-label={`Auto-run ${workflow.name}`}
                title={workflow.autoRun ? 'Auto-run on' : 'Auto-run off'}
                onClick={() => onToggleAutoRun(workflow, !workflow.autoRun)}
              >
                <span className="settings-toggle-track">
                  <span className="settings-toggle-thumb" />
                </span>
              </button>
            ) : (
              /* A manual workflow has no switch. The empty slot keeps Run in one
                 column down a mixed list, but reserves space for nothing when
                 every workflow is manual — so it's only held when some row in
                 the list actually has a switch. */
              reserveToggleSlot && <span className="workflow-row-toggle-slot" aria-hidden />
            )}
          </div>
        </div>
      </div>

      {/* One line by default — enough to know it's doing something sensible
          without turning the list into a log viewer. The rest is behind the
          chevron. */}
      {latest && !isExpanded && (
        <button
          type="button"
          className="workflow-row-activity-peek"
          onClick={() => onToggleExpanded(workflow)}
        >
          <span className="workflow-row-activity-text">{latest.text}</span>
        </button>
      )}

      {isExpanded && (
        <ol className="workflow-row-activity" aria-label={`${workflow.name} activity`}>
          {progress.map((line) => (
            <li key={`${line.at}-${line.text}`} className="workflow-row-activity-line">
              {line.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
