/**
 * The pieces a conversation is made of: bubbles, the centred lines where
 * agents talked to each other, approval cards, errors and time dividers.
 *
 * @module components/agents/AgentChatItems
 */

import { useCallback, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Marked, type Token, type Tokens, type TokensList } from 'marked';
import DOMPurify from 'dompurify';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  HistoryIcon,
  WarningIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import { MessageAttachments } from './AgentAttachments';
import { useHeightReveal } from './useAgentMotion';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import {
  errorRemedy,
  formatClock,
  formatDivider,
  formatExactTime,
  formatWhen,
  peerGroupLabel,
  splitQuotes,
  type Agent,
  type AgentMessage,
  type AgentRef,
} from '../../lib/agents';

/**
 * `arrived` marks a line that came in while the chat was open, so only it
 * rises into place (features/agents-motion.css); history loads still.
 */
interface Arrival {
  arrived?: boolean;
}

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

/**
 * Agent prose. Images become links: a remote image would load inside the app
 * webview, unsized, from wherever the agent pointed it.
 */
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    image({ href, text }) {
      const label = DOMPurify.sanitize(text || href);
      return `<a href="${encodeURI(href)}">${label}</a>`;
    },
  },
});

type Segment = { type: 'html'; html: string } | { type: 'code'; text: string; lang?: string };

/** Prose renders as sanitized HTML; code blocks render as components, so they can carry Copy. */
function toSegments(text: string): Segment[] {
  const tokens = markdown.lexer(text);
  const segments: Segment[] = [];
  let run: Token[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const list = Object.assign(run, { links: tokens.links }) as TokensList;
    segments.push({ type: 'html', html: DOMPurify.sanitize(markdown.parser(list)) });
    run = [];
  };
  for (const token of tokens) {
    if (token.type === 'code') {
      flush();
      const code = token as Tokens.Code;
      segments.push({ type: 'code', text: code.text, lang: code.lang || undefined });
    } else {
      run.push(token);
    }
  }
  flush();
  return segments;
}

