/**
 * ProjectRail tests.
 *
 * Focus areas:
 * - Empty state (no pins) renders nothing — the rail must not show
 *   visual chrome for users who haven't pinned anything yet.
 * - Each pin renders a button with the project name in its tooltip.
 * - Click invokes onPinClick with the project path.
 * - Right-click opens a context menu; clicking Unpin invokes onUnpin.
 * - Status dot class reflects the joined session+agent status.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockInvokeResponse } from '../test/setup';
import { ProjectRail } from './ProjectRail';
import type { PinnedProjectRow } from '../hooks/usePinnedProjects';

function row(overrides: Partial<PinnedProjectRow> = {}): PinnedProjectRow {
  return {
    projectPath: '/tmp/project-a',
    fallbackName: 'project-a',
    status: 'active',
    agentStatus: 'idle',
    unreadCount: 0,
    memoryBytes: 0,
    isCurrent: false,
    ...overrides,
  };
}

describe('ProjectRail', () => {
  // The rail asks for thumbnails on mount — return null so the placeholder shows.
  beforeEach(() => {
    mockInvokeResponse('get_project_thumbnail', null);
  });

  it('renders nothing when there are no pins', () => {
    const { container } = render(<ProjectRail rows={[]} onPinClick={vi.fn()} onUnpin={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a button per pin with the project name in the label', () => {
    render(
      <ProjectRail
        rows={[
          row({ projectPath: '/tmp/a', fallbackName: 'a' }),
          row({ projectPath: '/tmp/b', fallbackName: 'b' }),
          row({ projectPath: '/tmp/c', fallbackName: 'c' }),
        ]}
        onPinClick={vi.fn()}
        onUnpin={vi.fn()}
      />
    );
    expect(screen.getByLabelText(/^a/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^b/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^c/)).toBeInTheDocument();
  });

  it('invokes onPinClick with the project path when clicked', () => {
    const onPinClick = vi.fn();
    render(
      <ProjectRail
        rows={[row({ projectPath: '/tmp/clicked', fallbackName: 'clicked' })]}
        onPinClick={onPinClick}
        onUnpin={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText(/^clicked/));
    expect(onPinClick).toHaveBeenCalledWith('/tmp/clicked');
  });

  it('opens a context menu on right-click and unpin invokes onUnpin', () => {
    const onUnpin = vi.fn();
    render(
      <ProjectRail
        rows={[row({ projectPath: '/tmp/contextual', fallbackName: 'contextual' })]}
        onPinClick={vi.fn()}
        onUnpin={onUnpin}
      />
    );
    fireEvent.contextMenu(screen.getByLabelText(/^contextual/));
    const unpinBtn = screen.getByText(/Unpin from sidebar/i);
    fireEvent.click(unpinBtn);
    expect(onUnpin).toHaveBeenCalledWith('/tmp/contextual');
  });

  it('marks the current pin with the is-current class', () => {
    render(
      <ProjectRail
        rows={[
          row({ projectPath: '/tmp/a', fallbackName: 'a', isCurrent: false }),
          row({ projectPath: '/tmp/b', fallbackName: 'b', isCurrent: true }),
        ]}
        onPinClick={vi.fn()}
        onUnpin={vi.fn()}
      />
    );
    const bButton = screen.getByLabelText(/^b/);
    expect(bButton.className).toContain('is-current');
  });

  it('shows an unread badge when unreadCount > 0', () => {
    render(<ProjectRail rows={[row({ unreadCount: 3 })]} onPinClick={vi.fn()} onUnpin={vi.fn()} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('caps the badge display at 9+', () => {
    render(
      <ProjectRail rows={[row({ unreadCount: 27 })]} onPinClick={vi.fn()} onUnpin={vi.fn()} />
    );
    expect(screen.getByText('9+')).toBeInTheDocument();
  });

  it('does not show a badge when unreadCount is 0', () => {
    render(<ProjectRail rows={[row({ unreadCount: 0 })]} onPinClick={vi.fn()} onUnpin={vi.fn()} />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('uses the inactive dot for inactive sessions', () => {
    const { container } = render(
      <ProjectRail rows={[row({ status: 'inactive' })]} onPinClick={vi.fn()} onUnpin={vi.fn()} />
    );
    expect(container.querySelector('.dot-inactive')).toBeInTheDocument();
  });

  it('uses the thinking dot for active+thinking sessions', () => {
    const { container } = render(
      <ProjectRail
        rows={[row({ status: 'active', agentStatus: 'thinking' })]}
        onPinClick={vi.fn()}
        onUnpin={vi.fn()}
      />
    );
    expect(container.querySelector('.dot-thinking')).toBeInTheDocument();
  });

  it('uses the waiting dot for active+waiting sessions', () => {
    const { container } = render(
      <ProjectRail
        rows={[row({ status: 'active', agentStatus: 'waiting' })]}
        onPinClick={vi.fn()}
        onUnpin={vi.fn()}
      />
    );
    expect(container.querySelector('.dot-waiting')).toBeInTheDocument();
  });

  it('uses the idle dot for active+idle sessions', () => {
    const { container } = render(
      <ProjectRail
        rows={[row({ status: 'active', agentStatus: 'idle' })]}
        onPinClick={vi.fn()}
        onUnpin={vi.fn()}
      />
    );
    expect(container.querySelector('.dot-idle')).toBeInTheDocument();
  });

  it('uses the error dot for error sessions', () => {
    const { container } = render(
      <ProjectRail rows={[row({ status: 'error' })]} onPinClick={vi.fn()} onUnpin={vi.fn()} />
    );
    expect(container.querySelector('.dot-error')).toBeInTheDocument();
  });
});
