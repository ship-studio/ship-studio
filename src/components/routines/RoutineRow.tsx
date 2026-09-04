/**
 * One routine in the Routines list.
 *
 * Run is the primary action and is always visible: a routine is something you
 * press, and auto-run is an opt-in on top of that. There is deliberately no
 * "missed" state — see the RoutineTrigger docs in `lib/routines`.
 *
 * @module components/routines/RoutineRow
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
  agentForRoutine,
  formatAgo,
  formatCountdown,
  formatElapsed,
  describeSchedule,
  type ProgressLine,
  type Routine,
} from '../../lib/routines';

interface RoutineRowProps {
  routine: Routine;
  /** Live activity for this routine, oldest first. */
  progress: ProgressLine[];
  isExpanded: boolean;
  onToggleExpanded: (routine: Routine) => void;
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

/** "1 finding 18m ago" / "Running · 1m 12s" / "Never run". */
function lastRunLabel(routine: Routine): string {
  if (routine.isRunning) {
    // A routine run is 30s–2min of silence. Elapsed time is the difference
    // between "it's working" and "is this thing broken?".
    return routine.runningSince === null
      ? 'Running'
      : `Running · ${formatElapsed(routine.runningSince)}`;
  }
  const run = routine.runs[0];
  if (!run) return 'Never run';
  if (run.status === 'failed') return `Failed ${formatAgo(run.startedAt)}`;
  if (run.findings === 0) return `Clean ${formatAgo(run.startedAt)}`;
  const plural = run.findings === 1 ? 'finding' : 'findings';
  return `${run.findings} ${plural} ${formatAgo(run.startedAt)}`;
}

export function RoutineRow({
  routine,
  progress,
  isExpanded,
  onToggleExpanded,
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

  const latest = progress.length > 0 ? progress[progress.length - 1] : null;

  return (
    <div className={`routine-row${isExpanded ? ' is-expanded' : ''}`}>
      <div className="routine-row-main-line">
        <button
          type="button"
          className="routine-row-main"
          onClick={() => onEdit(routine)}
          aria-label={`Edit ${routine.name}`}
        >
          <span className="routine-row-mark">
            {isRunning ? (
              <PixelLoaderRings size="sm" label={`${routine.name} is running`} />
            ) : routine.icon ? (
              <span className="routine-row-icon" aria-hidden>
                {routine.icon}
              </span>
            ) : (
              <span className="routine-row-dot" data-state={dotState} aria-hidden />
            )}
          </span>

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
          {progress.length > 0 && (
            <IconButton
              variant="ghost"
              size="compact"
              className={`routine-row-expand${isExpanded ? ' is-open' : ''}`}
              icon={<ChevronIcon size={10} />}
              onClick={() => onToggleExpanded(routine)}
              title={isExpanded ? 'Hide activity' : 'Show what it is doing'}
              aria-label={isExpanded ? 'Hide activity' : 'Show what it is doing'}
              aria-expanded={isExpanded}
            />
          )}
          <div className="routine-row-status">
            <span className="routine-row-last" data-state={dotState}>
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

      {/* One line by default — enough to know it's doing something sensible
          without turning the list into a log viewer. The rest is behind the
          chevron. */}
      {latest && !isExpanded && (
        <button
          type="button"
          className="routine-row-activity-peek"
          onClick={() => onToggleExpanded(routine)}
        >
          <span className="routine-row-activity-text">{latest.text}</span>
        </button>
      )}

      {isExpanded && (
        <ol className="routine-row-activity" aria-label={`${routine.name} activity`}>
          {progress.map((line) => (
            <li key={`${line.at}-${line.text}`} className="routine-row-activity-line">
              {line.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
