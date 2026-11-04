/**
 * What an agent did in a project's session, as compact lines in its chat:
 * "Started a session in acme-marketing", "Sent to acme-marketing · Claude
 * Code 1", the session's reply, and preview screenshots inline. Recorded by
 * the backend (`agents/sessions.rs`) from what the shared Remote Access tools
 * actually saw; nothing here is inferred.
 *
 * "Open session" opens the project with that tab selected, so the user can
 * carry on the very same conversation.
 *
 * @module components/agents/AgentSession
 */

import { memo } from 'react';
import { GlobeIcon, TerminalIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { folderName, sessionLabel, type Agent, type AgentMessage } from '../../lib/agents';
import { openAgentSession } from '../../hooks/useRemoteAgentControl';
import { useAgentProjects } from './AgentProject';
import { MessageAttachments } from './AgentAttachments';

interface SessionCardProps {
  message: AgentMessage;
  agent: Agent;
  arrived?: boolean;
}

/** Memoised like every chat row: a draft or status event doesn't re-render it. */
export const SessionCard = memo(function SessionCard({
  message,
  agent,
  arrived,
}: SessionCardProps) {
  const ctx = useAgentProjects();
  const mark = message.session;
  if (!mark) return null;
  const project =
    ctx?.projects?.find((p) => p.path === mark.project)?.name ?? folderName(mark.project);
  const tab = sessionLabel(mark);
  const sessionId = mark.sessionId;
  const line = mark.event === 'started' || mark.event === 'sent';
  const open = sessionId ? (
    <TextButton
      tabIndex={0}
      // The line already leads with the terminal icon.
      leftIcon={line ? undefined : <TerminalIcon size={12} />}
      onClick={() => openAgentSession(mark.project, sessionId)}
    >
      Open session
    </TextButton>
  ) : (
    ctx && (
      <TextButton
        tabIndex={0}
        leftIcon={<GlobeIcon size={12} />}
        onClick={() => ctx.openProject(mark.project)}
      >
        Open preview
      </TextButton>
    )
  );
  const shared = {
    'data-arrived': arrived || undefined,
    'data-message-ids': message.id,
  };

  if (line) {
    return (
      <div className="agent-session" data-event={mark.event} {...shared}>
        <span className="agent-peer__line" title={message.text || undefined}>
          <TerminalIcon size={12} />
          {mark.event === 'started' ? (
            <>Started a session in {project}</>
          ) : (
            <>
              Sent to {project} · {tab}
            </>
          )}
        </span>
        {open}
      </div>
    );
  }

  return (
    <div className="agent-changes agent-session-card" data-event={mark.event} {...shared}>
      <div className="agent-changes__head">
        <span className="agent-changes__summary">
          {mark.event === 'reply' ? `${project} · ${tab}` : `${project} · ${message.text}`}
        </span>
      </div>
      {mark.event === 'reply' ? (
        <p className="agent-session-card__reply">{message.text}</p>
      ) : (
        message.attachments && (
          <MessageAttachments agent={agent} attachments={message.attachments} side="agent" />
        )
      )}
      <div className="agent-changes__actions">{open}</div>
    </div>
  );
});
