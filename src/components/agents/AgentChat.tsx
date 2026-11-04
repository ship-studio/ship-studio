/**
 * One agent's conversation: the floating name pill, the messages, and the
 * composer. Scroll sticks to the bottom while you're at the bottom, and stays
 * put when you've scrolled up to read.
 *
 * @module components/agents/AgentChat
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, PaperclipIcon, SettingsSlidersIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Spinner } from '../primitives/Spinner';
import { TextArea } from '../primitives/TextField';
import { AgentAvatar } from './AgentAvatar';
import { useArrivals, useFollowBottom, usePresence } from './useAgentMotion';
import { ComposerAttachments, ComposerQuotes } from './AgentAttachments';
import { toOutgoing, useComposerAttachments, useFileDrop } from './useComposerAttachments';
import { useQuoteSelection } from './useQuoteSelection';
import { useCommands } from '../../commands/useCommands';
import {
  AgentBubble,
  ApprovalCard,
  DayDivider,
  ErrorLine,
  PeerGroup,
  UserBubble,
  WorkingIndicator,
} from './AgentChatItems';
import {
  answerApproval,
  buildChatItems,
  withQuotes,
  sendAgentMessage,
  stopAgent,
  type Agent,
} from '../../lib/agents';
import { loadMessages, upsertMessage, useAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

/** Within this many px of the bottom counts as "at the bottom". */
const STICK_THRESHOLD = 80;

interface AgentChatProps {
  agent: Agent;
  agentsById: Map<string, Agent>;
  onOpenAgent: (agentId: string) => void;
  onEditAgent: (agent: Agent) => void;
}

