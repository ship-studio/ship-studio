/**
 * Run history for one workflow, with the agent's reply.
 *
 * Showing the raw reply is the point: there is no hidden orchestration, and a
 * user who wants to know why a workflow filed something should be able to read
 * exactly what came back rather than take the inbox item on trust.
 *
 * @module components/workflows/RunHistoryModal
 */

import { useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import {
  formatAgo,
  formatDuration,
  formatTokens,
  type Workflow,
  type WorkflowRun,
} from '../../lib/workflows';

interface RunHistoryModalProps {
  /** Mounted only while open, and keyed by workflow, so selection seeds once. */
  workflow: Workflow;
  onClose: () => void;
}

const STATUS_LABEL: Record<WorkflowRun['status'], string> = {
  ok: 'Clean',
  findings: 'Findings',
  failed: 'Failed',
  running: 'Running',
};

export function RunHistoryModal({ workflow, onClose }: RunHistoryModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(workflow.runs[0]?.id ?? null);

  const selected = workflow.runs.find((run) => run.id === selectedId) ?? workflow.runs[0] ?? null;

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title={`${workflow.name} — run history`}
      className="run-history-modal"
    >
      <div className="run-history">
        <div className="run-history-list" role="list">
          {workflow.runs.length === 0 && (
            <p className="run-history-empty text-style-hint">This workflow has not run yet.</p>
          )}
          {workflow.runs.map((run) => (
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
        The last 20 runs per workflow are kept on this machine, in{' '}
        <code>~/ShipStudio/.shipstudio/workflows-state.json</code>. Nothing is uploaded anywhere.
      </p>
    </ModalFrame>
  );
}
