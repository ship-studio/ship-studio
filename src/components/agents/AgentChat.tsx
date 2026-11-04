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
 * A reply streams in as a draft that grows in place; the finished message
 * carries the draft's id, so it takes over the same bubble without a flicker.
 *
 * @module components/agents/AgentChat
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronIcon,
  CollaboratorsIcon,
  HistoryIcon,
  HomeIcon,
  MicrophoneIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
  WarningIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { MenuButton } from '../primitives/MenuButton';
import { TextButton } from '../primitives/TextButton';
import { AgentModelMenu } from './AgentModelMenu';
import { TextArea } from '../primitives/TextField';
import { AgentAvatar } from './AgentAvatar';
import { AgentActionItems, type AgentActions } from './AgentActions';
import { AgentSchedulePopover } from './AgentSchedulePopover';
import { AgentFilesModal } from './AgentFilesModal';
import { useArrivals, useFollowBottom, usePresence } from './useAgentMotion';
import { useDictation } from './useDictation';
import { blockedCopy, dictationVocabulary, openPrivacySettings } from '../../lib/dictation';
import { listProjects } from '../../lib/project';
import { ComposerAttachments, ComposerQuotes } from './AgentAttachments';
import { toOutgoing, useComposerAttachments, useFileDrop } from './useComposerAttachments';
import { useQuoteSelection } from './useQuoteSelection';
import { useMentionPicker } from './AgentMentions';
import { useCommands } from '../../commands/useCommands';
import {
  AgentBubble,
  ApprovalCard,
  DayDivider,
  CheckInLine,
  ErrorLine,
  NoteLine,
  PeerGroup,
  UserBubble,
  WorkingIndicator,
} from './AgentChatItems';
import {
  answerApproval,
  buildChatItems,
  interruptAgent,
  isQueued,
  lastUserText,
  mentionedAgents,
  needsYou,
  withQuotes,
  sendAgentMessage,
  sortAgents,
  stopAgent,
  TEAM_ID,
  type Agent,
  type AgentMessage,
  type AgentRef,
} from '../../lib/agents';
import {
  loadMessages,
  markSent,
  MESSAGE_MAX,
  MESSAGE_PAGE,
  upsertMessage,
  useAgents,
} from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

/**
 * First open: one-click ways in. Importing isn't the Chief's job (the other
 * assistant does it), so that one opens the import steps instead.
 */
const STARTERS = ['Set up my team', 'What can you do?'];

/** Within this many px of the bottom counts as "at the bottom". */
const STICK_THRESHOLD = 80;

/** Something you sent from this chat; `id` once the backend has it. */
interface Pending {
  key: string;
  text: string;
  ts: number;
  failed: boolean;
  id?: string;
  mentions: AgentRef[];
}

function newPending(text: string, mentions: AgentRef[]): Pending {
  return { key: `local-${crypto.randomUUID()}`, text, ts: Date.now(), failed: false, mentions };
}

