/**
 * Dictation into the agent composer.
 *
 * Click the mic or press ⌘⇧D to toggle; hold ⌥Space in the composer to talk
 * while held. Escape cancels and puts back what was typed before. Spoken text
 * goes after whatever was already in the draft and is never sent on its own.
 *
 * The level meter is written straight to a CSS variable on `meterRef`, so the
 * ~15 updates a second don't re-render the conversation.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { MicrophoneIcon } from '@/components/icons';
import { useCommands } from '../../commands/useCommands';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  cancelDictation,
  joinDictation,
  onDictationEvent,
  startDictation,
  stopDictation,
  type DictationBlock,
} from '../../lib/dictation';
import { asCommandError, formatCommandError } from '../../lib/errors';

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing';

interface Options {
  getDraft: () => string;
  /** Must be stable (a useState setter). */
  setDraft: (text: string) => void;
  /** Names worth recognising: agents, projects. */
  vocabulary: string[];
  meterRef: RefObject<HTMLElement | null>;
  enabled: boolean;
}

export function useDictation({ getDraft, setDraft, vocabulary, meterRef, enabled }: Options) {
  const { showToast } = useOptionalToast();
  const [phase, setPhaseState] = useState<DictationPhase>('idle');
  const [blocked, setBlocked] = useState<DictationBlock | null>(null);
  const phaseRef = useRef<DictationPhase>('idle');
  const sessionRef = useRef<number | null>(null);
  const baseRef = useRef('');
  /** A stop or cancel asked for before the session id came back. */
  const pendingRef = useRef<'stop' | 'cancel' | null>(null);
  const holdingRef = useRef(false);

  const setPhase = useCallback((next: DictationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const setLevel = useCallback(
    (level: number) => meterRef.current?.style.setProperty('--dictation-level', String(level)),
    [meterRef]
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void onDictationEvent((event) => {
      if (event.session !== sessionRef.current) return;
      switch (event.kind) {
        case 'partial':
        case 'final':
          setDraft(joinDictation(baseRef.current, event.text));
          break;
        case 'level':
          setLevel(event.level);
          break;
        case 'error':
          showToast(event.message, 'error');
          break;
        case 'ended':
          if (event.cancelled && phaseRef.current !== 'finishing') {
            setDraft(baseRef.current);
          }
          sessionRef.current = null;
          holdingRef.current = false;
          setLevel(0);
          setPhase('idle');
          break;
      }
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
      if (sessionRef.current !== null) void cancelDictation(sessionRef.current);
    };
  }, [setDraft, setLevel, setPhase, showToast]);

  const stop = useCallback(() => {
    holdingRef.current = false;
    if (phaseRef.current === 'starting') pendingRef.current = 'stop';
    if (phaseRef.current !== 'listening' || sessionRef.current === null) return;
    setPhase('finishing');
    setLevel(0);
    void stopDictation(sessionRef.current);
  }, [setLevel, setPhase]);

  const cancel = useCallback(() => {
    holdingRef.current = false;
    if (phaseRef.current === 'starting') pendingRef.current = 'cancel';
    const session = sessionRef.current;
    if (session === null) return;
    sessionRef.current = null;
    setDraft(baseRef.current);
    setLevel(0);
    setPhase('idle');
    void cancelDictation(session);
  }, [setDraft, setLevel, setPhase]);

  const start = useCallback(async () => {
    if (!enabled || phaseRef.current !== 'idle') return;
    baseRef.current = getDraft();
    pendingRef.current = null;
    setBlocked(null);
    setPhase('starting');
    try {
      const result = await startDictation(vocabulary);
      if (result.status === 'blocked') {
        setBlocked(result.reason);
        setPhase('idle');
        return;
      }
      sessionRef.current = result.session;
      setPhase('listening');
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending === 'stop') stop();
      else if (pending === 'cancel') cancel();
    } catch (error) {
      setPhase('idle');
      showToast(formatCommandError(asCommandError(error)), 'error');
    }
  }, [enabled, getDraft, vocabulary, setPhase, stop, cancel, showToast]);

  const toggle = useCallback(() => {
    if (phaseRef.current === 'idle') void start();
    else stop();
  }, [start, stop]);

  /** Composer keys: hold ⌥Space to talk, Escape to cancel. True if handled. */
  const onComposerKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!e.repeat && phaseRef.current === 'idle') {
          holdingRef.current = true;
          void start();
        }
        return true;
      }
      if (e.key === 'Escape' && phaseRef.current !== 'idle') {
        e.preventDefault();
        cancel();
        return true;
      }
      return false;
    },
    [start, cancel]
  );

  // Releasing either key of the hold ends it; ⌘⇧D toggles from anywhere in
  // the chat. Window-level so a release outside the composer still counts.
  useEffect(() => {
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (holdingRef.current && (e.code === 'Space' || e.key === 'Alt')) stop();
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.code === 'KeyD' && !e.repeat) {
        e.preventDefault();
        toggle();
      }
    };
    const onBlur = () => {
      if (holdingRef.current) stop();
    };
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [stop, toggle]);

  useCommands(
    () =>
      enabled
        ? [
            {
              id: 'agents.dictate',
              title: phase === 'idle' ? 'Dictate a message' : 'Stop dictating',
              icon: <MicrophoneIcon size={14} />,
              category: 'action',
              shortcut: '⌘⇧D',
              keywords: ['voice', 'speak', 'microphone', 'speech', 'talk'],
              run: toggle,
            },
          ]
        : [],
    [enabled, phase, toggle]
  );

  return {
    phase,
    blocked,
    dismissBlocked: () => setBlocked(null),
    toggle,
    cancel,
    onComposerKeyDown,
  };
}
