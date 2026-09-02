import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompactTopbar } from './CompactTopbar';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';

const { startDragging } = vi.hoisted(() => ({ startDragging: vi.fn() }));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging }),
}));

vi.mock('../CommandPalette/paletteContext', () => ({
  useOpenPalette: () => vi.fn(),
}));

const project: PinnedProjectRow = {
  projectPath: '/projects/nextjs-tailwind-test',
  fallbackName: 'nextjs-tailwind-test',
  status: 'inactive',
  agentStatus: 'idle',
  unreadCount: 0,
  memoryBytes: 0,
  isCurrent: false,
};

describe('CompactTopbar project menu', () => {
  afterEach(() => {
    startDragging.mockClear();
    vi.restoreAllMocks();
  });

  it('keeps the CSS-hover menu mounted and starts native dragging from the topbar', () => {
    const onSelectProject = vi.fn();
    const { container } = render(
      <CompactTopbar
        projectLabel="somacra"
        hasDevServer
        switchableProjects={[project]}
        onSelectProject={onSelectProject}
        onGoHome={vi.fn()}
      />
    );

    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toHaveClass('compact-topbar');
    expect(menu.parentElement?.querySelector('.compact-topbar__actions')).not.toContainElement(
      menu
    );

    const paletteButton = screen.getByRole('button', { name: 'Open command palette' });
    const projectButton = screen.getByRole('button', { name: /switch project/i });
    expect(paletteButton).toHaveClass(
      'button',
      'button--default',
      'button--size-medium',
      'workspace-sidebar-filter-shortcut'
    );
    expect(projectButton).toHaveClass('button', 'button--default', 'button--size-medium');

    fireEvent.mouseLeave(projectButton);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'nextjs-tailwind-test' }));
    expect(onSelectProject).toHaveBeenCalledWith('/projects/nextjs-tailwind-test');

    const topbar = container.querySelector('.compact-topbar');
    fireEvent.mouseDown(topbar!, { button: 0 });
    expect(startDragging).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(projectButton, { button: 0 });
    expect(startDragging).toHaveBeenCalledTimes(1);
  });
});
