/**
 * Run history for one routine, with the agent's reply.
 *
 * Showing the raw reply is the point: there is no hidden orchestration, and a
 * user who wants to know why a routine filed something should be able to read
 * exactly what came back rather than take the inbox item on trust.
 *
 * @module components/routines/RunHistoryModal
 */

import { useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import {
  formatAgo,
  formatDuration,
  formatTokens,
  type Routine,
  type RoutineRun,
} from '../../lib/routines';

interface RunHistoryModalProps {
  /** Mounted only while open, and keyed by routine, so selection seeds once. */
  routine: Routine;
  onClose: () => void;
}

const STATUS_LABEL: Record<RoutineRun['status'], string> = {
  ok: 'Clean',
  findings: 'Findings',
  failed: 'Failed',
  running: 'Running',
};

export function RunHistoryModal({ routine, onClose }: RunHistoryModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(routine.runs[0]?.id ?? null);

  const selected = routine.runs.find((run) => run.id === selectedId) ?? routine.runs[0] ?? null;

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title={`${routine.name} — run history`}
      className="run-history-modal"
    >
      <div className="run-history">
        <div className="run-history-list" role="list">
          {routine.runs.length === 0 && (
            <p className="run-history-empty text-style-hint">This routine has not run yet.</p>
          )}
          {routine.runs.map((run) => (
            <button
              key={run.id}
              type="button"
              role="listitem"
              className={`run-history-item${run.id === selected?.id ? ' is-selected' : ''}`}
              onClick={() => setSelectedId(run.id)}
            >
              <span className="run-history-item-dot" data-state={run.status} aria-hidden />
              <span className="run-history-item-body">
                <span className="run-history-item-status text-style-control-semibold">
                  {STATUS_LABEL[run.status]}
                  {run.findings > 0 && ` · ${run.findings}`}
                </span>
                <span className="run-history-item-meta text-style-hint">
                  {formatAgo(run.startedAt)}
                  {run.status !== 'running' && ` · ${formatDuration(run.durationMs)}`}
                  {/* Codex reports no usage, so most runs legitimately have no
                      token count — show it only when there is one. */}
                  {run.tokens !== null && ` · ${formatTokens(run.tokens)} tok`}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="run-history-transcript">
          {selected ? (
            <pre className="run-history-transcript-body">
              {selected.error ?? (selected.transcript || 'This run returned nothing.')}
            </pre>
          ) : (
            <p className="text-style-hint">Nothing to show.</p>
          )}
        </div>
      </div>

      <p className="run-history-note text-style-hint">
        The last 20 runs per routine are kept on this machine, in{' '}
        <code>~/ShipStudio/.shipstudio/routines-state.json</code>. Nothing is uploaded anywhere.
      </p>
    </ModalFrame>
  );
}
