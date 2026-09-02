/**
 * Studio Talk — the visible half of cross-project agent exchanges.
 *
 * When one project's agent asks another project a question (the `studio_ask`
 * MCP tool), the whole exchange must be watchable, not a silent subprocess:
 * this section shows live exchanges in the workspace sidebar (direction,
 * spinner, the answering agent's current activity), and a transcript modal
 * holds the full conversation history for review.
 */

import { useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { useModal, useOpenModal } from '../../contexts/ModalContext';
import { useCommands } from '../../commands/useCommands';
import { useStudioExchanges } from '../../hooks/useStudioExchanges';
import { basename } from '../../lib/paths';
import { formatRelativeTime } from '../../lib/branches';
import type { StudioExchange } from '../../lib/studioTalk';
import '../../styles/features/workspace/studio-talk.css';

/** Live rows shown inline in the sidebar before "view all" takes over. */
const MAX_SIDEBAR_ROWS = 3;

function TalkIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 8h3a1 1 0 0 1 1 1v9l-3-3h-6a1 1 0 0 1-1-1v-1" />
      <path d="M14 4H4a1 1 0 0 0-1 1v9l3-3h7a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z" />
    </svg>
  );
}

function latestActivityText(exchange: StudioExchange): string {
  const last = exchange.activity[exchange.activity.length - 1];
  return last ? last.text : 'Starting…';
}

function statusSummary(exchange: StudioExchange): string {
  switch (exchange.status) {
    case 'running':
      return latestActivityText(exchange);
    case 'completed':
      return `Answered ${exchange.finishedAtMs ? formatRelativeTime(exchange.finishedAtMs) : ''}`.trim();
    case 'failed':
      return `Failed ${exchange.finishedAtMs ? formatRelativeTime(exchange.finishedAtMs) : ''}`.trim();
  }
}

function ExchangeDirection({ exchange }: { exchange: StudioExchange }) {
  return (
    <span className="studio-talk-direction">
      <span className="studio-talk-project">{basename(exchange.fromProject)}</span>
      <span className="studio-talk-arrow" aria-hidden="true">
        →
      </span>
      <span className="studio-talk-project">{basename(exchange.toProject)}</span>
    </span>
  );
}

function StatusGlyph({ status }: { status: StudioExchange['status'] }) {
  if (status === 'running') return <Spinner size="sm" />;
  return (
    <span className={`studio-talk-glyph is-${status}`} aria-hidden="true">
      {status === 'completed' ? '✓' : '✕'}
    </span>
  );
}

interface Props {
  /** Canonical path of the workspace's project — its exchanges sort first. */
  currentProjectPath: string | null;
}

