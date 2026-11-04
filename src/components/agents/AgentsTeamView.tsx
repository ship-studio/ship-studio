/**
 * Team: what's in flight across every agent, in one calm column. Who is
 * working (with what they're doing), who needs you (approval cards you can
 * answer here, and turns that didn't finish, with their one next step), what's scheduled next, and the latest replies. Every row
 * opens that conversation; a reply opens it at that line.
 *
 * Everything comes from the store: statuses and check-ins from the registry,
 * cards and replies from each chat's recent lines. A chat that's open this
 * session is already live in the store; for the rest this reads the last
 * few lines, again whenever that agent's row changes. Nothing is inferred.
 *
 * @module components/agents/AgentsTeamView
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CollaboratorsIcon } from '@/components/icons';
import { CompactModeToggle } from '../workspace/ModeToggle';
import { PixelLoaderRings } from '../workspace/PixelLoaderRings';
import { AgentAvatar } from './AgentAvatar';
import { ApprovalCard, ErrorLine } from './AgentChatItems';
import { AgentMark, AgentSwitcher } from './AgentSwitcher';
import { useHeightReveal } from './useAgentMotion';
import {
  answerApproval,
  createCheckIn,
  failedTurn,
  failureLine,
  formatHitTime,
  formatWhen,
  getAgentMessages,
  lastUserMessage,
  needsYou,
  replyPreview,
  resendable,
  retryNote,
  sendAgentMessage,
  summarizeTeam,
  TEAM_ID,
  whenAt,
  type Agent,
  type AgentMessage,
} from '../../lib/agents';
import { MESSAGE_PAGE, refreshAgents, upsertMessage, useAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

/** Lines read per chat: enough for its latest reply. A chat with a card open reads a page. */
const RECENT_LINES = 20;

/**
 * The recent lines of every chat that isn't loaded in the store, refetched
 * when its row says something happened there.
 */
function useRecentLines(agents: Agent[], loaded: Record<string, AgentMessage[]>) {
  const [fetched, setFetched] = useState<Record<string, { key: string; lines: AgentMessage[] }>>(
    {}
  );
  const wanted = agents
    .filter((a) => !a.hidden && !loaded[a.id])
    .map((a) => ({
      id: a.id,
      key: `${a.lastActivityAt}:${a.pendingApprovals}:${a.failure?.kind ?? ''}`,
      cards: a.pendingApprovals > 0,
    }));
  const signature = wanted.map((w) => `${w.id}@${w.key}`).join(' ');

  useEffect(() => {
    let live = true;
    for (const w of wanted) {
      if (fetched[w.id]?.key === w.key) continue;
      getAgentMessages(w.id, w.cards ? MESSAGE_PAGE : RECENT_LINES)
        .then((lines) => {
          if (live) setFetched((current) => ({ ...current, [w.id]: { key: w.key, lines } }));
        })
        .catch(() => {
          /* that chat just doesn't contribute; its row still opens it */
        });
    }
    return () => {
      live = false;
    };
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    const merged: Record<string, AgentMessage[]> = {};
    for (const [id, entry] of Object.entries(fetched)) merged[id] = entry.lines;
    return { ...merged, ...loaded };
  }, [fetched, loaded]);
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactNode[];
}) {
  return (
    <section className="agents-team__section" aria-label={title}>
      <h3 className="agents-team__heading">{title}</h3>
      {children.length > 0 ? children : <p className="agents-team__empty">{empty}</p>}
    </section>
  );
}

interface RowProps {
  agent: Agent;
  line: string;
  meta?: ReactNode;
  state?: 'working' | 'waiting' | 'failed' | 'limited';
  onOpen: () => void;
}

function Row({ agent, line, meta, state, onOpen }: RowProps) {
  return (
    <button type="button" tabIndex={0} className="agents-team__row" onClick={onOpen}>
      <AgentAvatar name={agent.name} color={agent.color} />
      <span className="agents-team__text">
        <span className="agents-team__name">{agent.name}</span>
        <span className="agents-team__line" data-state={state}>
          {line}
        </span>
      </span>
      {meta && <span className="agents-team__meta">{meta}</span>}
    </button>
  );
}

/** Opens and closes its height with the chat's motion (see useHeightReveal). */
function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useHeightReveal(ref, open);
  return shown ? (
    <div ref={ref} className="agents-team__fold">
      {children}
    </div>
  ) : null;
}

/** How long an answered card shows what it resolved to before it folds away. */
const ANSWERED_HOLD_MS = 1200;
/** Then the fold's own motion; after it the card is forgotten. */
const FOLD_MS = 700;

