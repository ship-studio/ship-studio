/**
 * Spotify "now playing" sidebar widget — macOS-only, opt-in.
 *
 * Renders nothing at all unless the user has turned it on in Settings
 * ("Spotify controls") and macOS reports Spotify.app is actually open.
 * `not_running` and `unsupported` are ordinary idle states, not errors: the
 * widget silently appears when playback starts and disappears when Spotify
 * quits. `permission_denied` gets its own small explanatory state.
 *
 * Mounted once in `WorkspaceSidebar`, directly below the search row, so it
 * shows on both the dashboard home and the project workspace.
 *
 * @module components/workspace/SpotifyWidget
 */

import { useCallback, useEffect, useState, type ChangeEvent, type SyntheticEvent } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AlertIcon, PauseIcon, PlayIcon, SkipNextIcon, SkipPreviousIcon } from '@/components/icons';
import SpotifyLogoGraphic from '@/assets/graphics/spotify-logo.svg?react';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { usePolling } from '../../hooks/usePolling';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useCommands } from '../../commands/useCommands';
import { isMac } from '../../lib/setup';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { getSpotifyState, spotifyControl, type SpotifyState } from '../../lib/spotify';
import { getSpotifyWidgetEnabled, SPOTIFY_WIDGET_ENABLED_CHANGED_EVENT } from '../../lib/settings';

/** Poll roughly every second while a track is actually playing. */
const PLAYING_INTERVAL_MS = 1000;
/** Back off while paused, idle, or Spotify isn't running — each poll spawns
 *  a process on the Rust side, so idle cost matters. */
const IDLE_INTERVAL_MS = 5000;

/** macOS System Settings deep link to Privacy & Security → Automation. */
const AUTOMATION_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';

interface SpotifyWidgetProps {
  /** Sidebar is collapsed to an icon rail. */
  isSidebarHidden?: boolean;
}

function isWindowActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function trackTitle(trackName: string | null, artist: string | null): string | undefined {
  if (!trackName) return undefined;
  return artist ? `${trackName} — ${artist}` : trackName;
}

/** mm:ss for the seek control's accessible value text. Assumes `seconds` is
 *  a known, non-negative number — callers only invoke this once duration and
 *  position are both confirmed present. */
