/**
 * One agent's conversation: the header band, the messages, and the composer.
 * Scroll sticks to the bottom while you're at the bottom, and stays put when
 * you've scrolled up to read.
 *
 * What you send shows at once, before the backend has it: a pending bubble
 * that the persisted message takes over in place (same React key, so it
 * neither re-animates nor jumps), or that turns into "Not sent" if the send
 * fails.
 *
 * @module components/agents/AgentChat
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  HomeIcon,
  MoreHorizontalIcon,
  WarningIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { MenuButton } from '../primitives/MenuButton';
import { TextArea } from '../primitives/TextField';
import { AgentAvatar } from './AgentAvatar';
import { AgentActionItems, type AgentActions } from './AgentActions';
import { useArrivals, useFollowBottom, usePresence } from './useAgentMotion';
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
  needsYou,
  sendAgentMessage,
  sortAgents,
  stopAgent,
  type Agent,
  type AgentMessage,
} from '../../lib/agents';
import { upsertMessage, useAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

/** Within this many px of the bottom counts as "at the bottom". */
const STICK_THRESHOLD = 80;

/** Something you sent from this chat; `id` once the backend has it. */
interface Pending {
  key: string;
  text: string;
  ts: number;
  failed: boolean;
  id?: string;
}

function newPending(text: string): Pending {
  return { key: `local-${crypto.randomUUID()}`, text, ts: Date.now(), failed: false };
}

interface AgentChatProps extends AgentActions {
  agent: Agent;
  agentsById: Map<string, Agent>;
  onOpenAgent: (agentId: string) => void;
  onSetUpEngine: () => void;
  /** Below the compact breakpoint the sidebar is gone; the header carries navigation. */
  compact?: { agents: Agent[]; onGoHome: () => void };
}

function statusLabel(agent: Agent): string | null {
  if (needsYou(agent)) return 'Needs your OK';
  if (agent.status.state === 'working') return 'Working';
  return null;
}

