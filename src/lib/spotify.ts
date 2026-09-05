/**
 * Spotify "now playing" widget — invoke wrappers and types.
 *
 * macOS-only. The backend never launches Spotify: `not_running` is a normal
 * idle state (Spotify.app isn't open), not an error. Whether the widget is
 * shown at all is a separate opt-in preference — see `getSpotifyWidgetEnabled`
 * / `setSpotifyWidgetEnabled` in `./settings`.
 *
 * @module lib/spotify
 */

import { invoke } from '@tauri-apps/api/core';

export type SpotifyStatus = 'ok' | 'not_running' | 'permission_denied' | 'unsupported';
export type SpotifyPlayerState = 'playing' | 'paused' | 'stopped' | null;

export interface SpotifyState {
  status: SpotifyStatus;
  playerState: SpotifyPlayerState;
  trackName: string | null;
  artist: string | null;
  album: string | null;
  artworkUrl: string | null;
  /** Playback position in seconds. */
  position: number | null;
  /** Track duration in seconds. */
  duration: number | null;
  /** Volume 0-100. */
  volume: number | null;
  shuffling: boolean | null;
  repeating: boolean | null;
}

export type SpotifyControlAction =
  | 'playpause'
  | 'next'
  | 'previous'
  | 'seek'
  | 'volume'
  | 'activate';

/** Fetch the current Spotify.app now-playing state. Throws on unexpected
 *  backend failure — `not_running` / `unsupported` / `permission_denied`
 *  are ordinary values on `status`, never a rejected promise. */
export async function getSpotifyState(): Promise<SpotifyState> {
  return invoke<SpotifyState>('get_spotify_state');
}

/**
 * Send a playback control action to Spotify.app.
 *
 * `value` is seconds for `seek`, 0-100 for `volume`; omit it for the rest.
 * `activate` brings Spotify to the foreground — the backend guards it to
 * only focus an already-running instance, never to launch it.
 */
export async function spotifyControl(action: SpotifyControlAction, value?: number): Promise<void> {
  await invoke('spotify_control', { action, value });
}
