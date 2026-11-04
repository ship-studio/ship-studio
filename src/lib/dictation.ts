/**
 * Dictation: on-device Apple speech recognition (src-tauri/src/commands/dictation.rs).
 *
 * `startDictation` either starts one session or says why it can't; the
 * session's text, loudness and end arrive as `dictation://event` events.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';

export const DICTATION_EVENT = 'dictation://event';

export type DictationBlock =
  | 'microphone'
  | 'speechRecognition'
  | 'unavailable'
  | 'missingUsageDescription';

export type DictationStart =
  | { status: 'listening'; session: number }
  | { status: 'blocked'; reason: DictationBlock };

export type DictationEvent =
  | { kind: 'partial'; session: number; text: string }
  | { kind: 'final'; session: number; text: string }
  | { kind: 'level'; session: number; level: number }
  | { kind: 'error'; session: number; message: string }
  | { kind: 'ended'; session: number; cancelled: boolean };

export function startDictation(contextualStrings: string[]): Promise<DictationStart> {
  return invoke<DictationStart>('start_dictation', { contextualStrings });
}

export function stopDictation(session: number): Promise<void> {
  return invoke('stop_dictation', { session });
}

export function cancelDictation(session: number): Promise<void> {
  return invoke('cancel_dictation', { session });
}

export function onDictationEvent(handler: (event: DictationEvent) => void): Promise<UnlistenFn> {
  return listen<DictationEvent>(DICTATION_EVENT, (e) => handler(e.payload));
}

/** What to tell the user when dictation is blocked, and where to fix it. */
export function blockedCopy(reason: DictationBlock): { message: string; settings?: string } {
  switch (reason) {
    case 'microphone':
      return {
        message: 'Ship Studio needs microphone access to dictate.',
        settings: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      };
    case 'speechRecognition':
      return {
        message: 'Ship Studio needs speech recognition access to dictate.',
        settings:
          'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition',
      };
    case 'missingUsageDescription':
      return { message: 'This build of Ship Studio can’t ask for microphone access.' };
    case 'unavailable':
      return { message: 'Speech recognition isn’t available on this Mac right now.' };
  }
}

export function openPrivacySettings(url: string): Promise<void> {
  return openUrl(url);
}

/** Put dictated text after what was already typed, with one space between. */
export function joinDictation(base: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return base;
  if (!base) return said;
  return /\s$/.test(base) ? base + said : `${base} ${said}`;
}