export function AgentChat({
  agent,
  agentsById,
  onOpenAgent,
  onSetUpEngine,
  compact,
  ...actions
}: AgentChatProps) {
  const { messages: allMessages, engineReady } = useAgents();
  const messages = allMessages[agent.id];
  const { showToast } = useOptionalToast();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Mounted once per agent (keyed by id), so the draft starts empty.
  useEffect(() => inputRef.current?.focus(), []);

  // A pending bubble gives way as soon as its message is in the store, which
  // can be before the send call returns (the backend's event can win). The
  // persisted message then renders under the pending bubble's key.
  const { shown, aliases, failed } = useMemo(() => {
    const list = messages ?? [];
    const aliases = new Map<string, string>();
    const local: AgentMessage[] = [];
    const failed = new Set<string>();
    for (const p of pending) {
      const match =
        list.find((m) => m.id === p.id) ??
        list.find(
          (m) => m.kind === 'user' && m.text === p.text && m.ts >= p.ts - 5000 && !aliases.has(m.id)
        );
      if (match) {
        aliases.set(match.id, p.key);
        continue;
      }
      local.push({ id: p.key, agentId: agent.id, ts: p.ts, kind: 'user', text: p.text });
      if (p.failed) failed.add(p.key);
    }
    return { shown: [...list, ...local], aliases, failed };
  }, [messages, pending, agent.id]);

  const keyOf = (id: string) => aliases.get(id) ?? id;

  const items = useMemo(() => buildChatItems(shown), [shown]);
  // A card left open after the turn ended is not "working": no dots, no Stop.
  const working = agent.status.state === 'working';
  const indicator = usePresence(working);

  // Only lines that arrive while the chat is open animate in.
  const messageIds = useMemo(() => messages?.map((m) => m.id), [messages]);
  const isArrived = useArrivals(messageIds);
  const arrivedAt = (index: number): boolean => {
    const item = items[index];
    if (!item) return false;
    if (item.type === 'day') return arrivedAt(index + 1);
    return isArrived(item.type === 'peer-group' ? item.messages[0].id : item.message.id);
  };
  const newestArrived = arrivedAt(items.length - 1);

  const messagesRef = useRef<HTMLDivElement>(null);
  const { follow, isGliding } = useFollowBottom(scrollRef, messagesRef, atBottomRef);

  // Follow new content only if the reader was already at the bottom: glide
  // to a new line, land on the bottom (before paint) on first render.
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

  const deliver = async (entry: Pending) => {
    try {
      const message = await sendAgentMessage(agent.id, entry.text);
      setPending((list) => list.map((p) => (p.key === entry.key ? { ...p, id: message.id } : p)));
      upsertMessage(message);
    } catch (error) {
      setPending((list) => list.map((p) => (p.key === entry.key ? { ...p, failed: true } : p)));
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    atBottomRef.current = true;
    const entry = newPending(text);
    setPending((list) => [...list, entry]);
    void deliver(entry);
  };

  const retry = (key: string) => {
    const entry = pending.find((p) => p.key === key);
    if (!entry) return;
    setPending((list) => list.map((p) => (p.key === key ? { ...p, failed: false } : p)));
    void deliver(entry);
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

  const status = statusLabel(agent);
  const title = (
    <>
      <AgentAvatar name={agent.name} color={agent.color} selected />
      <h2 className="agent-chat__name">{agent.name}</h2>
      {status && (
        <span className="agent-chat__status" data-state={needsYou(agent) ? 'waiting' : 'working'}>
          {status}
        </span>
      )}
    </>
  );

  return (
    <section
      className="agent-chat"
      data-color={agent.color}
      aria-label={`Conversation with ${agent.name}`}
    >
      <header className="agent-chat__header">
        {compact && (
          <IconButton
            variant="ghost"
            className="agent-chat__home"
            icon={<HomeIcon size={14} />}
            onClick={compact.onGoHome}
            aria-label="Home"
            title="Home"
          />
        )}
        {compact ? (
          <Dropdown
            portal
            className="agent-chat__switcher"
            trigger={(p) => (
              <MenuButton
                {...p}
                expanded={p['aria-expanded']}
                variant="ghost"
                className="agent-chat__title"
                aria-label={`${agent.name}. Switch agent`}
              >
                {title}
              </MenuButton>
            )}
          >
            {sortAgents(compact.agents)
              .filter((a) => !a.hidden || a.id === agent.id)
              .map((a) => (
                <DropdownItem
                  key={a.id}
                  active={a.id === agent.id}
                  icon={<span className="agent-dot" data-color={a.color} />}
                  onSelect={() => onOpenAgent(a.id)}
                >
                  {a.name}
                  {needsYou(a) ? ' · needs your OK' : a.unread > 0 ? ' · new' : ''}
                </DropdownItem>
              ))}
            <DropdownDivider />
            <DropdownItem icon={<HomeIcon size={14} />} onSelect={compact.onGoHome}>
              Home
            </DropdownItem>
          </Dropdown>
        ) : (
          <div className="agent-chat__title">{title}</div>
        )}
        <Dropdown
          align="right"
          portal
          className="agent-chat__menu"
          trigger={(p) => (
            <IconButton
              {...p}
              tabIndex={0}
              variant="ghost"
              icon={<MoreHorizontalIcon size={14} />}
              title="Agent actions"
              aria-label={`Actions for ${agent.name}`}
            />
          )}
        >
          <AgentActionItems agent={agent} kind="dropdown" {...actions} />
        </Dropdown>
      </header>

      <div className="agent-chat__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="agent-chat__messages" ref={messagesRef}>
          {items.length === 0 ? (
            <div className="agent-chat__empty">
              <AgentAvatar name={agent.name} color={agent.color} size="hero" selected />
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
                  return (
                    <UserBubble
                      key={keyOf(m.id)}
                      message={m}
                      arrived={arrived}
                      failed={failed.has(m.id)}
                      onRetry={() => retry(m.id)}
                    />
                  );
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

      <div className="agent-chat__footer">
        {!atBottom && (
          <IconButton
            className="agent-chat__jump"
            icon={<ArrowDownIcon size={14} />}
            onClick={scrollToBottom}
            aria-label="Jump to latest"
            title="Jump to latest"
          />
        )}

        {engineReady ? (
          <form
            className="agent-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <TextArea
              ref={inputRef}
              className="agent-composer__input"
              rows={1}
              value={draft}
              placeholder={`Message ${agent.name}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                } else if (e.key === 'Escape' && working && !draft.trim()) {
                  e.preventDefault();
                  void onStop();
                }
              }}
              aria-label={`Message ${agent.name}`}
            />
            {working && !draft.trim() ? (
              <IconButton
                variant="secondary"
                className="agent-composer__stop"
                icon={<span className="agent-composer__stop-square" aria-hidden />}
                onClick={() => void onStop()}
                aria-label={`Stop ${agent.name}`}
                title="Stop (Esc)"
              />
            ) : (
              <IconButton
                type="submit"
                variant={draft.trim() ? 'primary' : 'secondary'}
                className="agent-composer__send"
                icon={<ArrowUpIcon size={14} />}
                disabled={!draft.trim()}
                aria-label="Send"
                title={working ? 'Send. It reads this when it finishes what it’s doing.' : 'Send'}
              />
            )}
          </form>
        ) : (
          <div className="agent-composer agent-composer--blocked" role="status">
            <WarningIcon size={14} className="agent-composer__blocked-icon" />
            <span className="agent-composer__blocked-text">
              Agents run on Claude Code, which isn&apos;t installed on this Mac yet.
            </span>
            <Button variant="primary" onClick={onSetUpEngine}>
              Set up Claude Code
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