function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function SpotifyWidget({ isSidebarHidden }: SpotifyWidgetProps) {
  const { showToast } = useOptionalToast();
  const mac = isMac();

  const [enabled, setEnabled] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(isWindowActive);
  const [state, setState] = useState<SpotifyState | null>(null);
  // Flips the icon/position immediately on click; cleared as soon as a fresh
  // poll reconciles with the real state, so a stuck backend can't leave it lying.
  const [optimisticPlaying, setOptimisticPlaying] = useState<boolean | null>(null);
  const [optimisticPosition, setOptimisticPosition] = useState<number | null>(null);

  // Load the opt-in once and react live to the Settings modal's toggle — the
  // sidebar and the modal aren't in the same subtree, so this is the sync path.
  useEffect(() => {
    if (!mac) return;
    let cancelled = false;
    void getSpotifyWidgetEnabled().then((value) => {
      if (!cancelled) setEnabled(value);
    });
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail;
      if (typeof detail === 'boolean') setEnabled(detail);
    };
    window.addEventListener(SPOTIFY_WIDGET_ENABLED_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(SPOTIFY_WIDGET_ENABLED_CHANGED_EVENT, onChanged);
    };
  }, [mac]);

  // Track whether this window is the one the user is looking at, so polling
  // can stop entirely rather than just backing off.
  useEffect(() => {
    const update = () => setIsWindowFocused(isWindowActive());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

  const poll = useCallback(async () => {
    try {
      const next = await getSpotifyState();
      setState(next);
      setOptimisticPlaying(null);
      setOptimisticPosition(null);
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    }
  }, [showToast]);

  const isPlayingNow = state?.status === 'ok' && state.playerState === 'playing';
  usePolling(poll, {
    intervalMs: isPlayingNow ? PLAYING_INTERVAL_MS : IDLE_INTERVAL_MS,
    enabled: mac && enabled && isWindowFocused,
    name: 'spotify-widget',
  });

  const handlePlayPause = useCallback(async () => {
    if (!state) return;
    const nextPlaying = !(optimisticPlaying ?? state.playerState === 'playing');
    setOptimisticPlaying(nextPlaying);
    try {
      await spotifyControl('playpause');
    } catch (err) {
      setOptimisticPlaying(null);
      showToast(formatCommandError(asCommandError(err)), 'error');
    }
  }, [state, optimisticPlaying, showToast]);

  const handleNext = useCallback(async () => {
    try {
      await spotifyControl('next');
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    }
  }, [showToast]);

  const handlePrevious = useCallback(async () => {
    try {
      await spotifyControl('previous');
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    }
  }, [showToast]);

  const handleOpenAutomationSettings = useCallback(() => {
    void openUrl(AUTOMATION_SETTINGS_URL);
  }, []);

  // Live-updates the painted fill while dragging/clicking; doesn't call the
  // backend by itself (React's onChange fires continuously for range inputs,
  // same as the native "input" event).
  const handleSeekChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setOptimisticPosition(Number(event.target.value));
  }, []);

  // Commits the seek once the interaction actually ends (mouse/touch release,
  // or a discrete keyboard step) rather than on every intermediate tick.
  const handleSeekCommit = useCallback(
    (event: SyntheticEvent<HTMLInputElement>) => {
      const value = Number(event.currentTarget.value);
      setOptimisticPosition(value);
      void (async () => {
        try {
          await spotifyControl('seek', value);
        } catch (err) {
          setOptimisticPosition(null);
          showToast(formatCommandError(asCommandError(err)), 'error');
        }
      })();
    },
    [showToast]
  );

  // Never launches Spotify — the backend guards `activate` to only focus an
  // already-running instance, matching the widget's "never launches" contract.
  const handleActivate = useCallback(async () => {
    try {
      await spotifyControl('activate');
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    }
  }, [showToast]);

  const isOk = state?.status === 'ok';
  const isPlaying = isOk ? (optimisticPlaying ?? state.playerState === 'playing') : false;

  useCommands(
    () => [
      {
        id: 'spotify.playPause',
        title: isPlaying ? 'Pause Spotify' : 'Play Spotify',
        category: 'action',
        keywords: ['music', 'spotify', 'pause', 'play'],
        when: () => mac && enabled && isOk,
        run: handlePlayPause,
      },
      {
        id: 'spotify.next',
        title: 'Next track',
        category: 'action',
        keywords: ['music', 'spotify', 'skip', 'forward'],
        when: () => mac && enabled && isOk,
        run: handleNext,
      },
      {
        id: 'spotify.previous',
        title: 'Previous track',
        category: 'action',
        keywords: ['music', 'spotify', 'skip', 'back'],
        when: () => mac && enabled && isOk,
        run: handlePrevious,
      },
    ],
    [mac, enabled, isOk, isPlaying, handlePlayPause, handleNext, handlePrevious]
  );

  if (!mac || !enabled || !state) return null;
  if (state.status === 'not_running' || state.status === 'unsupported') return null;

  if (state.status === 'permission_denied') {
    if (isSidebarHidden) return null;
    return (
      <div className="workspace-sidebar-spotify-panel spotify-widget-permission">
        <AlertIcon size={12} className="spotify-widget-permission-icon" />
        <div className="spotify-widget-permission-body">
          <span className="spotify-widget-permission-text">
            macOS blocked Ship Studio from controlling Spotify.
          </span>
          <Button variant="secondary" size="compact" onClick={handleOpenAutomationSettings}>
            Open Privacy Settings
          </Button>
        </div>
      </div>
    );
  }

  const position = optimisticPosition ?? state.position;
  const percent =
    position != null && state.duration != null && state.duration > 0
      ? Math.min(100, Math.max(0, (position / state.duration) * 100))
      : null;

  // The thumbnail doubles as a control: collapsed, it's the play/pause
  // affordance (there's no room for a separate button in the icon rail);
  // expanded, it opens Spotify.app (never launches it — see handleActivate).
  const thumbLabel = isSidebarHidden ? (isPlaying ? 'Pause' : 'Play') : 'Open Spotify';
  const handleThumbClick = isSidebarHidden ? handlePlayPause : handleActivate;

  return (
    <div className="workspace-sidebar-spotify-panel">
      <div className="spotify-widget-row">
        <button
          type="button"
          className="spotify-widget-thumb"
          onClick={() => void handleThumbClick()}
          title={thumbLabel}
          aria-label={thumbLabel}
        >
          {state.artworkUrl && <img src={state.artworkUrl} alt="" />}
          <SpotifyLogoGraphic className="spotify-widget-thumb-logo" aria-hidden="true" />
          <span className="spotify-widget-thumb-playicon" aria-hidden="true">
            {isPlaying ? <PauseIcon size={10} /> : <PlayIcon size={10} />}
          </span>
        </button>
        <span className="spotify-widget-track" title={trackTitle(state.trackName, state.artist)}>
          {state.trackName ?? 'Spotify'}
        </span>
        <div className="spotify-widget-controls">
          <IconButton
            className="spotify-widget-prev"
            variant="ghost"
            size="compact"
            icon={<SkipPreviousIcon size={12} />}
            onClick={() => void handlePrevious()}
            title="Previous track"
            aria-label="Previous track"
          />
          <IconButton
            className="spotify-widget-playpause"
            variant="ghost"
            size="compact"
            icon={isPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
            onClick={() => void handlePlayPause()}
            title={isPlaying ? 'Pause' : 'Play'}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          />
          <IconButton
            className="spotify-widget-next"
            variant="ghost"
            size="compact"
            icon={<SkipNextIcon size={12} />}
            onClick={() => void handleNext()}
            title="Next track"
            aria-label="Next track"
          />
        </div>
      </div>
      {percent !== null && position != null && state.duration != null && (
        <input
          type="range"
          className="spotify-widget-seek"
          min={0}
          max={state.duration}
          step={1}
          value={position}
          onChange={handleSeekChange}
          onMouseUp={handleSeekCommit}
          onTouchEnd={handleSeekCommit}
          onKeyUp={handleSeekCommit}
          style={{ ['--spotify-seek-percent' as string]: `${percent}%` }}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={state.duration}
          aria-valuenow={position}
          aria-valuetext={`${formatSeconds(position)} of ${formatSeconds(state.duration)}`}
        />
      )}
    </div>
  );
}
