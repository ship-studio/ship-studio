/**
 * The app's one store: the synced state (sync.ts) plus what the phone knows
 * about the link itself. Screens read slices with selectors, so a streaming
 * draft re-renders the bubble that shows it and nothing else.
 */

import type { LinkState, RefusedFrame, WelcomeFrame } from '@shipstudio/companion-protocol';
import { create } from 'zustand';
import type { ComposerDraft } from './drafts';
import type { Credentials } from './pairing';
import { emptySync, type SyncState } from './sync';

export interface AppState extends SyncState {
  /** Read from the keychain at launch; `undefined` until then. */
  credentials: Credentials | null | undefined;
  link: LinkState;
  welcome: WelcomeFrame | null;
  refusal: RefusedFrame | null;
  /** NetInfo's view of this phone: null until it has answered. */
  phoneOnline: boolean | null;
  /** The chat on screen (with the app in the foreground), for focus and alerts. */
  openChat: string | null;
  /** What's typed in each chat's composer and not sent: kept across screens and launches. */
  composer: Record<string, ComposerDraft>;
  prefs: Prefs;
  /** iOS Increase Contrast / Android high-contrast text. */
  highContrast: boolean;
}

export interface Prefs {
  haptics: boolean;
}

export const defaultPrefs: Prefs = { haptics: true };

export const useApp = create<AppState>(() => ({
  ...emptySync(),
  credentials: undefined,
  link: { kind: 'connecting', attempt: 0 },
  welcome: null,
  refusal: null,
  phoneOnline: null,
  openChat: null,
  composer: {},
  prefs: defaultPrefs,
  highContrast: false,
}));

export const setApp = useApp.setState;
export const getApp = useApp.getState;

/** Apply a pure sync transition to the store. */
export function update(fn: (s: SyncState) => SyncState) {
  useApp.setState((s) => fn(s));
}