interface AgentChatProps extends AgentActions {
  agent: Agent;
  agentsById: Map<string, Agent>;
  onOpenAgent: (agentId: string) => void;
  onSetUpEngine: () => void;
  /** The expired-login remedy on an error line. */
  onSignIn: () => void;
  onImport: () => void;
  /** Esc in the composer: true if something above it (search) took it. */
  onEscape?: () => boolean;
  /** Below the compact breakpoint the sidebar is gone; the header carries navigation. */
  compact?: { agents: Agent[]; onGoHome: () => void };
  /** A search result to scroll to and flash; `onJumped` is called once it's shown. */
  jumpTo?: string | null;
  onJumped?: () => void;
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
  onSignIn,
  onImport,
  onEscape,
  compact,
  jumpTo,
  onJumped,
  ...actions
}: AgentChatProps) {
  const { messages: allMessages, drafts, engineReady } = useAgents();
  const messages = allMessages[agent.id];
  // Whitespace that hasn't become words yet isn't worth a bubble.
  const rawDraft = drafts[agent.id];
  const draftText = rawDraft?.text.trimStart() ?? '';
  const streaming = useMemo(
    () => (rawDraft && draftText.trim() ? { ...rawDraft, text: draftText } : null),
    [rawDraft, draftText]
  );
  const { showToast } = useOptionalToast();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const micRef = useRef<HTMLButtonElement>(null);
  const getDraft = useCallback(() => draftRef.current, []);
  const getVocabulary = useCallback(
    async () =>
      dictationVocabulary(
        [...agentsById.values()].map((a) => a.name),
        (await listProjects().catch(() => [])).map((p) => p.name)
      ),
    [agentsById]
  );
  const dictation = useDictation({
    getDraft,
    setDraft,
    getVocabulary,
    meterRef: micRef,
    enabled: engineReady,
  });
  const dictating = dictation.phase !== 'idle';
  const blocked = dictation.blocked ? blockedCopy(dictation.blocked) : null;
  const sectionRef = useRef<HTMLElement>(null);

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  // Who you can @mention here: everyone else on the team, in sidebar order.
  const mentionable = useMemo(
    () => sortAgents([...agentsById.values()]).filter((a) => !a.hidden && a.id !== agent.id),
    [agentsById, agent.id]
  );
  const mentionPicker = useMentionPicker(mentionable, inputRef, setDraft);
  const mentionsIn = (text: string): AgentRef[] =>
    mentionedAgents(text, mentionable).map(({ id, name }) => ({ id, name }));

  useCommands(
    () => [
      {
        id: 'agents.scheduleCheckIn',
        title: `Schedule a check-in for ${agent.name}…`,
        icon: <HistoryIcon size={14} />,
        category: 'action',
        keywords: ['routine', 'remind', 'every', 'recurring', 'later', 'scheduled'],
        when: () => engineReady,
        run: () => setScheduleOpen(true),
      },
      {
        id: 'agents.files',
        title: `Files shared with ${agent.name}`,
        icon: <PaperclipIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'attachments', 'shared', 'downloads', 'report', 'documents'],
        run: () => setFilesOpen(true),
      },
    ],
    [agent.name, engineReady]
  );

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

  // Focus the composer on open (mounted once per agent, keyed by id, so the
  // draft starts empty) and again when dictation ends, wherever it started.
  useEffect(() => {
    if (!dictating) inputRef.current?.focus();
  }, [dictating]);

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
      local.push({
        id: p.key,
        agentId: agent.id,
        ts: p.ts,
        kind: 'user',
        text: p.text,
        mentions: p.mentions,
      });
      if (p.failed) failed.add(p.key);
    }
    // The reply being written sits after what's settled and before anything
    // you've just sent, which it will read next.
    const draft = streaming && !list.some((m) => m.id === streaming.id) ? [streaming] : [];
    return { shown: [...list, ...draft, ...local], aliases, failed };
  }, [messages, pending, agent.id, streaming]);

  const keyOf = (id: string) => aliases.get(id) ?? id;
  const colorOf = (id: string) => agentsById.get(id)?.color;

  const items = useMemo(() => buildChatItems(shown), [shown]);
  // Retry belongs to the newest failure only, and only if nothing was said since.
  const retryText = useMemo(() => {
    const last = shown[shown.length - 1];
    return last?.kind === 'error' ? lastUserText(shown, shown.length - 1) : null;
  }, [shown]);
  const retryId = retryText ? shown[shown.length - 1].id : null;
  // Mid-turn, what you send waits for the next turn. The newest waiting
  // message says so and offers to interrupt instead.
  const busy = agent.status.state !== 'idle';
  const queuedId = useMemo(() => {
    const waiting = shown.filter((m) => !failed.has(m.id) && isQueued(m, agent));
    return waiting[waiting.length - 1]?.id ?? null;
  }, [shown, failed, agent]);
  // A card left open after the turn ended is not "working": no dots, no Stop.
  const working = agent.status.state === 'working';
  // While words are arriving they are the sign of life; the dots and what
  // it's doing come back between text blocks, while tools run.
  const indicator = usePresence(working && !streaming);
  const jump = usePresence(!atBottom);
  // What it's doing now goes above what's waiting: the indicator sits before
  // the run of queued messages at the end, not under them.
  const queuedFrom = useMemo(() => {
    let from = items.length;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'day') continue;
      if (item.type === 'peer-group' || !isQueued(item.message, agent)) break;
      from = i;
    }
    // Leave a day divider that opens the run above the indicator, with its day.
    while (from < items.length && items[from].type === 'day') from++;
    return from;
  }, [items, agent]);

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
  // to a new line, land on the bottom (before paint) on first render. A reply
  // growing is not a new line: it stays pinned without a glide per word.
  const lastItem = items[items.length - 1];
  const lastKey = !lastItem
    ? ''
    : lastItem.type === 'day'
      ? `day-${lastItem.ts}`
      : lastItem.type === 'peer-group'
        ? lastItem.messages[0].id
        : lastItem.message.id;
  const lastKeyRef = useRef(lastKey);
  useLayoutEffect(() => {
    const isNew = lastKeyRef.current !== lastKey;
    lastKeyRef.current = lastKey;
    if (atBottomRef.current) follow(newestArrived && isNew);
  }, [items, lastKey, working, agent.status.activity, follow, newestArrived]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || isGliding()) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  }, [isGliding]);

  // A search hit: bring its line to the middle and flash it. A line older
  // than the loaded page loads the rest first; one that's gone just stops.
  useLayoutEffect(() => {
    if (!jumpTo || !messages) return;
    const target = messagesRef.current?.querySelector<HTMLElement>(
      `[data-message-ids~="${CSS.escape(jumpTo)}"]`
    );
    if (!target) {
      if (messages.length >= MESSAGE_PAGE && messages.length < MESSAGE_MAX) {
        void loadMessages(agent.id, MESSAGE_MAX);
      } else {
        onJumped?.();
      }
      return;
    }
    // The scroll handler settles `atBottom`; until then, don't follow new lines.
    atBottomRef.current = false;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Restart the flash if it's already running (the same hit, clicked twice).
    target.removeAttribute('data-flash');
    void target.offsetWidth;
    target.setAttribute('data-flash', '');
    const clear = (e: AnimationEvent) => {
      if (e.animationName !== 'agents-motion-flash') return;
      target.removeAttribute('data-flash');
      target.removeEventListener('animationend', clear);
    };
    target.addEventListener('animationend', clear);
    // Typing goes on in this conversation, not into whatever was clicked.
    inputRef.current?.focus({ preventScroll: true });
    onJumped?.();
  }, [jumpTo, messages, agent.id, onJumped]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const staged = attachments.items;
  const canSend = draft.trim().length > 0 || staged.length > 0 || quotes.length > 0;

  const interrupt = async () => {
    try {
      await interruptAgent(agent.id);
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  /** `now`: interrupt the turn in progress once it has the message (⌘↵). */
  const deliver = async (entry: Pending, now = false) => {
    try {
      const ids = entry.mentions.map((m) => m.id);
      const message = await sendAgentMessage(agent.id, entry.text, [], ids);
      setPending((list) => list.map((p) => (p.key === entry.key ? { ...p, id: message.id } : p)));
      upsertMessage(message);
      if (now) await interrupt();
    } catch (error) {
      setPending((list) => list.map((p) => (p.key === entry.key ? { ...p, failed: true } : p)));
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  // Words alone appear at once and retry in place. Files have to be copied
  // into the agent's home first, so that send waits, and a failure puts
  // everything back in the composer.
  const sendWithFiles = async (
    typed: string,
    quoted: string[],
    files: typeof staged,
    now: boolean
  ) => {
    try {
      const outgoing = await toOutgoing(files);
      const ids = mentionsIn(typed).map((m) => m.id);
      upsertMessage(await sendAgentMessage(agent.id, withQuotes(quoted, typed), outgoing, ids));
      if (now) await interrupt();
    } catch (error) {
      setDraft(typed);
      setQuotes(quoted);
      attachments.setItems(files);
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  };

  /** Words alone: on screen at once, and in the sidebar's row. */
  const sendText = (text: string, now = false) => {
    atBottomRef.current = true;
    const entry = newPending(text, mentionsIn(text));
    setPending((list) => [...list, entry]);
    markSent(agent.id, text);
    void deliver(entry, now);
  };

  /** `now`: rather than queue behind the turn in progress, interrupt it. */
  const send = (now = false) => {
    if (!canSend || dictating) return;
    const typed = draft.trim();
    setDraft('');
    setQuotes([]);
    if (staged.length > 0) {
      atBottomRef.current = true;
      attachments.setItems([]);
      void sendWithFiles(typed, quotes, staged, now && busy);
      return;
    }
    sendText(withQuotes(quotes, typed), now && busy);
  };

  const retry = (key: string) => {
    const entry = pending.find((p) => p.key === key);
    if (!entry) return;
    setPending((list) => list.map((p) => (p.key === key ? { ...p, failed: false } : p)));
    void deliver(entry);
  };

  const onAnswer = async (requestId: string, allow: boolean, always?: boolean) => {
    try {
      await answerApproval(agent.id, requestId, allow, always);
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
      ref={sectionRef}
      className="agent-chat"
      data-color={agent.color}
      data-dropping={dropping || undefined}
      aria-label={`Conversation with ${agent.name}`}
      {...dropHandlers}
    >
      <header className="agent-chat__header">
        {compact && (
          <IconButton
            tabIndex={0}
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
            menuClassName="agent-model-menu"
            trigger={(p) => (
              <MenuButton
                {...p}
                tabIndex={0}
                expanded={p['aria-expanded']}
                variant="ghost"
                className="agent-chat__title"
                aria-label={`${agent.name}. Switch agent`}
              >
                {title}
                <ChevronIcon
                  size={10}
                  className={p['aria-expanded'] ? 'chevron-flipped' : undefined}
                />
              </MenuButton>
            )}
          >
            {sortAgents(compact.agents)
              .filter((a) => !a.hidden || a.id === agent.id)
              .map((a) => (
                <DropdownItem
                  key={a.id}
                  icon={<AgentAvatar name={a.name} color={a.color} size="mini" />}
                  onSelect={() => onOpenAgent(a.id)}
                >
                  <span className="agent-model-menu__label">
                    {a.name}
                    {needsYou(a) ? ' · needs your OK' : a.unread > 0 ? ' · new' : ''}
                  </span>
                  <span className="agent-model-menu__check" aria-hidden="true">
                    {a.id === agent.id && <CheckIcon size={12} />}
                  </span>
                </DropdownItem>
              ))}
            <DropdownDivider />
            <DropdownItem
              icon={<CollaboratorsIcon size={14} />}
              onSelect={() => onOpenAgent(TEAM_ID)}
            >
              Team
            </DropdownItem>
            <DropdownItem icon={<HomeIcon size={14} />} onSelect={compact.onGoHome}>
              Home
            </DropdownItem>
          </Dropdown>
        ) : (
          <div className="agent-chat__title">{title}</div>
        )}
        <div className="agent-chat__actions">
          {/* Nothing to schedule or pick a model for until Claude Code is here. */}
          {engineReady && (
            <>
              <AgentSchedulePopover
                agent={agent}
                open={scheduleOpen}
                onOpenChange={setScheduleOpen}
              />
              <AgentModelMenu agent={agent} />
            </>
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
            <AgentActionItems
              agent={agent}
              kind="dropdown"
              onSchedule={engineReady ? () => setScheduleOpen(true) : undefined}
              onFiles={() => setFilesOpen(true)}
              {...actions}
            />
          </Dropdown>
          <AgentFilesModal agent={agent} isOpen={filesOpen} onClose={() => setFilesOpen(false)} />
        </div>
      </header>

      <div className="agent-chat__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="agent-chat__messages" ref={messagesRef}>
          {items.length === 0 ? (
            <div className="agent-chat__empty">
              <AgentAvatar name={agent.name} color={agent.color} size="hero" selected />
              <p className="agent-chat__empty-name">{agent.name}</p>
              {agent.isMain ? (
                <>
                  <p className="agent-chat__empty-role">
                    Your Chief of Staff builds and runs your team: it sets up agents for your
                    projects, briefs them, and tracks their work.
                  </p>
                  {engineReady && (
                    <div className="agent-chat__starters">
                      {STARTERS.map((text) => (
                        <Button
                          key={text}
                          tabIndex={0}
                          variant="secondary"
                          onClick={() => sendText(text)}
                        >
                          {text}
                        </Button>
                      ))}
                      <Button tabIndex={0} variant="secondary" onClick={onImport}>
                        Import my agents from another assistant
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                agent.role && <p className="agent-chat__empty-role">{agent.role}</p>
              )}
            </div>
          ) : (
            withIndicatorAt(
              queuedFrom,
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
                      reveal={Boolean(jumpTo && item.messages.some((p) => p.id === jumpTo))}
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
                        agent={agent}
                        arrived={arrived}
                        failed={failed.has(m.id)}
                        onRetry={() => retry(m.id)}
                        queued={
                          m.id === queuedId ? { onInterrupt: () => void interrupt() } : undefined
                        }
                        colorOf={colorOf}
                      />
                    );
                  case 'agent':
                    return (
                      <AgentBubble
                        key={m.id}
                        message={m}
                        arrived={arrived}
                        agent={agent}
                        streaming={m === streaming}
                      />
                    );
                  case 'approval':
                    return (
                      <ApprovalCard
                        key={m.id}
                        message={m}
                        agentName={agent.name}
                        paused={agent.status.state === 'idle'}
                        onAnswer={onAnswer}
                        arrived={arrived}
                      />
                    );
                  case 'error':
                    return (
                      <ErrorLine
                        key={m.id}
                        message={m}
                        arrived={arrived}
                        onSignIn={onSignIn}
                        onRetry={
                          m.id === retryId && retryText ? () => sendText(retryText) : undefined
                        }
                      />
                    );
                  case 'check_in':
                    return <CheckInLine key={m.id} message={m} arrived={arrived} />;
                  case 'note':
                    return <NoteLine key={m.id} message={m} arrived={arrived} />;
                  default:
                    return null;
                }
              }),
              indicator.mounted && (
                <WorkingIndicator
                  key="working"
                  activity={agent.status.activity}
                  entering={indicator.entering}
                  leaving={indicator.leaving}
                  onExited={indicator.onExited}
                />
              )
            )
          )}
          {items.length === 0 && indicator.mounted && (
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
        {jump.mounted && (
          <IconButton
            tabIndex={0}
            size="compact"
            className="agent-chat__jump"
            data-leaving={jump.leaving || undefined}
            onAnimationEnd={jump.leaving ? jump.onExited : undefined}
            icon={<ArrowDownIcon size={14} />}
            onClick={scrollToBottom}
            aria-label="Jump to latest"
            title="Jump to latest"
          />
        )}

        {blocked && (
          <p className="agent-composer__notice" role="alert">
            <span>{blocked.message}</span>
            {blocked.settings && (
              <TextButton
                variant="accent"
                onClick={() => {
                  const url = blocked.settings;
                  if (url) void openPrivacySettings(url);
                }}
              >
                Open System Settings
              </TextButton>
            )}
            <TextButton onClick={dictation.dismissBlocked}>Dismiss</TextButton>
          </p>
        )}

        {engineReady ? (
          <form
            className="agent-composer"
            data-dictation={dictation.phase}
            data-has-attachments={staged.length > 0 || quotes.length > 0 || undefined}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            {mentionPicker.menu}
            <ComposerQuotes quotes={quotes} onRemove={removeQuote} />
            <ComposerAttachments items={staged} onRemove={attachments.remove} />
            <TextArea
              ref={inputRef}
              className="agent-composer__input"
              rows={1}
              value={draft}
              placeholder={dictating ? 'Listening…' : `Message ${agent.name}`}
              readOnly={dictating}
              onChange={(e) => {
                setDraft(e.target.value);
                mentionPicker.sync();
              }}
              onSelect={mentionPicker.sync}
              onPaste={attachments.onPaste}
              onKeyDown={(e) => {
                if (dictation.onComposerKeyDown(e)) return;
                if (mentionPicker.onKeyDown(e)) return;
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(e.metaKey);
                } else if (e.key === 'Escape' && onEscape?.()) {
                  e.preventDefault();
                } else if (e.key === 'Escape' && working && !canSend) {
                  e.preventDefault();
                  void onStop();
                }
              }}
              aria-label={`Message ${agent.name}`}
            />
            <div className="agent-composer__bar">
              {dictating ? (
                <span className="agent-composer__listening" role="status">
                  <span className="agent-composer__listening-dot" aria-hidden />
                  {dictation.phase === 'finishing' ? 'Finishing…' : 'Listening'}
                  <span aria-hidden>·</span>
                  <TextButton tabIndex={0} onClick={dictation.cancel}>
                    Cancel
                  </TextButton>
                </span>
              ) : (
                <IconButton
                  tabIndex={0}
                  variant="ghost"
                  className="agent-composer__attach"
                  icon={<PaperclipIcon size={14} />}
                  onClick={pickFiles}
                  aria-label="Attach files"
                  title="Attach files, or paste or drop them here"
                />
              )}
              <div className="agent-composer__actions">
                {busy && canSend && !dictating && (
                  <span className="agent-composer__hint" aria-hidden>
                    ↵ queues · ⌘↵ interrupts and sends now
                  </span>
                )}
                <IconButton
                  ref={micRef}
                  tabIndex={0}
                  variant="ghost"
                  className="agent-composer__mic"
                  icon={<MicrophoneIcon size={14} />}
                  onClick={dictation.toggle}
                  disabled={dictation.phase === 'finishing'}
                  aria-pressed={dictating}
                  aria-label={dictating ? 'Stop dictating' : 'Dictate'}
                  title={
                    dictating ? 'Stop dictating (Esc to discard)' : 'Dictate (⌘⇧D, or hold ⌥Space)'
                  }
                />
                {working && !canSend && !dictating ? (
                  <IconButton
                    tabIndex={0}
                    variant="secondary"
                    className="agent-composer__stop"
                    icon={<span className="agent-composer__stop-square" aria-hidden />}
                    onClick={() => void onStop()}
                    aria-label={`Stop ${agent.name}`}
                    title="Stop (Esc)"
                  />
                ) : (
                  <IconButton
                    tabIndex={0}
                    type="submit"
                    variant={canSend && !dictating ? 'primary' : 'secondary'}
                    className="agent-composer__send"
                    icon={<ArrowUpIcon size={14} />}
                    disabled={!canSend || dictating}
                    aria-label="Send"
                    title={
                      busy
                        ? `Queue it: ${agent.name} reads it when it finishes (↵). Interrupt and send now: ⌘↵`
                        : 'Send'
                    }
                  />
                )}
              </div>
            </div>
          </form>
        ) : (
          <div className="agent-composer agent-composer--blocked" role="status">
            <WarningIcon size={14} className="agent-composer__blocked-icon" />
            <span className="agent-composer__blocked-text">
              Agents run on Claude Code, which isn&apos;t installed on this Mac yet.
            </span>
            <Button tabIndex={0} variant="primary" onClick={onSetUpEngine}>
              Set up Claude Code
            </Button>
          </div>
        )}
      </div>

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
          Drop files for {agent.name}
        </div>
      </div>
    </section>
  );
}

/** The rows, with `extra` (if any) slotted in before row `at`. */
function withIndicatorAt(at: number, rows: ReactNode[], extra: ReactNode): ReactNode[] {
  if (!extra) return rows;
  return [...rows.slice(0, at), extra, ...rows.slice(at)];
}
