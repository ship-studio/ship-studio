import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeSidebar } from './HomeSidebar';
import { ModalProvider } from '../../contexts/ModalContext';
import { PaletteContextProvider } from '../CommandPalette/paletteContext';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';

// Accounts load over Tauri IPC, which isn't available here — and the sidebar
// reads `accounts.length` during render.
vi.mock('../../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({ activeAccount: null, accounts: [] }),
}));

function renderSidebar(ui: React.ReactElement) {
  return render(
    <ModalProvider>
      <PaletteContextProvider>{ui}</PaletteContextProvider>
    </ModalProvider>
  );
}

const props = {
  activeNav: 'home' as const,
  onGoHome: vi.fn(),
  onGoWorkflows: vi.fn(),
  onGoInbox: vi.fn(),
  inboxUnreadCount: 0,
  isSidebarHidden: false,
  onToggleSidebar: vi.fn(),
  onOpenProjectPicker: vi.fn(),
  projects: [],
  onSelectProject: vi.fn(),
  onCloseProject: vi.fn(),
  onSelectProjectTab: vi.fn(),
  isProjectDevServerRunning: () => false,
  onSwitchAccount: vi.fn(),
};

describe('HomeSidebar', () => {
  it('shows and handles unpin from a project context menu', () => {
    const onTogglePinProject = vi.fn();
    const project: PinnedProjectRow = {
      projectPath: '/tmp/project-a',
      fallbackName: 'project-a',
      status: 'inactive',
      agentStatus: 'idle',
      unreadCount: 0,
      memoryBytes: 0,
      isCurrent: false,
    };

    const { container } = renderSidebar(
      <HomeSidebar {...props} projects={[project]} onTogglePinProject={onTogglePinProject} />
    );

    fireEvent.contextMenu(container.querySelector<HTMLElement>('.sidebar-project-row')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin from sidebar' }));

    expect(onTogglePinProject).toHaveBeenCalledWith('/tmp/project-a', false);
  });

  it('renders the Workflows and Inbox destinations', () => {
    renderSidebar(<HomeSidebar {...props} activeNav="home" />);
    expect(screen.getByRole('button', { name: 'Workflows' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();
  });

  it('badges the Inbox with the unread count', () => {
    renderSidebar(<HomeSidebar {...props} inboxUnreadCount={3} activeNav="home" />);
    expect(screen.getByRole('button', { name: 'Inbox — 3 unread' })).toBeInTheDocument();
  });

  it('marks the current destination and disables its button', () => {
    renderSidebar(<HomeSidebar {...props} activeNav="workflows" />);
    const workflows = screen.getByRole('button', { name: 'Workflows' });
    expect(workflows).toBeDisabled();
    expect(workflows).toHaveAttribute('aria-current', 'page');
  });
});
