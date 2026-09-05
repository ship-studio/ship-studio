/**
 * Run history for one workflow, with the agent's reply.
 *
 * Showing the raw reply is the point: there is no hidden orchestration, and a
 * user who wants to know why a workflow filed something should be able to read
 * exactly what came back rather than take the inbox item on trust.
 *
 * @module components/workflows/RunHistoryModal
 */

import { useCallback, useRef, useState } from 'react';
import { AlertIcon } from '@/components/icons';
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
  const listRef = useRef<HTMLDivElement | null>(null);

  const selected = workflow.runs.find((run) => run.id === selectedId) ?? workflow.runs[0] ?? null;

  /** ↑/↓ through the runs, as in the Inbox. Reading is the job here too. */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const index = workflow.runs.findIndex((run) => run.id === selected?.id);
      const next =
        workflow.runs[
          Math.min(
            workflow.runs.length - 1,
            Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1))
          )
        ];
      if (!next) return;
      setSelectedId(next.id);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(next.id)}"]`)
        ?.focus();
    },
    [workflow.runs, selected]
  );

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title={`${workflow.name} — run history`}
      className="run-history-modal"
    >
      <div className="run-history">
        {/* A listbox, not a list: `role="listitem"` on a button replaces the
            button role and the row stops being announced as activatable. */}
        <div
          className="run-history-list"
          role="listbox"
          aria-label={`${workflow.name} runs`}
          aria-activedescendant={selected ? `run-${selected.id}` : undefined}
          ref={listRef}
          onKeyDown={handleKeyDown}
        >
          {workflow.runs.length === 0 && (
            <p className="run-history-empty text-style-hint">This workflow has not run yet.</p>
          )}
          {workflow.runs.map((run) => (
            <button
              key={run.id}
              id={`run-${run.id}`}
              data-run-id={run.id}
              type="button"
              role="option"
              aria-selected={run.id === selected?.id}
              tabIndex={run.id === selected?.id ? 0 : -1}
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
            <>
              {/* A failure is not a transcript. It gets said plainly, at the
                  top, rather than being the only thing in a box labelled
                  "what the agent replied". */}
              {selected.error && (
                <p className="run-history-error">
                  <AlertIcon size={12} />
                  <span>{selected.error}</span>
                </p>
              )}
              <pre className="run-history-transcript-body">
                {selected.transcript ||
                  (selected.error
                    ? 'The run failed before the agent replied.'
                    : 'This run returned nothing.')}
              </pre>
            </>
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
