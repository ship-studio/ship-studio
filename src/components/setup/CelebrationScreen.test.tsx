/**
 * Tests for CelebrationScreen component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CelebrationScreen } from './CelebrationScreen';

describe('CelebrationScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders "You\'re all set!" text', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} hostingConnected={true} />);

    expect(screen.getByText("You're all set!")).toBeInTheDocument();
    expect(screen.getByText('Everything is installed and connected')).toBeInTheDocument();
  });

  it('does not claim everything is connected when hosting was skipped', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} hostingConnected={false} />);

    expect(screen.getByText('Your dev environment is ready')).toBeInTheDocument();
    expect(screen.queryByText('Everything is installed and connected')).not.toBeInTheDocument();
  });

  it('calls onContinue after 2500ms auto-timer', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} hostingConnected={true} />);

    expect(onContinue).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('click "Get Started" calls onContinue immediately', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} hostingConnected={true} />);

    fireEvent.click(screen.getByText('Get Started'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('fires onContinue exactly once when the button is clicked before the auto-timer', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} hostingConnected={true} />);

    fireEvent.click(screen.getByText('Get Started'));
    expect(onContinue).toHaveBeenCalledTimes(1);

    // The pending auto-advance timer must not fire a second continue
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('fires onContinue exactly once on rapid double-click', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} hostingConnected={true} />);

    const button = screen.getByRole('button');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('fires onContinue exactly once when the auto-timer wins, then the button is clicked', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} hostingConnected={true} />);

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(onContinue).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('shows a pending spinner on the button after clicking (completion can take seconds)', () => {
    const onContinue = vi.fn();
    render(<CelebrationScreen onContinue={onContinue} hostingConnected={true} />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(screen.queryByText('Get Started')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('animates in (visible class applied after 100ms)', () => {
    const onContinue = vi.fn();
    const { container } = render(
      <CelebrationScreen onContinue={onContinue} hostingConnected={true} />
    );

    const screenEl = container.querySelector('.celebration-screen');
    expect(screenEl).not.toHaveClass('visible');

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(screenEl).toHaveClass('visible');
  });
});
