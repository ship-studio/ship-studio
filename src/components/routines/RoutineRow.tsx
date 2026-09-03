/**
 * One routine in the Routines list.
 *
 * PROTOTYPE. Actions mutate the in-memory store in `lib/routinesStore` only.
 *
 * @module components/routines/RoutineRow
 */

import { ClaudeIcon, CodexIcon, GenericAgentIcon, HistoryIcon, PlayIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { Spinner } from '../primitives/Spinner';
import {
  agentForRoutine,
  formatAgo,
  formatCountdown,
  formatTrigger,
  type Routine,
} from '../../lib/routines';

interface RoutineRowProps {
  routine: Routine;
  onEdit: (routine: Routine) => void;
  onRunNow: (routine: Routine) => void;
  onToggle: (routine: Routine, enabled: boolean) => void;
  onOpenHistory: (routine: Routine) => void;
}

function AgentGlyph({ agentId }: { agentId: string }) {
  if (agentId === 'claude-code') return <ClaudeIcon size={12} />;
  if (agentId === 'codex') return <CodexIcon size={12} />;
  return <GenericAgentIcon size={12} />;
}

/** "18m ago — 1 finding" / "Running now" / "Missed a window". */
function lastRunLabel(routine: Routine): string {
  const run = routine.runs[0];
  if (run?.status === 'running') return 'Running now';
  if (routine.enabled && routine.missedSince !== null) {
    return `Missed ${formatAgo(routine.missedSince)}`;
  }
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
  onToggle,
  onOpenHistory,
}: RoutineRowProps) {
  const agent = agentForRoutine(routine.agentId);
  const isRunning = routine.runs[0]?.status === 'running';
  const lastStatus = routine.runs[0]?.status ?? 'ok';
  const countdown = routine.enabled ? formatCountdown(routine.nextRunAt) : null;

  const isMissed = routine.enabled && routine.missedSince !== null && !isRunning;

  // The dot answers "is this routine healthy", not "did it find something".
  // A routine that reports findings is working correctly, so it stays green
  // and the count beside it carries the news.
  const dotState = isRunning
    ? 'running'
    : !routine.enabled
      ? 'off'
      : isMissed
        ? 'missed'
        : lastStatus === 'failed'
          ? 'failed'
          : 'ok';

  return (
    <div className={`routine-row${routine.enabled ? '' : ' is-disabled'}`}>
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
            {!routine.enabled && <span className="routine-badge">Paused</span>}
          </span>

          <span className="routine-row-description">{routine.description}</span>

          <span className="routine-row-meta">
            <span className="routine-row-meta-item">
              {routine.scope.kind === 'all-projects' ? 'All projects' : routine.scope.projectName}
            </span>
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
            <span className="routine-row-meta-item">{formatTrigger(routine.trigger)}</span>
          </span>
        </span>
      </button>

      <div className="routine-row-side">
        <div className="routine-row-status">
          <span className="routine-row-last" data-state={dotState}>
            {isRunning && <Spinner size="sm" />}
            {lastRunLabel(routine)}
          </span>
          {isMissed ? (
            <span className="routine-row-next">
              {routine.catchUpOnLaunch ? 'Catches up on next launch' : 'Skipped that window'}
            </span>
          ) : (
            countdown && <span className="routine-row-next">Next {countdown}</span>
          )}
        </div>

        <div className="routine-row-actions">
          <IconButton
            variant="ghost"
            size="compact"
            icon={<HistoryIcon size={12} />}
            onClick={() => onOpenHistory(routine)}
            title="Run history"
            aria-label={`Run history for ${routine.name}`}
          />
          <IconButton
            variant="secondary"
            size="compact"
            icon={<PlayIcon size={12} />}
            onClick={() => onRunNow(routine)}
            disabled={isRunning}
            title="Run now"
            aria-label={`Run ${routine.name} now`}
          />
          <button
            type="button"
            className={`settings-toggle ${routine.enabled ? 'on' : 'off'}`}
            role="switch"
            aria-checked={routine.enabled}
            aria-label={`${routine.enabled ? 'Pause' : 'Enable'} ${routine.name}`}
            onClick={() => onToggle(routine, !routine.enabled)}
          >
            <span className="settings-toggle-track">
              <span className="settings-toggle-thumb" />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
