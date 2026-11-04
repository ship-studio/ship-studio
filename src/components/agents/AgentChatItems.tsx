/**
 * The pieces a conversation is made of: bubbles, the centred lines where
 * agents talked to each other, approval cards, errors and time dividers.
 *
 * @module components/agents/AgentChatItems
 */

import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { AgentAvatar } from './AgentAvatar';
import {
  formatDivider,
  peerGroupLabel,
  type Agent,
  type AgentMessage,
  type AgentRef,
} from '../../lib/agents';

/** Links in agent text open in the system browser, never in the app webview. */
function useExternalLinks() {
  return useCallback((event: MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    if (/^(https?|mailto):/i.test(href)) void openUrl(href);
  }, []);
}

export function AgentBubble({ message }: { message: AgentMessage }) {
  const html = useMemo(
    () => DOMPurify.sanitize(String(marked.parse(message.text, { async: false, breaks: true }))),
    [message.text]
  );
  const onClick = useExternalLinks();
  return (
    <div className="agent-chat__row agent-chat__row--agent">
      <div
        className="agent-bubble agent-bubble--agent agent-markdown"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

export function UserBubble({ message }: { message: AgentMessage }) {
  return (
    <div className="agent-chat__row agent-chat__row--user">
      <div className="agent-bubble agent-bubble--user">{message.text}</div>
    </div>
  );
}

export function ErrorLine({ message }: { message: AgentMessage }) {
  return (
    <div className="agent-chat__row agent-chat__row--agent">
      <div className="agent-bubble agent-bubble--error" role="alert">
        {message.text}
      </div>
    </div>
  );
}

export function DayDivider({ ts }: { ts: number }) {
  return <div className="agent-chat__divider">{formatDivider(ts)}</div>;
}

interface PeerGroupProps {
  peer: AgentRef;
  messages: AgentMessage[];
  /** The peer as it exists now, for its avatar; absent if it was deleted. */
  peerAgent?: Agent;
  onOpenPeer: (agentId: string) => void;
}

/**
 * "Messaged Finance" / "Message from Chief of Staff" / "5 messages with
 * Finance". Collapsed by default, as in Grok Bot: the conversation between
 * agents is there when you want it and out of the way when you don't.
 */
export function PeerGroup({ peer, messages, peerAgent, onOpenPeer }: PeerGroupProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-peer">
      <div className="agent-peer__line">
        <button
          type="button"
          className="agent-peer__toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {peerGroupLabel(messages)}
        </button>
        <button
          type="button"
          className="agent-peer__name"
          onClick={() => peerAgent && onOpenPeer(peerAgent.id)}
          disabled={!peerAgent}
          title={peerAgent ? `Open ${peer.name}` : `${peer.name} was deleted`}
        >
          {peerAgent && <AgentAvatar name={peerAgent.name} color={peerAgent.color} size={16} />}
          {peer.name}
        </button>
      </div>
      {open && (
        <div className="agent-peer__thread">
          {messages.map((m) => (
            <div key={m.id} className="agent-peer__message" data-direction={m.kind}>
              <span className="agent-peer__who">
                {m.kind === 'sent_to_agent' ? `To ${peer.name}` : peer.name}
              </span>
              <span className="agent-peer__text">{m.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL = {
  allowed: 'Allowed',
  denied: 'Declined',
  expired: 'Not answered in time',
} as const;

interface ApprovalCardProps {
  message: AgentMessage;
  /** The agent stopped waiting (its turn ended). Allowing wakes it to finish. */
  paused: boolean;
  onAnswer: (requestId: string, allow: boolean) => Promise<void>;
}

/**
 * The exact thing being approved, readable. Tool inputs (an email to send, a
 * record to write) are shown as `key: value` lines rather than raw JSON. Every
 * value is still shown in full: this is what the user is agreeing to.
 */
function approvalDetail(detail: string, input: unknown, title: string): string {
  const isGenericTool = title.startsWith('Use ');
  if (!isGenericTool || !input || typeof input !== 'object' || Array.isArray(input)) return detail;
  const lines = Object.entries(input as Record<string, unknown>).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return `${key}: ${text}`;
  });
  return lines.length ? lines.join('\n') : detail;
}

export function ApprovalCard({ message, paused, onAnswer }: ApprovalCardProps) {
  const approval = message.approval;
  const [busy, setBusy] = useState(false);
  if (!approval) return null;
  const pending = approval.status === 'pending';
  const answer = async (allow: boolean) => {
    setBusy(true);
    try {
      await onAnswer(approval.requestId, allow);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="agent-chat__row agent-chat__row--agent">
      <div className="agent-approval" data-status={approval.status}>
        <div className="agent-approval__title">{approval.title}</div>
        {approval.detail && (
          <pre className="agent-approval__detail">
            {approvalDetail(approval.detail, approval.input, approval.title)}
          </pre>
        )}
        {pending && paused && (
          <p className="agent-approval__note">
            It paused here for you. Allow it and it picks up where it left off.
          </p>
        )}
        {pending ? (
          <div className="agent-approval__actions">
            <Button variant="secondary" disabled={busy} onClick={() => void answer(false)}>
              Deny
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void answer(true)}>
              Allow
            </Button>
          </div>
        ) : (
          <div className="agent-approval__outcome">
            {STATUS_LABEL[approval.status as keyof typeof STATUS_LABEL]}
          </div>
        )}
      </div>
    </div>
  );
}

/** Three dots and what it's doing, under the last message while it works. */
export function WorkingIndicator({ activity }: { activity: string | null }) {
  return (
    <div className="agent-chat__row agent-chat__row--agent" aria-live="polite">
      <div className="agent-working">
        <span className="agent-working__dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        {activity && <span className="agent-working__activity">{activity}</span>}
      </div>
    </div>
  );
}