function CodeBlock({ text }: { text: string }) {
  const { copy, isCopied } = useCopyToClipboard();
  return (
    <div className="agent-code">
      <pre>
        <code>{text}</code>
      </pre>
      <IconButton
        variant="ghost"
        size="compact"
        tabIndex={0}
        className="agent-code__copy"
        icon={isCopied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        onClick={() => void copy(text)}
        aria-label={isCopied ? 'Copied' : 'Copy code'}
        title={isCopied ? 'Copied' : 'Copy'}
      />
    </div>
  );
}

/**
 * Copy and the time, on hover or keyboard focus. They keep their space, so
 * nothing shifts under the pointer; the exact time is the time's tooltip.
 */
function MessageActions({ text, ts }: { text: string; ts: number }) {
  const { copy, isCopied } = useCopyToClipboard();
  return (
    <div className="agent-message__actions">
      {text && (
        <IconButton
          tabIndex={0}
          variant="ghost"
          size="compact"
          icon={isCopied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          onClick={() => void copy(text)}
          aria-label={isCopied ? 'Copied' : 'Copy message'}
          title={isCopied ? 'Copied' : 'Copy'}
        />
      )}
      <time
        className="agent-message__time"
        dateTime={new Date(ts).toISOString()}
        title={formatExactTime(ts)}
      >
        {formatClock(ts)}
      </time>
    </div>
  );
}

interface AgentBubbleProps extends Arrival {
  message: AgentMessage;
  /** Still being written: the text grows in place and a caret marks its end. */
  streaming?: boolean;
}

/** Markdown prose with code blocks, shared by replies and agent-to-agent threads. */
function Prose({ text }: { text: string }) {
  const segments = useMemo(() => toSegments(text), [text]);
  return (
    <>
      {segments.map((segment, i) =>
        segment.type === 'code' ? (
          <CodeBlock key={i} text={segment.text} />
        ) : (
          <div
            key={i}
            className="agent-markdown__prose"
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        )
      )}
    </>
  );
}

export function AgentBubble({ message, arrived, streaming }: AgentBubbleProps) {
  const onClick = useExternalLinks();
  return (
    <div
      className="agent-chat__row agent-chat__row--agent"
      data-arrived={arrived || undefined}
      data-stopped={message.stopped || undefined}
      data-message-ids={message.id}
    >
      <div
        className="agent-bubble agent-bubble--agent agent-markdown"
        data-streaming={streaming || undefined}
        aria-busy={streaming || undefined}
        onClick={onClick}
      >
        <Prose text={message.text} />
      </div>
      {message.stopped && <span className="agent-bubble__stopped">Stopped</span>}
      {!streaming && <MessageActions text={message.text} ts={message.ts} />}
    </div>
  );
}

interface UserBubbleProps extends Arrival {
  message: AgentMessage;
  /** Whose home the attachments live in. */
  agent: Agent;
  /** Sending failed; offer to try again. */
  failed?: boolean;
  onRetry?: () => void;
}

/** Attachments sit above the words, both against the right edge, as one message. */
export function UserBubble({ message, agent, arrived, failed, onRetry }: UserBubbleProps) {
  const attachments = message.attachments ?? [];
  const actions = !failed && <MessageActions text={message.text} ts={message.ts} />;
  return (
    <div
      className="agent-chat__row agent-chat__row--user"
      data-arrived={arrived || undefined}
      data-failed={failed || undefined}
      data-attachments={attachments.length > 0 || undefined}
      data-message-ids={message.id}
    >
      {attachments.length > 0 && (
        <div className="agent-chat__line">
          {!message.text && actions}
          <MessageAttachments agent={agent} attachments={attachments} />
        </div>
      )}
      {message.text && (
        <div className="agent-chat__line">
          {actions}
          <div className="agent-bubble agent-bubble--user">
            {splitQuotes(message.text).map((part, i) =>
              part.kind === 'quote' ? (
                <blockquote key={i} className="agent-bubble__quote">
                  {part.text}
                </blockquote>
              ) : (
                <p key={i} className="agent-bubble__text">
                  {part.text}
                </p>
              )
            )}
          </div>
        </div>
      )}
      {failed && (
        <div className="agent-chat__failed" role="alert">
          <WarningIcon size={12} />
          Not sent.
          <TextButton variant="accent" tabIndex={0} onClick={onRetry}>
            Try again
          </TextButton>
        </div>
      )}
    </div>
  );
}

interface ErrorLineProps extends Arrival {
  message: AgentMessage;
  /** Send the last thing you said again; only on the newest failure. */
  onRetry?: () => void;
  onSignIn?: () => void;
}

/** A failed turn, with its one next step: sign in again, or try again. */
export function ErrorLine({ message, arrived, onRetry, onSignIn }: ErrorLineProps) {
  const signIn = errorRemedy(message.text) === 'sign-in' && onSignIn;
  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <div className="agent-bubble agent-bubble--error" role="alert">
        <p className="agent-bubble__text">{message.text}</p>
        {(signIn || onRetry) && (
          <div className="agent-bubble__remedy">
            {signIn && (
              <Button tabIndex={0} size="compact" variant="secondary" onClick={onSignIn}>
                Sign in to Claude Code
              </Button>
            )}
            {onRetry && (
              <Button
                tabIndex={0}
                size="compact"
                variant={signIn ? 'ghost' : 'secondary'}
                onClick={onRetry}
              >
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
      <MessageActions text={message.text} ts={message.ts} />
    </div>
  );
}

/**
 * "Scheduled check-in", centred like the agent-to-agent lines, with the note
 * the agent left itself. A late one says so: the app was closed when it was due.
 */
export function CheckInLine({ message, arrived }: { message: AgentMessage } & Arrival) {
  const mark = message.checkIn;
  const label = mark?.repeats ? 'Routine' : 'Scheduled check-in';
  return (
    <div
      className="agent-checkin"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <span className="agent-peer__line">
        <HistoryIcon size={12} />
        {label}
        {mark?.late && (
          <span className="agent-checkin__late">· late, was due {formatWhen(mark.dueAt)}</span>
        )}
      </span>
      <span className="agent-checkin__note">{message.text}</span>
    </div>
  );
}

export function DayDivider({ ts, arrived }: { ts: number } & Arrival) {
  return (
    <div className="agent-chat__divider" data-arrived={arrived || undefined}>
      {formatDivider(ts)}
    </div>
  );
}

interface PeerGroupProps extends Arrival {
  peer: AgentRef;
  messages: AgentMessage[];
  /** The peer as it exists now, for its colour; absent if it was deleted. */
  peerAgent?: Agent;
  onOpenPeer: (agentId: string) => void;
  /** A search jumped to a line inside: open the thread to show it. */
  reveal?: boolean;
}

/**
 * "Messaged Finance" / "Message from Chief of Staff" / "5 messages with
 * Finance". Collapsed by default: the conversation between agents is there
 * when you want it and out of the way when you don't.
 */
export function PeerGroup({
  peer,
  messages,
  peerAgent,
  onOpenPeer,
  arrived,
  reveal,
}: PeerGroupProps) {
  const [open, setOpen] = useState(Boolean(reveal));
  const [revealed, setRevealed] = useState(reveal);
  if (reveal !== revealed) {
    setRevealed(reveal);
    if (reveal) setOpen(true);
  }
  const threadRef = useRef<HTMLDivElement>(null);
  const threadShown = useHeightReveal(threadRef, open);
  return (
    <div
      className="agent-peer"
      data-arrived={arrived || undefined}
      data-message-ids={messages.map((m) => m.id).join(' ')}
    >
      <div className="agent-peer__line">
        <button
          type="button"
          tabIndex={0}
          className="agent-peer__toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon size={10} className="agent-peer__chevron" />
          {peerGroupLabel(messages)}
        </button>
        <button
          type="button"
          tabIndex={0}
          className="agent-peer__name"
          onClick={() => peerAgent && onOpenPeer(peerAgent.id)}
          disabled={!peerAgent}
          title={peerAgent ? `Open ${peer.name}` : `${peer.name} was deleted`}
        >
          {peerAgent && <span className="agent-peer__dot" data-color={peerAgent.color} />}
          {peer.name}
        </button>
      </div>
      {threadShown && (
        <div ref={threadRef} className="agent-peer__thread">
          {messages.map((m) => (
            <div key={m.id} className="agent-peer__message" data-direction={m.kind}>
              <span className="agent-peer__who">
                {m.kind === 'sent_to_agent' ? `To ${peer.name}` : peer.name}
              </span>
              <div className="agent-peer__text agent-markdown">
                <Prose text={m.text} />
              </div>
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

interface ApprovalCardProps extends Arrival {
  message: AgentMessage;
  /** The agent stopped waiting (its turn ended). Allowing wakes it to finish. */
  paused: boolean;
  onAnswer: (requestId: string, allow: boolean) => Promise<void>;
}

/** "subject" → "Subject", "cc_list" → "Cc list". */
const fieldLabel = (key: string) => {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

/**
 * The exact thing being approved, readable. A connector tool's input (an
 * email to send, a record to write) is shown as labelled fields rather than
 * raw JSON; Claude Code's own tools already come with a one-line detail.
 * Every value is shown in full: this is what the user is agreeing to.
 */
function approvalFields(tool: string | undefined, input: unknown): [string, string][] | null {
  if (!tool?.startsWith('mcp__') || !input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const fields = Object.entries(input as Record<string, unknown>).map(
    ([key, value]): [string, string] => [
      fieldLabel(key),
      typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    ]
  );
  return fields.length ? fields : null;
}

export function ApprovalCard({ message, paused, onAnswer, arrived }: ApprovalCardProps) {
  const approval = message.approval;
  const [busy, setBusy] = useState(false);
  // Answered while on screen, so the buttons resolve into the outcome;
  // a card that loads already answered just shows it.
  const [openedPending] = useState(approval?.status === 'pending');
  if (!approval) return null;
  const pending = approval.status === 'pending';
  const fields = approvalFields(approval.tool, approval.input);
  const answer = async (allow: boolean) => {
    setBusy(true);
    try {
      await onAnswer(approval.requestId, allow);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <div className="agent-approval" data-status={approval.status}>
        <div className="agent-approval__title">
          {pending && <WarningIcon size={14} className="agent-approval__icon" />}
          {approval.title}
        </div>
        {fields ? (
          <dl className="agent-approval__fields">
            {fields.map(([label, value]) => (
              <div key={label} className="agent-approval__field">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          approval.detail && <pre className="agent-approval__detail">{approval.detail}</pre>
        )}
        {pending && paused && (
          <p className="agent-approval__note">
            It paused here for you. Allow it and it picks up where it left off.
          </p>
        )}
        {pending ? (
          <div className="agent-approval__actions">
            {/* tabIndex: WebKit leaves buttons out of the Tab order unless asked. */}
            <Button
              tabIndex={0}
              variant="secondary"
              disabled={busy}
              onClick={() => void answer(false)}
            >
              Deny
            </Button>
            <Button
              tabIndex={0}
              variant="primary"
              disabled={busy}
              onClick={() => void answer(true)}
            >
              Allow
            </Button>
          </div>
        ) : (
          <div
            className="agent-approval__outcome"
            data-resolved={(openedPending && !pending) || undefined}
          >
            {STATUS_LABEL[approval.status as keyof typeof STATUS_LABEL]}
          </div>
        )}
      </div>
    </div>
  );
}

interface WorkingIndicatorProps {
  activity: string | null;
  /** It appeared after the chat opened: open its height rather than pop in. */
  entering?: boolean;
  /** The turn ended: collapse, then `onExited` unmounts it. */
  leaving?: boolean;
  onExited?: () => void;
}

/** Three dots and what it's doing, under the last message while it works. */
export function WorkingIndicator({ activity, entering, leaving, onExited }: WorkingIndicatorProps) {
  // Keep the last thing it said while it collapses, rather than blanking it.
  const [shown, setShown] = useState(activity);
  if (!leaving && activity !== shown) setShown(activity);
  // Only a change of activity crossfades; the first one is just there.
  const [first] = useState(activity);
  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--working"
      data-entering={entering || undefined}
      data-leaving={leaving || undefined}
      onAnimationEnd={(e) => {
        if (leaving && e.target === e.currentTarget) onExited?.();
      }}
      aria-live="polite"
    >
      <div className="agent-working">
        <span className="agent-working__dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        {shown && (
          <span
            key={shown}
            className="agent-working__activity"
            data-changed={shown !== first || undefined}
          >
            {shown}
          </span>
        )}
      </div>
    </div>
  );
}