export function StudioTalkSection({ currentProjectPath }: Props) {
  const exchanges = useStudioExchanges();
  const modal = useModal('studioTalk');
  const openModal = useOpenModal();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useCommands(
    () => [
      {
        id: 'studioTalk.viewExchanges',
        title: 'View project talk exchanges',
        icon: <TalkIcon size={14} />,
        category: 'project',
        when: 'project',
        keywords: ['studio', 'talk', 'ask', 'cross-project', 'agent', 'exchange', 'conversation'],
        run: () => openModal('studioTalk'),
      },
    ],
    [openModal]
  );

  // Exchanges touching the current project first, then the rest; running
  // before finished within each bucket. `useStudioExchanges` already sorts
  // newest-first, and this sort is stable, so recency is the tiebreaker.
  const sorted = [...exchanges].sort((a, b) => {
    const involvesA =
      currentProjectPath !== null &&
      (a.fromProject === currentProjectPath || a.toProject === currentProjectPath);
    const involvesB =
      currentProjectPath !== null &&
      (b.fromProject === currentProjectPath || b.toProject === currentProjectPath);
    if (involvesA !== involvesB) return involvesA ? -1 : 1;
    const runningA = a.status === 'running';
    const runningB = b.status === 'running';
    if (runningA !== runningB) return runningA ? -1 : 1;
    return 0;
  });

  const selected = sorted.find((e) => e.id === selectedId) ?? sorted[0] ?? null;

  const openTranscript = (id: number) => {
    setSelectedId(id);
    modal.open();
  };

  return (
    <>
      {sorted.length > 0 && (
        <section className="studio-talk-section" aria-label="Project talk">
          <header className="studio-talk-header">
            <span className="studio-talk-header-icon">
              <TalkIcon />
            </span>
            <span className="studio-talk-header-label">Project Talk</span>
            {sorted.some((e) => e.status === 'running') && (
              <span className="studio-talk-live-badge">live</span>
            )}
          </header>
          <ul className="studio-talk-list">
            {sorted.slice(0, MAX_SIDEBAR_ROWS).map((exchange) => (
              <li key={exchange.id}>
                <button
                  type="button"
                  className={`studio-talk-row is-${exchange.status}`}
                  onClick={() => openTranscript(exchange.id)}
                  title="Open transcript"
                >
                  <span className="studio-talk-row-top">
                    <StatusGlyph status={exchange.status} />
                    <ExchangeDirection exchange={exchange} />
                  </span>
                  <span className="studio-talk-row-detail">{statusSummary(exchange)}</span>
                </button>
              </li>
            ))}
          </ul>
          {sorted.length > MAX_SIDEBAR_ROWS && (
            <button type="button" className="studio-talk-view-all" onClick={() => modal.open()}>
              View all {sorted.length}
            </button>
          )}
        </section>
      )}

      <ModalFrame
        isOpen={modal.isOpen}
        onClose={modal.close}
        title="Project Talk"
        className="studio-talk-modal"
      >
        {sorted.length === 0 ? (
          <p className="studio-talk-empty">
            No exchanges yet. When an agent in one project asks another project a question (the
            studio_ask tool), the conversation shows up here live.
          </p>
        ) : (
          <div className="studio-talk-modal-body">
            {sorted.length > 1 && (
              <div className="studio-talk-picker" role="tablist" aria-label="Exchanges">
                {sorted.map((exchange) => (
                  <button
                    key={exchange.id}
                    type="button"
                    role="tab"
                    aria-selected={selected?.id === exchange.id}
                    className={`studio-talk-chip ${selected?.id === exchange.id ? 'is-selected' : ''}`}
                    onClick={() => setSelectedId(exchange.id)}
                  >
                    <StatusGlyph status={exchange.status} />
                    <ExchangeDirection exchange={exchange} />
                    <span className="studio-talk-chip-time">
                      {formatRelativeTime(exchange.startedAtMs)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {selected && <ExchangeTranscript exchange={selected} />}
          </div>
        )}
      </ModalFrame>
    </>
  );
}

function ExchangeTranscript({ exchange }: { exchange: StudioExchange }) {
  return (
    <div className="studio-talk-transcript">
      <div className="studio-talk-transcript-block">
        <div className="studio-talk-block-label">
          {basename(exchange.fromProject)} asked {basename(exchange.toProject)}
        </div>
        <div className="studio-talk-question">{exchange.question}</div>
      </div>

      {exchange.activity.length > 0 && (
        <div className="studio-talk-transcript-block">
          <div className="studio-talk-block-label">Activity</div>
          <ul className="studio-talk-activity">
            {exchange.activity.map((entry, i) => (
              <li key={i} className={`studio-talk-activity-line is-${entry.kind}`}>
                {entry.text}
              </li>
            ))}
            {exchange.status === 'running' && (
              <li className="studio-talk-activity-line is-live">
                <Spinner size="sm" /> Working…
              </li>
            )}
          </ul>
        </div>
      )}

      {exchange.answer !== null && (
        <div className="studio-talk-transcript-block">
          <div className="studio-talk-block-label">Answer</div>
          <div className="studio-talk-answer">{exchange.answer}</div>
        </div>
      )}
      {exchange.error !== null && (
        <div className="studio-talk-transcript-block">
          <div className="studio-talk-block-label">Error</div>
          <div className="studio-talk-error">{exchange.error}</div>
        </div>
      )}
    </div>
  );
}
