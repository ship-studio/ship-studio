/**
 * Team: what's in flight across every agent, in one calm column. Who is
 * working (with what they're doing), who needs you (approval cards you can
 * answer here), what's scheduled next, and the latest replies. Every row
 * opens that conversation; a reply opens it at that line.
 *
 * Everything comes from the store: statuses and check-ins from the registry,
 * cards and replies from each chat's recent lines. A chat that's open this
 * session is already live in the store; for the rest this reads the last
 * few lines, again whenever that agent's row changes. Nothing is inferred.
 *
 * @module components/agents/AgentsTeamView
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CollaboratorsIcon } from '@/components/icons';
import { CompactModeToggle } from '../workspace/ModeToggle';
import { PixelLoaderRings } from '../workspace/PixelLoaderRings';
import { AgentAvatar } from './AgentAvatar';
import { ApprovalCard } from './AgentChatItems';
import {
  answerApproval,
  formatHitTime,
  formatWhen,
  getAgentMessages,
  replyPreview,
  summarizeTeam,
  type Agent,
  type AgentMessage,
} from '../../lib/agents';
import { MESSAGE_PAGE, useAgents } from '../../lib/agentsStore';
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
      key: `${a.lastActivityAt}:${a.pendingApprovals}`,
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
  state?: 'working' | 'waiting';
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

interface AgentsTeamViewProps {
  onOpenAgent: (agentId: string) => void;
  /** Open a chat at one of its lines. */
  onOpenMessage: (agentId: string, messageId: string) => void;
  /** Below the compact breakpoint there's no sidebar; the header carries the mode toggle. */
  onGoProjects?: () => void;
}

export function AgentsTeamView({ onOpenAgent, onOpenMessage, onGoProjects }: AgentsTeamViewProps) {
  const { agents, messages } = useAgents();
  const { showToast } = useOptionalToast();
  const lines = useRecentLines(agents, messages);
  const team = useMemo(() => summarizeTeam(agents, lines), [agents, lines]);

  const answer = async (agentId: string, requestId: string, allow: boolean, always?: boolean) => {
    try {
      await answerApproval(agentId, requestId, allow, always);
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  return (
    <section className="agent-chat agents-team" aria-label="Team">
      <header className="agent-chat__header">
        {onGoProjects && (
          <CompactModeToggle mode="agents" onProjects={onGoProjects} className="agent-chat__mode" />
        )}
        <div className="agent-chat__title">
          <span className="agent-avatar agent-avatar--row agent-avatar--selected agents-team__badge">
            <CollaboratorsIcon size={14} />
          </span>
          <h2 className="agent-chat__name">Team</h2>
        </div>
      </header>

      <div className="agent-chat__scroll">
        <div className="agents-team__column">
          <Section title="Needs you" empty="Nothing is waiting on you.">
            {team.needsYou.map(({ agent, approvals }) => (
              <div key={agent.id} className="agents-team__group">
                <Row
                  agent={agent}
                  line="Needs your OK"
                  state="waiting"
                  onOpen={() => onOpenAgent(agent.id)}
                />
                {approvals.map((m) => (
                  <ApprovalCard
                    key={m.id}
                    message={m}
                    agentName={agent.name}
                    paused={agent.status.state === 'idle'}
                    onAnswer={(requestId, allow, always) =>
                      answer(agent.id, requestId, allow, always)
                    }
                    arrived={false}
                  />
                ))}
              </div>
            ))}
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
