/**
 * Run history for one routine, with the headless transcript.
 *
 * PROTOTYPE. Transcripts are fixtures written to look like what
 * `claude --print --output-format stream-json` actually produces, because the
 * point of showing them is that there is no hidden orchestration.
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
  missed: 'Missed',
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
                  {run.tokens > 0 && ` · ${formatTokens(run.tokens)} tok`}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="run-history-transcript">
          {selected ? (
            <pre className="run-history-transcript-body">{selected.transcript}</pre>
          ) : (
            <p className="text-style-hint">Nothing to show.</p>
          )}
        </div>
      </div>

      <p className="run-history-note text-style-hint">
        Stored under <code>{routine.filePath.replace(/routines\/.+$/, 'runs/')}</code>. Transcripts
        are kept for 30 days and never leave this machine.
      </p>
    </ModalFrame>
  );
}