export function AgentChat({ agent, agentsById, onOpenAgent, onEditAgent }: AgentChatProps) {
  const { messages: allMessages, engineReady } = useAgents();
  const messages = allMessages[agent.id];
  const { showToast } = useOptionalToast();
  const [draft, setDraft] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  const sectionRef = useRef<HTMLElement>(null);

  const toastError = useCallback((message: string) => showToast(message, 'error'), [showToast]);
  const attachments = useComposerAttachments(toastError);
  const { over: dropping, dom: dropHandlers } = useFileDrop(
    sectionRef,
    engineReady,
    (paths) => void attachments.addPaths(paths),
    attachments.addFiles
  );
  const { pick } = attachments;
  const pickFiles = useCallback(() => {
    pick().catch((error: unknown) => toastError(String(error)));
  }, [pick, toastError]);

  // Quotes wait above the text as chips; each ⌘L adds one. They're sent as
  // Markdown blockquotes ahead of what was typed.
  const [quotes, setQuotes] = useState<string[]>([]);
  const insertQuote = useCallback((text: string) => {
    setQuotes((current) => [...current, text]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  const removeQuote = useCallback(
    (index: number) => setQuotes((current) => current.filter((_, i) => i !== index)),
    []
  );
  const quoting = useQuoteSelection(scrollRef, sectionRef, insertQuote);

  useCommands(
    () => [
      {
        id: 'agents.attachFiles',
        title: `Attach files for ${agent.name}…`,
        icon: <PaperclipIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'upload', 'image', 'screenshot', 'file', 'paperclip'],
        when: () => engineReady,
        run: pickFiles,
      },
    ],
    [agent.name, engineReady, pickFiles]
  );

  // Mounted once per agent (keyed by id), so the draft starts empty.
  useEffect(() => {
    void loadMessages(agent.id);
    inputRef.current?.focus();
  }, [agent.id]);

  const items = useMemo(() => buildChatItems(messages ?? []), [messages]);
  // A card left open after the turn ended is not "working": no dots, no Stop.
  const working = agent.status.state === 'working';
  const indicator = usePresence(working);

  // Only lines that arrive while the chat is open animate in.
  const messageIds = useMemo(() => messages?.map((m) => m.id), [messages]);
  const isArrived = useArrivals(messageIds);
  const arrivedAt = (index: number) => {
    const item = items[index];
    if (!item) return false;
    if (item.type === 'day') return arrivedAt(index + 1);
    return isArrived(item.type === 'peer-group' ? item.messages[0].id : item.message.id);
  };
  const newestArrived = arrivedAt(items.length - 1);

  const messagesRef = useRef<HTMLDivElement>(null);
  const { follow, isGliding } = useFollowBottom(scrollRef, messagesRef, atBottomRef);

  // Follow new content only if the reader was already at the bottom: glide
  // to a new line, jump on first load.
  useLayoutEffect(() => {
    if (atBottomRef.current) follow(newestArrived);
  }, [items, working, agent.status.activity, follow, newestArrived]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || isGliding()) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  }, [isGliding]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const staged = attachments.items;
  const canSend =
    (draft.trim().length > 0 || staged.length > 0 || quotes.length > 0) && engineReady;

  const send = async () => {
    const typed = draft.trim();
    const quoted = quotes;
    if (!canSend) return;
    setDraft('');
    setQuotes([]);
    attachments.setItems([]);
    atBottomRef.current = true;
    try {
      const text = withQuotes(quoted, typed);
      const message = await sendAgentMessage(agent.id, text, await toOutgoing(staged));
      upsertMessage(message);
    } catch (error) {
      setDraft(typed);
      setQuotes(quoted);
      attachments.setItems(staged);
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  const onAnswer = async (requestId: string, allow: boolean) => {
    try {
      await answerApproval(agent.id, requestId, allow);
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  const onStop = async () => {
    try {
      await stopAgent(agent.id);
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  // Grow with the text, up to a cap, like a messaging app.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // Measure at `auto` with transitions off, put the old height back, then
    // set the new one, so the CSS height transition has a start to run from.
    const previous = el.style.height;
    el.style.transition = 'none';
    el.style.height = 'auto';
    const next = `${Math.min(el.scrollHeight, 180)}px`;
    el.style.height = previous || next;
    void el.offsetHeight;
    el.style.transition = '';
    el.style.height = next;
  }, [draft]);

  return (
    <section
      ref={sectionRef}
      className="agent-chat"
      data-color={agent.color}
      data-dropping={dropping || undefined}
      aria-label={`Conversation with ${agent.name}`}
      {...dropHandlers}
    >
      <header className="agent-chat__header">
        <AgentAvatar name={agent.name} color={agent.color} size={24} selected />
        <div className="agent-chat__title">
          <h2 className="agent-chat__name">{agent.name}</h2>
          {agent.role && <p className="agent-chat__role">{agent.role}</p>}
        </div>
        <IconButton
          variant="ghost"
          className="agent-chat__edit"
          icon={<SettingsSlidersIcon size={14} />}
          onClick={() => onEditAgent(agent)}
          title="Edit agent"
          aria-label={`Edit ${agent.name}`}
        />
      </header>

      <div className="agent-chat__scroll" ref={scrollRef} onScroll={onScroll}>
        <div
          className="agent-chat__messages"
          ref={messagesRef}
          data-state={messages === undefined ? 'loading' : 'ready'}
        >
          {messages === undefined ? (
            <div className="agent-chat__loading">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <div className="agent-chat__empty">
              <AgentAvatar name={agent.name} color={agent.color} size={48} selected />
              <p className="agent-chat__empty-name">{agent.name}</p>
              {agent.role && <p className="agent-chat__empty-role">{agent.role}</p>}
            </div>
          ) : (
            items.map((item, index) => {
              if (item.type === 'day')
                return (
                  <DayDivider
                    key={`day-${item.ts}-${index}`}
                    ts={item.ts}
                    arrived={arrivedAt(index)}
                  />
                );
              const arrived = arrivedAt(index);
              if (item.type === 'peer-group') {
                return (
                  <PeerGroup
                    key={item.messages[0].id}
                    peer={item.peer}
                    messages={item.messages}
                    peerAgent={agentsById.get(item.peer.id)}
                    onOpenPeer={onOpenAgent}
                    arrived={arrived}
                  />
                );
              }
              const m = item.message;
              switch (m.kind) {
                case 'user':
                  return <UserBubble key={m.id} message={m} agent={agent} arrived={arrived} />;
                case 'agent':
                  return <AgentBubble key={m.id} message={m} arrived={arrived} />;
                case 'approval':
                  return (
                    <ApprovalCard
                      key={m.id}
                      message={m}
                      paused={agent.status.state === 'idle'}
                      onAnswer={onAnswer}
                      arrived={arrived}
                    />
                  );
                case 'error':
                  return <ErrorLine key={m.id} message={m} arrived={arrived} />;
                default:
                  return null;
              }
            })
          )}
          {indicator.mounted && (
            <WorkingIndicator
              activity={agent.status.activity}
              entering={indicator.entering}
              leaving={indicator.leaving}
              onExited={indicator.onExited}
            />
          )}
        </div>
      </div>

      {!atBottom && (
        <IconButton
          variant="secondary"
          className="agent-chat__jump"
          icon={<ArrowDownIcon size={14} />}
          onClick={scrollToBottom}
          aria-label="Jump to latest"
          title="Jump to latest"
        />
      )}

      {quoting.anchor && (
        <Button
          size="compact"
          className="agent-chat__quote"
          style={{ top: quoting.anchor.top, left: quoting.anchor.left }}
          // Keep the selection: a mousedown here would otherwise clear it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => quoting.quote()}
        >
          Quote <kbd className="agent-chat__kbd">⌘L</kbd>
        </Button>
      )}

      <div className="agent-chat__drop" aria-hidden={!dropping}>
        <div className="agent-chat__drop-label">
          <span className="agent-chat__drop-icon">
            <PaperclipIcon size={18} />
          </span>
          Drop to attach for {agent.name}
        </div>
      </div>

      <form
        className="agent-composer"
        data-has-attachments={staged.length > 0 || undefined}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <ComposerQuotes quotes={quotes} onRemove={removeQuote} />
        <ComposerAttachments items={staged} onRemove={attachments.remove} />
        <div className="agent-composer__row">
          <IconButton
            variant="ghost"
            className="agent-composer__attach"
            icon={<PaperclipIcon size={16} />}
            onClick={pickFiles}
            disabled={!engineReady}
            aria-label="Attach files"
            title="Attach files, or paste or drop them here"
          />
          <TextArea
            ref={inputRef}
            className="agent-composer__input"
            rows={1}
            value={draft}
            placeholder={
              engineReady ? `Message ${agent.name}` : 'Install Claude Code to talk to your agents'
            }
            disabled={!engineReady}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={attachments.onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            aria-label={`Message ${agent.name}`}
          />
          <div className="agent-composer__actions">
            {working && !canSend ? (
              <IconButton
                variant="secondary"
                className="agent-composer__stop"
                icon={<span className="agent-composer__stop-square" aria-hidden />}
                onClick={() => void onStop()}
                aria-label={`Stop ${agent.name}`}
                title="Stop"
              />
            ) : (
              <IconButton
                type="submit"
                variant="primary"
                className="agent-composer__send"
                icon={<ArrowUpIcon size={14} />}
                disabled={!canSend}
                aria-label="Send"
                title={working ? 'Send. It reads this when it finishes what it’s doing.' : 'Send'}
              />
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
