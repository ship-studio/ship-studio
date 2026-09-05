/**
 * Tests for the Spotify "now playing" sidebar widget.
 *
 * Focus areas:
 * - Renders nothing when the opt-in preference is off.
 * - Renders nothing when Spotify isn't running / unsupported — these are
 *   normal idle states, not errors.
 * - Renders track info when the backend reports `ok`.
 * - Shows the dedicated explanation + action on `permission_denied`.
 *
 * The global test setup (`src/test/setup.ts`) already pins the platform to
 * macOS, so `isMac()` reads true without extra mocking here. It registers
 * its own `mockIPC` per test (like `AssetsPanel.test.tsx`) rather than the
 * shared `mockInvokeResponse` helper — the global handler is wired up once
 * in a top-level `beforeAll` but `afterEach` calls `vi.restoreAllMocks()`,
 * which tears down `window.__TAURI_INTERNALS__.invoke` after the first test
 * in the file, so any test beyond the first needs its own registration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { mockIPC } from '@tauri-apps/api/mocks';
import { SpotifyWidget } from './SpotifyWidget';
import type { SpotifyState } from '../../lib/spotify';

function state(overrides: Partial<SpotifyState> = {}): SpotifyState {
  return {
    status: 'ok',
    playerState: 'playing',
    trackName: 'Test Track',
    artist: 'Test Artist',
    album: 'Test Album',
    artworkUrl: null,
    position: 30,
    duration: 200,
    volume: 50,
    shuffling: false,
    repeating: false,
    ...overrides,
  };
}

let widgetEnabled = true;
let spotifyState: SpotifyState = state();
let controlCalls: Array<{ action: string; value?: number }> = [];

beforeEach(() => {
  widgetEnabled = true;
  spotifyState = state();
  controlCalls = [];

  // The widget needs the window to read as visible+focused to poll at all.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  });

  mockIPC((cmd, args) => {
    if (cmd === 'get_spotify_widget_enabled') return widgetEnabled;
    if (cmd === 'get_spotify_state') return spotifyState;
    if (cmd === 'spotify_control') {
      controlCalls.push(args as { action: string; value?: number });
      return undefined;
    }
    return undefined;
  });
});

describe('SpotifyWidget', () => {
  it('renders nothing when the widget is disabled', async () => {
    widgetEnabled = false;

    const { container } = render(<SpotifyWidget />);

    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText('Test Track')).not.toBeInTheDocument();
  });

  it('renders nothing when Spotify is not running', async () => {
    spotifyState = state({ status: 'not_running', playerState: null, trackName: null });

    const { container } = render(<SpotifyWidget />);

    // Wait for the poll to actually land before asserting the negative,
    // otherwise a still-null initial render would pass trivially.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when unsupported', async () => {
    spotifyState = state({ status: 'unsupported', playerState: null, trackName: null });

    const { container } = render(<SpotifyWidget />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(container.firstChild).toBeNull();
  });

  it('renders track info when status is ok', async () => {
    render(<SpotifyWidget />);

    expect(await screen.findByText('Test Track')).toBeInTheDocument();
    expect(screen.getByTitle('Test Track — Test Artist')).toBeInTheDocument();
    expect(screen.getByLabelText('Pause')).toBeInTheDocument();
    expect(screen.getByLabelText('Previous track')).toBeInTheDocument();
    expect(screen.getByLabelText('Next track')).toBeInTheDocument();
  });

  it('shows the permission-denied explanation and settings action', async () => {
    spotifyState = state({
      status: 'permission_denied',
      playerState: null,
      trackName: null,
      artist: null,
    });

    render(<SpotifyWidget />);

    expect(
      await screen.findByText(/macOS blocked Ship Studio from controlling Spotify/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Privacy Settings' })).toBeInTheDocument();
    // Not the "ok" transport row.
    expect(screen.queryByLabelText('Pause')).not.toBeInTheDocument();
  });

  it('does not render the permission-denied row when the sidebar is collapsed', async () => {
    spotifyState = state({ status: 'permission_denied', playerState: null, trackName: null });

    render(<SpotifyWidget isSidebarHidden />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByText(/macOS blocked/)).not.toBeInTheDocument();
  });

  it('optimistically flips the play/pause icon before the next poll', async () => {
    spotifyState = state({ playerState: 'playing' });

    render(<SpotifyWidget />);

    const pauseButton = await screen.findByLabelText('Pause');
    fireEvent.click(pauseButton);

    expect(await screen.findByLabelText('Play')).toBeInTheDocument();
  });

  it('renders an accessible seek slider reflecting position/duration, and commits a seek on release', async () => {
    spotifyState = state({ position: 30, duration: 200 });

    render(<SpotifyWidget />);

    const seek = await screen.findByLabelText('Seek');
    expect(seek).toHaveAttribute('aria-valuemin', '0');
    expect(seek).toHaveAttribute('aria-valuemax', '200');
    expect(seek).toHaveAttribute('aria-valuenow', '30');

    fireEvent.change(seek, { target: { value: '90' } });
    // Optimistic paint happens on change, before any commit.
    expect(seek).toHaveAttribute('aria-valuenow', '90');

    fireEvent.mouseUp(seek, { target: { value: '90' } });

    await waitFor(() => expect(controlCalls).toContainEqual({ action: 'seek', value: 90 }));
  });

  it('does not render a seek slider when duration is unknown', async () => {
    spotifyState = state({ position: 30, duration: null });

    render(<SpotifyWidget />);

    await screen.findByText('Test Track');
    expect(screen.queryByLabelText('Seek')).not.toBeInTheDocument();
  });

  it('clicking the thumbnail in the expanded layout activates Spotify', async () => {
    spotifyState = state();

    render(<SpotifyWidget />);

    const thumb = await screen.findByRole('button', { name: 'Open Spotify' });
    fireEvent.click(thumb);

    await waitFor(() =>
      expect(controlCalls).toContainEqual({ action: 'activate', value: undefined })
    );
  });

  it('clicking the thumbnail in the collapsed rail toggles play/pause instead of activating', async () => {
    spotifyState = state({ playerState: 'playing' });

    const { container } = render(<SpotifyWidget isSidebarHidden />);

    // Two elements share the "Pause" label in the collapsed layout — the
    // transport row's IconButton is only hidden via CSS (jsdom doesn't apply
    // stylesheets), so wait for the render then target the thumbnail
    // specifically by class.
    await screen.findAllByLabelText('Pause');
    const thumb = container.querySelector('.spotify-widget-thumb');
    expect(thumb).not.toBeNull();
    fireEvent.click(thumb as HTMLElement);

    await waitFor(() =>
      expect(controlCalls).toContainEqual({ action: 'playpause', value: undefined })
    );
    expect(controlCalls.some((call) => call.action === 'activate')).toBe(false);
  });
});
