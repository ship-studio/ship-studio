import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAgentSkills } from '../lib/claude';
import { HelpModal } from './HelpModal';

vi.mock('../lib/claude', () => ({
  listAgentSkills: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../contexts/ModalContext', () => ({
  useModal: () => ({ isOpen: true, close: vi.fn() }),
}));

describe('HelpModal', () => {
  beforeEach(() => {
    vi.mocked(listAgentSkills).mockResolvedValue([]);
  });

  it('opens on Shortcuts and preserves the current commands in a second tab', async () => {
    render(<HelpModal />);

    await waitFor(() => expect(listAgentSkills).toHaveBeenCalled());

    const shortcutsTab = screen.getByRole('tab', { name: 'Shortcuts' });
    const commandsTab = screen.getByRole('tab', { name: 'Commands' });

    expect(shortcutsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Open command palette')).toBeVisible();
    expect(screen.getByText('⌘K')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('F1')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.queryByText('Switch terminal tab')).not.toBeInTheDocument();
    expect(screen.getByText('Switch project')).toBeVisible();
    expect(screen.getByText('⌘1–9')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Switch workspace')).toBeVisible();
    expect(screen.getByText('⌥1–9')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Toggle Agent panel')).toBeVisible();
    expect(screen.getByText('Switch workspace mode')).toBeVisible();
    expect(screen.getByText('⌘⌃1–3')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Switch terminal/agent tab')).toBeVisible();
    expect(screen.getByText('⌃1–9')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Toggle Edit mode')).toBeVisible();
    expect(screen.getByText('⌘E')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Toggle Inspector')).toBeVisible();
    expect(screen.getByText('⌘I')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Copy selected element')).toBeVisible();
    expect(screen.getByText('⌘C')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘X')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘V')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Duplicate selected element')).toBeVisible();
    expect(screen.getByText('⌘D')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌫')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.queryByText('/clear')).not.toBeVisible();

    fireEvent.click(commandsTab);

    expect(commandsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('/clear')).toBeVisible();
    expect(screen.getByText('Open command palette')).not.toBeVisible();
  });
});
