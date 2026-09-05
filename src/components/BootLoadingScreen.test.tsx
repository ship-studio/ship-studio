/**
 * Tests for the boot loading screen watchdog (#173): the progress bar must give
 * way to a restart prompt if the app is still deciding its initial view
 * after BOOT_WATCHDOG_MS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const relaunchMock = vi.fn();
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: (...args: unknown[]) => relaunchMock(...args) as Promise<void>,
}));

import { BootLoadingScreen, BOOT_WATCHDOG_MS } from './BootLoadingScreen';

describe('BootLoadingScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    relaunchMock.mockReset();
    relaunchMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the logo and progress bar initially', () => {
    render(<BootLoadingScreen />);
    expect(screen.getByAltText('Ship Studio')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Starting Ship Studio' })).toHaveAttribute(
      'aria-valuenow',
      '0'
    );
    expect(screen.queryByText(/taking longer than expected/)).not.toBeInTheDocument();
  });

  it('does not show the watchdog just before the deadline', () => {
    render(<BootLoadingScreen />);
    act(() => {
      vi.advanceTimersByTime(BOOT_WATCHDOG_MS - 1);
    });
    expect(screen.queryByText(/taking longer than expected/)).not.toBeInTheDocument();
  });

  it('swaps the progress bar for a restart prompt after the watchdog fires', () => {
    render(<BootLoadingScreen />);
    act(() => {
      vi.advanceTimersByTime(BOOT_WATCHDOG_MS);
    });
    expect(screen.getByText(/taking longer than expected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart Ship Studio' })).toBeInTheDocument();
    expect(screen.getByText(/~\/Library\/Logs\/ShipStudio\//)).toBeInTheDocument();
  });

  it('calls relaunch when the restart button is clicked', async () => {
    render(<BootLoadingScreen />);
    act(() => {
      vi.advanceTimersByTime(BOOT_WATCHDOG_MS);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restart Ship Studio' }));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });
});
