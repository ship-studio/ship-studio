/**
 * Tests for SetupItem component — all status variants.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SetupItem } from './SetupItem';
import type { SetupItem as SetupItemType } from '../../lib/setup';

function makeItem(overrides: Partial<SetupItemType> = {}): SetupItemType {
  return {
    id: 'node',
    friendlyName: 'Node.js',
    status: 'not_installed',
    ...overrides,
  };
}

describe('SetupItem', () => {
  // ============ Ready status ============

  it('renders "ready" status with checkmark icon and version string', () => {
    const item = makeItem({ status: 'ready', version: 'v20.11.0' });
    render(<SetupItem item={item} />);

    expect(screen.getByText('Node.js')).toBeInTheDocument();
    expect(screen.getByText('v20.11.0')).toBeInTheDocument();
    // Checkmark icon should be present
    expect(document.querySelector('.setup-item-icon-check')).toBeInTheDocument();
  });

  it('renders "ready" with username for auth items', () => {
    const item = makeItem({
      id: 'gh_auth',
      friendlyName: 'GitHub Account',
      status: 'ready',
      username: 'testuser',
    });
    render(<SetupItem item={item} />);

    expect(screen.getByText('testuser')).toBeInTheDocument();
  });

  // ============ Not installed status ============

  it('renders "not_installed" with Install button and time estimate', () => {
    const item = makeItem({ status: 'not_installed' });
    render(<SetupItem item={item} onAction={vi.fn()} />);

    expect(screen.getByText('Install')).toBeInTheDocument();
    expect(screen.getByText('~10 sec')).toBeInTheDocument();
  });

  // ============ Not authenticated status ============

  it('renders "not_authenticated" with Connect button and time estimate', () => {
    const item = makeItem({
      id: 'claude_auth',
      friendlyName: 'Claude Account',
      status: 'not_authenticated',
    });
    render(<SetupItem item={item} onAction={vi.fn()} />);

    expect(screen.getByText('Connect')).toBeInTheDocument();
    expect(screen.getByText('~15 sec')).toBeInTheDocument();
  });

  it('renders "not_authenticated" with Skip button when optional', () => {
    const item = makeItem({
      id: 'claude_auth',
      friendlyName: 'Claude Account',
      status: 'not_authenticated',
    });
    render(<SetupItem item={item} onAction={vi.fn()} onSkip={vi.fn()} isOptional={true} />);

    expect(screen.getByText('Skip')).toBeInTheDocument();
    expect(screen.getByText('Connect')).toBeInTheDocument();
  });

  it('does NOT show Skip when not optional', () => {
    const item = makeItem({
      id: 'claude_auth',
      friendlyName: 'Claude Account',
      status: 'not_authenticated',
    });
    render(<SetupItem item={item} onAction={vi.fn()} />);

    expect(screen.queryByText('Skip')).not.toBeInTheDocument();
  });

  // ============ In progress status ============

  it('renders "in_progress" with spinner and progress message', () => {
    const item = makeItem({ status: 'in_progress' });
    render(<SetupItem item={item} />);

    expect(screen.getByText('Installing Node.js...')).toBeInTheDocument();
    expect(document.querySelector('.ss-spinner')).toBeInTheDocument();
  });

  it('renders "in_progress" with brew hint for brew packages', () => {
    const item = makeItem({ id: 'node', friendlyName: 'Node.js', status: 'in_progress' });
    render(<SetupItem item={item} />);

    expect(screen.getByText('This may take a few minutes')).toBeInTheDocument();
  });

  it('does not show brew hint for non-brew packages', () => {
    const item = makeItem({
      id: 'claude',
      friendlyName: 'Claude Code',
      status: 'in_progress',
    });
    render(<SetupItem item={item} />);

    expect(screen.queryByText('This may take a few minutes')).not.toBeInTheDocument();
  });

  // ============ Error status ============

  it('renders "error" with error message and Retry button', () => {
    const item = makeItem({
      status: 'error',
      errorMessage: 'Installation failed: no space left on device',
    });
    render(<SetupItem item={item} onAction={vi.fn()} />);

    expect(screen.getByText('Installation failed: no space left on device')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  // ============ Blocked status ============

  it('renders "blocked" with "Waiting for X" message', () => {
    const item = makeItem({ status: 'blocked' });
    render(<SetupItem item={item} blockedBy={['Package Manager']} />);

    expect(screen.getByText('Unlocks after Package Manager')).toBeInTheDocument();
  });

  // ============ Button disabled states ============

  it('Install button disabled when isAnyActionInProgress=true', () => {
    const item = makeItem({ status: 'not_installed' });
    render(<SetupItem item={item} onAction={vi.fn()} isAnyActionInProgress={true} />);

    const btn = screen.getByText('Install');
    expect(btn).toBeDisabled();
  });

  it('Retry button disabled when isAnyActionInProgress=true', () => {
    const item = makeItem({ status: 'error', errorMessage: 'Failed' });
    render(<SetupItem item={item} onAction={vi.fn()} isAnyActionInProgress={true} />);

    const btn = screen.getByText('Retry');
    expect(btn).toBeDisabled();
  });

  // ============ Optional badge ============

  it('shows Optional badge when optional and not ready', () => {
    const item = makeItem({ status: 'not_installed' });
    render(<SetupItem item={item} isOptional={true} />);

    expect(screen.getByText('Optional')).toBeInTheDocument();
  });

  it('does NOT show Optional badge when ready', () => {
    const item = makeItem({ status: 'ready', version: 'v20.11.0' });
    render(<SetupItem item={item} isOptional={true} />);

    expect(screen.queryByText('Optional')).not.toBeInTheDocument();
  });

  // ============ Click handler ============

  it('click Install calls onAction callback', () => {
    const onAction = vi.fn();
    const item = makeItem({ status: 'not_installed' });
    render(<SetupItem item={item} onAction={onAction} />);

    fireEvent.click(screen.getByText('Install'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('click Connect calls onAction callback', () => {
    const onAction = vi.fn();
    const item = makeItem({
      id: 'claude_auth',
      friendlyName: 'Claude Account',
      status: 'not_authenticated',
    });
    render(<SetupItem item={item} onAction={onAction} />);

    fireEvent.click(screen.getByText('Connect'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('click Retry calls onAction callback', () => {
    const onAction = vi.fn();
    const item = makeItem({ status: 'error', errorMessage: 'Failed' });
    render(<SetupItem item={item} onAction={onAction} />);

    fireEvent.click(screen.getByText('Retry'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