/** A card answered here, kept on screen (resolved) for a beat so you see what you did. */
interface Held {
  agentId: string;
  message: AgentMessage;
  folding: boolean;
}

interface AgentsTeamViewProps {
  onOpenAgent: (agentId: string) => void;
  /** Open a chat at one of its lines. */
  onOpenMessage: (agentId: string, messageId: string) => void;
  /** The expired-login remedy on a failed turn. */
  onSignIn: () => void;
  /** Below the compact breakpoint there's no sidebar; the header switches agents. */
  compact?: { agents: Agent[]; onGoHome: () => void; onGoProjects: () => void };
}

export function AgentsTeamView({
  onOpenAgent,
  onOpenMessage,
  onSignIn,
  compact,
}: AgentsTeamViewProps) {
  const { agents, messages } = useAgents();
  const { showToast } = useOptionalToast();
  const lines = useRecentLines(agents, messages);
  const team = useMemo(() => summarizeTeam(agents, lines), [agents, lines]);
  const columnRef = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<Record<string, Held>>({});
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const toastError = (error: unknown) =>
    showToast(formatCommandError(asCommandError(error)), 'error');

  /** After answering, focus moves on to the next card's Allow, or the next row. */
  const focusNext = (from: HTMLElement | null) => {
    const column = columnRef.current;
    if (!column) return;
    const targets = Array.from(
      column.querySelectorAll<HTMLElement>('[data-allow]:not(:disabled), .agents-team__row')
    );
    const after = from
      ? targets.find((t) => from.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)
      : undefined;
    (after ?? targets[0])?.focus({ preventScroll: false });
  };

  const answer = async (
    agent: Agent,
    message: AgentMessage,
    allow: boolean,
    always?: boolean,
    note?: string
  ) => {
    const approval = message.approval;
    if (!approval) return;
    const card = columnRef.current?.querySelector<HTMLElement>(
      `[data-message-ids~="${CSS.escape(message.id)}"]`
    );
    try {
      await answerApproval(agent.id, approval.requestId, allow, always, note);
    } catch (error) {
      toastError(error);
      return;
    }
    const resolved: AgentMessage = {
      ...message,
      approval: {
        ...approval,
        status: allow ? 'allowed' : 'denied',
        alwaysAllowed: always && allow ? true : approval.alwaysAllowed,
        note: allow ? undefined : note?.trim() || undefined,
      },
    };
    setHeld((h) => ({
      ...h,
      [message.id]: { agentId: agent.id, message: resolved, folding: false },
    }));
    requestAnimationFrame(() => focusNext(card ?? null));
    timers.current.push(
      window.setTimeout(
        () =>
          setHeld((h) =>
            h[message.id] ? { ...h, [message.id]: { ...h[message.id], folding: true } } : h
          ),
        ANSWERED_HOLD_MS
      ),
      window.setTimeout(
        () =>
          setHeld((h) => {
            const { [message.id]: _gone, ...rest } = h;
            return rest;
          }),
        ANSWERED_HOLD_MS + FOLD_MS
      )
    );
  };

  const retry = async (agent: Agent, failure: AgentMessage) => {
    const chat = lines[agent.id] ?? [];
    const source = lastUserMessage(chat, chat.indexOf(failure));
    if (!source) return;
    try {
      const ids = (source.mentions ?? []).map((m) => m.id);
      upsertMessage(await sendAgentMessage(agent.id, source.text, resendable(agent, source), ids));
    } catch (error) {
      toastError(error);
    }
  };

  const retryAt = async (agent: Agent, failure: AgentMessage, at: number) => {
    const chat = lines[agent.id] ?? [];
    const source = lastUserMessage(chat, chat.indexOf(failure));
    try {
      await createCheckIn(agent.id, whenAt(at), retryNote(source?.text ?? ''));
      await refreshAgents();
    } catch (error) {
      toastError(error);
    }
  };

  // Needs you, with the cards just answered here still in their places.
  const groups = useMemo(() => {
    const byAgent = new Map(team.needsYou.map((g) => [g.agent.id, { ...g }]));
    for (const h of Object.values(held)) {
      const agent = agents.find((a) => a.id === h.agentId);
      if (!agent) continue;
      const group = byAgent.get(agent.id) ?? { agent, approvals: [], failure: null };
      group.approvals = [...group.approvals.filter((m) => m.id !== h.message.id), h.message].sort(
        (a, b) => a.ts - b.ts
      );
      byAgent.set(agent.id, group);
    }
    return [...byAgent.values()];
  }, [team.needsYou, held, agents]);

  const title = (
    <>
      <span className="agent-avatar agent-avatar--row agent-avatar--selected agents-team__badge">
        <CollaboratorsIcon size={14} />
      </span>
      <h2 className="agent-chat__name">Team</h2>
    </>
  );

  return (
    <section className="agent-chat agents-team" aria-label="Team">
      <header className="agent-chat__header">
        {compact && (
          <CompactModeToggle
            mode="agents"
            onProjects={compact.onGoProjects}
            className="agent-chat__mode"
          />
        )}
        {compact ? (
          <AgentSwitcher
            agents={compact.agents}
            currentId={TEAM_ID}
            title={title}
            label="Team. Switch agent"
            onOpenAgent={onOpenAgent}
            onGoHome={compact.onGoHome}
          />
        ) : (
          <div className="agent-chat__title">{title}</div>
        )}
      </header>

      <div className="agent-chat__scroll">
        <div className="agents-team__column" ref={columnRef}>
          <Section title="Needs you" empty="Nothing is waiting on you.">
            {groups.map(({ agent, approvals, failure }) => {
              const kind = failedTurn(agent);
              const pending = approvals.some((m) => m.approval?.status === 'pending');
              // The group folds with its last answered card, rather than vanish after it.
              const stays =
                pending ||
                Boolean(failure && kind) ||
                approvals.some((m) => held[m.id] && !held[m.id].folding) ||
                // Waiting on a card whose line hasn't loaded yet: the row alone.
                (needsYou(agent) && !approvals.some((m) => held[m.id]));
              return (
                <Fold key={agent.id} open={stays}>
                  <div className="agents-team__group">
                    <Row
                      agent={agent}
                      line={
                        pending || !kind
                          ? needsYou(agent) || pending
                            ? 'Needs your OK'
                            : 'Answered'
                          : failureLine(kind, agent.preview)
                      }
                      state={
                        pending || needsYou(agent)
                          ? 'waiting'
                          : kind
                            ? kind.kind === 'usage_limit'
                              ? 'limited'
                              : 'failed'
                            : undefined
                      }
                      meta={<AgentMark agent={agent} />}
                      onOpen={() => onOpenAgent(agent.id)}
                    />
                    {approvals.map((m) => (
                      <Fold key={m.id} open={!held[m.id]?.folding}>
                        <ApprovalCard
                          message={m}
                          agentName={agent.name}
                          paused={agent.status.state === 'idle'}
                          compact
                          onAnswer={(_requestId, allow, always, note) =>
                            answer(agent, m, allow, always, note)
                          }
                          arrived={false}
                        />
                      </Fold>
                    ))}
                    {failure && kind && !pending && (
                      <ErrorLine
                        message={failure}
                        onSignIn={onSignIn}
                        onRetry={() => void retry(agent, failure)}
                        onRetryAt={(at) => void retryAt(agent, failure, at)}
                        retryScheduled={(agent.checkIns ?? []).some(
                          (c) =>
                            !c.repeat &&
                            kind.resetsAt !== undefined &&
                            Math.abs(c.nextAt - kind.resetsAt) < 120_000
                        )}
                      />
                    )}
                  </div>
                </Fold>
              );
            })}
          </Section>

          <Section title="Working now" empty="No one is working right now.">
            {team.working.map((agent) => (
              <Row
                key={agent.id}
                agent={agent}
                line={agent.status.activity ?? 'Working…'}
                state="working"
                meta={<PixelLoaderRings size="sm" label={`${agent.name} is working`} />}
                onOpen={() => onOpenAgent(agent.id)}
              />
            ))}
          </Section>

          <Section title="Scheduled next" empty="Nothing is scheduled.">
            {team.scheduled.map(({ agent, checkIn }) => (
              <Row
                key={`${agent.id}-${checkIn.id}`}
                agent={agent}
                line={checkIn.note}
                meta={formatWhen(checkIn.nextAt)}
                onOpen={() => onOpenAgent(agent.id)}
              />
            ))}
          </Section>

          <Section title="Recent replies" empty="No replies yet.">
            {team.replies.map(({ agent, message }) => (
              <Row
                key={message.id}
                agent={agent}
                line={replyPreview(message.text)}
                meta={formatHitTime(message.ts)}
                onOpen={() => onOpenMessage(agent.id, message.id)}
              />
            ))}
          </Section>
        </div>
      </div>
    </section>
  );
}
