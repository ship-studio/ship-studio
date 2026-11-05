/**
 * Quick entry: the floating composer the quick-message shortcut (⌥Space by
 * default) opens over any app. It is its own window (`quick-entry`), created
 * hidden at launch, so the shortcut only shows it.
 *
 * - Addressed to the Chief of Staff; a leading "@Name" sends it to that agent
 *   instead, and the "To" line says who it goes to as you type.
 * - Dictation is the chat composer's own (`useDictation`); the screenshot
 *   button runs macOS's `screencapture -i` and attaches the result.
 * - Return sends: the message is queued like any other, focus goes back to
 *   the app you were in, and for a moment a line confirms it with "Open chat".
 * - Esc closes; clicking elsewhere closes.
 *
 * Its window follows its height, so it never shows a frame of empty space.
 *
 * @module components/agents/QuickEntry
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ArrowUpIcon, CameraIcon, CheckIcon, MicrophoneIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import { TextArea } from '../primitives/TextField';
import { AgentAvatar } from './AgentAvatar';
import { ComposerAttachments } from './AgentAttachments';
import { useMentionPicker } from './AgentMentions';
import { useDictation } from './useDictation';
import { toOutgoing, useComposerAttachments } from './useComposerAttachments';
import {
  getAgentsOverview,
  mentionedAgents,
  sendAgentMessage,
  sortAgents,
  type Agent,
} from '../../lib/agents';
import {
  QUICK_ENTRY_EVENTS,
  captureForQuickEntry,
  hideQuickEntry,
  openQuickEntryChat,
  quickEntryRecipient,
  quickEntrySent,
  resizeQuickEntry,
} from '../../lib/agentsDesktop';
import { blockedCopy, dictationVocabulary, openPrivacySettings } from '../../lib/dictation';
import { asCommandError, formatCommandError } from '../../lib/errors';

/** How long "Sent" stays up before the window hides itself. */
export const SENT_LINGER_MS = 2400;
/** Set once a screenshot has worked: the permission note has done its job. */
const SCREENSHOT_USED_KEY = 'shipstudio.quickEntry.screenshotUsed';

const readFlag = (key: string) => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

