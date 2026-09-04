/**
 * One routine in the Routines list.
 *
 * Run is the primary action and is always visible: a routine is something you
 * press, and auto-run is an opt-in on top of that. There is deliberately no
 * "missed" state — see the RoutineTrigger docs in `lib/routines`.
 *
 * PROTOTYPE. Actions mutate the in-memory store in `lib/routinesStore` only.
 *
 * @module components/routines/RoutineRow
 */

import { ClaudeIcon, CodexIcon, GenericAgentIcon, HistoryIcon, PlayIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Spinner } from '../primitives/Spinner';
import {
  agentForRoutine,
  formatAgo,
  formatCountdown,
  describeSchedule,
  type Routine,
} from '../../lib/routines';

interface RoutineRowProps {
  routine: Routine;
  onEdit: (routine: Routine) => void;
  onRunNow: (routine: Routine) => void;
  onToggleAutoRun: (routine: Routine, autoRun: boolean) => void;
  onOpenHistory: (routine: Routine) => void;
}

function AgentGlyph({ agentId }: { agentId: string | null }) {
  if (agentId === 'claude-code') return <ClaudeIcon size={12} />;
  if (agentId === 'codex') return <CodexIcon size={12} />;
  return <GenericAgentIcon size={12} />;
}

/** "1 finding 18m ago" / "Running now" / "Never run". */
function lastRunLabel(routine: Routine): string {
  if (routine.isRunning) return 'Running now';
  const run = routine.runs[0];
  if (!run) return 'Never run';
  if (run.status === 'failed') return `Failed ${formatAgo(run.startedAt)}`;
  if (run.findings === 0) return `Clean ${formatAgo(run.startedAt)}`;
  const plural = run.findings === 1 ? 'finding' : 'findings';
  return `${run.findings} ${plural} ${formatAgo(run.startedAt)}`;
}

export function RoutineRow({
  routine,
  onEdit,
  onRunNow,
  onToggleAutoRun,
  onOpenHistory,
}: RoutineRowProps) {
  const agent = agentForRoutine(routine.agentId);
  // Authority is the backend's in-flight set, not the newest run record: a run
  // started in another window has no local record yet but is still running.
  const isRunning = routine.isRunning;
  const lastStatus = routine.runs[0]?.status ?? 'ok';

  // A manual routine has no trigger to arm, so it shows no auto-run switch.
  const canAutoRun = routine.trigger.kind !== 'manual';
  const isArmed = canAutoRun && routine.autoRun;
  const countdown = isArmed ? formatCountdown(routine.nextRunAt) : null;

  const dotState = isRunning
    ? 'running'
    : lastStatus === 'failed'
      ? 'failed'
      : canAutoRun && !routine.autoRun
        ? 'off'
        : 'ok';

  return (
    <div className="routine-row">
      <button
        type="button"
        className="routine-row-main"
        onClick={() => onEdit(routine)}
        aria-label={`Edit ${routine.name}`}
      >
        <span className="routine-row-dot" data-state={dotState} aria-hidden />

        <span className="routine-row-body">
          <span className="routine-row-title-line">
            <span className="routine-row-name">{routine.name}</span>
            {routine.permission === 'can-edit' && (
              <span className="routine-badge routine-badge--edit">Can edit</span>
            )}
          </span>

          <span className="routine-row-description">{routine.description}</span>

          <span className="routine-row-meta">
            <span className="routine-row-meta-item">{routine.projectName}</span>
            <span className="routine-row-meta-sep" aria-hidden>
              ·
            </span>
            <span className="routine-row-meta-item routine-row-agent">
              <AgentGlyph agentId={routine.agentId} />
              {agent.displayName}
            </span>
            <span className="routine-row-meta-sep" aria-hidden>
              ·
            </span>
            <span className="routine-row-meta-item">{describeSchedule(routine)}</span>
          </span>
        </span>
      </button>

      <div className="routine-row-side">
        <div className="routine-row-status">
          <span className="routine-row-last" data-state={dotState}>
            {isRunning && <Spinner size="sm" />}
            {lastRunLabel(routine)}
          </span>
          {countdown && <span className="routine-row-next">Due {countdown}</span>}
        </div>

        <div className="routine-row-actions">
          <IconButton
            variant="ghost"
            size="compact"
            className="routine-row-history"
            icon={<HistoryIcon size={12} />}
            onClick={() => onOpenHistory(routine)}
            title="Run history"
            aria-label={`Run history for ${routine.name}`}
          />
          <Button
            variant="secondary"
            size="compact"
            leftIcon={<PlayIcon size={12} />}
            onClick={() => onRunNow(routine)}
            disabled={isRunning}
          >
            {isRunning ? 'Running' : 'Run'}
          </Button>
          {canAutoRun ? (
            <button
              type="button"
              className={`settings-toggle ${routine.autoRun ? 'on' : 'off'}`}
              role="switch"
              aria-checked={routine.autoRun}
              aria-label={`Auto-run ${routine.name}`}
              title={routine.autoRun ? 'Auto-run on' : 'Auto-run off'}
              onClick={() => onToggleAutoRun(routine, !routine.autoRun)}
            >
              <span className="settings-toggle-track">
                <span className="settings-toggle-thumb" />
              </span>
            </button>
          ) : (
            /* A manual routine has no switch, but the slot is held so Run stays
               in the same column down the list. */
            <span className="routine-row-toggle-slot" aria-hidden />
          )}
        </div>
      </div>
    </div>
  );
}
