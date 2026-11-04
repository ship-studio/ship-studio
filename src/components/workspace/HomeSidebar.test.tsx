import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeSidebar } from './HomeSidebar';
import { kbd } from '../../lib/shortcuts';
import { ModalProvider } from '../../contexts/ModalContext';
import { PaletteContextProvider } from '../CommandPalette/paletteContext';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';
import type { AgentsAttention } from '../../lib/agentsStore';

// Accounts load over Tauri IPC, which isn't available here — and the sidebar
// reads `accounts.length` during render.
vi.mock('../../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({ activeAccount: null, accounts: [] }),
}));

let attention: AgentsAttention = { waiting: [], unread: 0 };
vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  useAgentsAttention: () => attention,
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
  onGoProjects: vi.fn(),
  onGoAgents: vi.fn(),
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

  it('has no Team destination — Team lives inside a project', () => {
    // It was briefly a home-level screen reading across eight projects at once.
    // What it answered from out here was worth less than it cost, and comments
    // in particular cannot be acted on without opening the project anyway.
    renderSidebar(<HomeSidebar {...props} activeNav="home" />);
    expect(screen.queryByRole('button', { name: 'Team' })).not.toBeInTheDocument();
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

  describe('Projects | Agents toggle', () => {
    beforeEach(() => {
      attention = { waiting: [], unread: 0 };
      vi.clearAllMocks();
    });

    it('sits above Search with Projects selected on the dashboard', () => {
      const { container } = renderSidebar(<HomeSidebar {...props} activeNav="home" />);
      const panel = container.querySelector('.workspace-sidebar-search-panel')!;
      const toggle = within(panel as HTMLElement).getByRole('tablist', { name: 'Mode' });
      expect(panel.firstElementChild).toContainElement(toggle);
      expect(screen.getByRole('tab', { name: 'Projects' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Agents' }));
      expect(props.onGoAgents).toHaveBeenCalledTimes(1);
    });

    it('replaces the old Agents row', () => {
      renderSidebar(<HomeSidebar {...props} activeNav="home" />);
      expect(screen.queryByRole('button', { name: /^Agents/ })).not.toBeInTheDocument();
    });

    it('goes back to the last Projects place from Agents mode', () => {
      renderSidebar(<HomeSidebar {...props} activeNav="agents" />);
      expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
      fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
      expect(props.onGoProjects).toHaveBeenCalledTimes(1);
      expect(props.onGoHome).not.toHaveBeenCalled();
    });

    it('does nothing when the current mode is clicked', () => {
      renderSidebar(<HomeSidebar {...props} activeNav="home" />);
      fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
      expect(props.onGoProjects).not.toHaveBeenCalled();
      expect(props.onGoAgents).not.toHaveBeenCalled();
    });

    it('badges Agents and names who wants you', () => {
      attention = { waiting: ['Lead Gen'], unread: 1 };
      renderSidebar(<HomeSidebar {...props} activeNav="home" />);
      const agents = screen.getByRole('tab', { name: 'Agents, Lead Gen needs your OK · 1 unread' });
      expect(agents.querySelector('.mode-toggle__dot')).not.toBeNull();
      expect(agents).toHaveAttribute(
        'data-tooltip-content',
        `Lead Gen needs your OK · 1 unread (${kbd('mod', 'shift', 'A')})`
      );
    });

    it('drops the badge while Agents mode is showing', () => {
      attention = { waiting: ['Lead Gen'], unread: 0 };
      renderSidebar(<HomeSidebar {...props} activeNav="agents" />);
      expect(
        screen.getByRole('tab', { name: 'Agents' }).querySelector('.mode-toggle__dot')
      ).toBeNull();
    });

    it('stacks icon-only in the collapsed rail', () => {
      renderSidebar(<HomeSidebar {...props} activeNav="home" isSidebarHidden />);
      expect(screen.getByRole('tablist', { name: 'Mode' })).toHaveClass('mode-toggle--stacked');
      expect(screen.getByRole('tab', { name: 'Agents' })).toHaveClass('button--icon-only');
    });
  });
});