export function QuickEntry() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<{ agentId: string; name: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [screenshotUsed, setScreenshotUsed] = useState(() => readFlag(SCREENSHOT_USED_KEY));
  /** Bumped on every show, so the card enters again rather than just being there. */
  const [shown, setShown] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const attachments = useComposerAttachments(setProblem);
  const picker = useMentionPicker(agents, inputRef, setDraft);
  const getVocabulary = useCallback(
    () =>
      Promise.resolve(
        dictationVocabulary(
          agents.map((a) => a.name),
          []
        )
      ),
    [agents]
  );
  const dictation = useDictation({
    getDraft: () => draftRef.current,
    setDraft,
    getVocabulary,
    meterRef: micRef,
    enabled: true,
  });
  const dictating = dictation.phase !== 'idle';
  const blocked = dictation.blocked ? blockedCopy(dictation.blocked) : null;

  const load = useCallback(async () => {
    try {
      const overview = await getAgentsOverview();
      setAgents(sortAgents(overview.agents.filter((a) => !a.hidden)));
    } catch (error) {
      setProblem(formatCommandError(asCommandError(error)));
    }
  }, []);

  // Each time it is shown: a clean slate, the team as it is now, the caret in the field.
  useEffect(() => {
    void load();
    const unlisten = listen(QUICK_ENTRY_EVENTS.shown, () => {
      setShown((n) => n + 1);
      setSent(null);
      setProblem(null);
      void load();
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    return () => void unlisten.then((off) => off());
  }, [load]);

  // The window is exactly as tall as what it shows.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(
      () => void resizeQuickEntry(el.offsetHeight).catch(() => {})
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const close = useCallback(() => {
    if (dictating) dictation.cancel();
    void hideQuickEntry();
  }, [dictating, dictation]);

  // "Sent" lingers, then the window puts itself away.
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => void hideQuickEntry(), SENT_LINGER_MS);
    return () => clearTimeout(timer);
  }, [sent]);

  const recipient = useMemo(() => quickEntryRecipient(draft, agents), [draft, agents]);
  const to = recipient.agent;
  const canSend =
    !!to &&
    !sending &&
    !dictating &&
    (recipient.text.trim().length > 0 || attachments.items.length > 0);

  const send = async () => {
    if (!canSend || !to) return;
    setSending(true);
    setProblem(null);
    try {
      const outgoing = await toOutgoing(attachments.items);
      const others = agents.filter((a) => a.id !== to.id);
      const mentions = mentionedAgents(recipient.text, others).map((a) => a.id);
      await sendAgentMessage(to.id, recipient.text.trim(), outgoing, mentions);
      setDraft('');
      attachments.setItems([]);
      setSent({ agentId: to.id, name: to.name });
      void quickEntrySent().catch(() => {});
    } catch (error) {
      setProblem(formatCommandError(asCommandError(error)));
    } finally {
      setSending(false);
    }
  };

  const screenshot = async () => {
    setCapturing(true);
    setProblem(null);
    try {
      const path = await captureForQuickEntry();
      if (path) {
        await attachments.addPaths([path]);
        try {
          localStorage.setItem(SCREENSHOT_USED_KEY, '1');
        } catch {
          /* the note just shows again next time */
        }
        setScreenshotUsed(true);
      }
    } catch (error) {
      setProblem(formatCommandError(asCommandError(error)));
    } finally {
      setCapturing(false);
      inputRef.current?.focus();
    }
  };

  if (sent) {
    return (
      <div ref={rootRef} className="quick-entry" data-state="sent">
        <div className="quick-entry__sent" role="status">
          <CheckIcon size={14} className="quick-entry__sent-icon" />
          <span className="quick-entry__sent-text">Sent to {sent.name}</span>
          <TextButton
            tabIndex={0}
            variant="accent"
            onClick={() => void openQuickEntryChat(sent.agentId)}
          >
            Open chat
          </TextButton>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="quick-entry" data-state="compose">
      <form
        key={shown}
        className="agent-composer quick-entry__composer"
        data-dictation={dictation.phase}
        data-has-attachments={attachments.items.length > 0 || undefined}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="quick-entry__to">
          <span className="quick-entry__to-label">To</span>
          {to ? (
            <>
              <AgentAvatar name={to.name} color={to.color} size="mini" />
              <span className="quick-entry__to-name">{to.name}</span>
            </>
          ) : (
            <span className="quick-entry__to-name">…</span>
          )}
          {!recipient.addressed && (
            <span className="quick-entry__to-hint">@name for another agent</span>
          )}
          <span className="quick-entry__esc" aria-hidden>
            esc
          </span>
        </div>
        <ComposerAttachments items={attachments.items} onRemove={attachments.remove} />
        <TextArea
          ref={inputRef}
          autoFocus
          className="agent-composer__input quick-entry__input"
          rows={1}
          value={draft}
          placeholder={dictating ? '' : `Message ${to?.name ?? 'your agents'}`}
          readOnly={dictating}
          onChange={(e) => {
            setDraft(e.target.value);
            picker.sync();
          }}
          onSelect={picker.sync}
          onPaste={attachments.onPaste}
          onKeyDown={(e) => {
            if (dictation.onComposerKeyDown(e)) return;
            if (picker.onKeyDown(e)) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
          aria-label={`Message ${to?.name ?? 'an agent'}`}
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
              className="agent-composer__attach quick-entry__shot"
              icon={<CameraIcon size={14} />}
              onClick={() => void screenshot()}
              disabled={capturing}
              aria-label="Attach a screenshot"
              title="Attach a screenshot: drag to select, or press Space and click a window"
            />
          )}
          <div className="agent-composer__actions">
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
              title={dictating ? 'Stop dictating (Esc to discard)' : 'Dictate (⌘⇧D)'}
            />
            <IconButton
              tabIndex={0}
              type="submit"
              variant={canSend ? 'primary' : 'secondary'}
              className="agent-composer__send"
              icon={<ArrowUpIcon size={14} />}
              disabled={!canSend}
              aria-label="Send"
              title="Send (↵)"
            />
          </div>
        </div>
        {picker.menu}
        {(problem || blocked || !screenshotUsed) && (
          <p className="quick-entry__note" role={problem || blocked ? 'alert' : undefined}>
            {problem ?? blocked?.message ?? (
              <>
                Screenshots need Screen Recording permission. macOS asks the first time; allow Ship
                Studio, then try again.
              </>
            )}
            {!problem && blocked?.settings && (
              <TextButton
                variant="accent"
                onClick={() => {
                  if (blocked.settings) void openPrivacySettings(blocked.settings);
                }}
              >
                Open System Settings
              </TextButton>
            )}
          </p>
        )}
      </form>
    </div>
  );
}
