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
    expect(screen.queryByText('/clear')).not.toBeVisible();

    fireEvent.click(commandsTab);

    expect(commandsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('/clear')).toBeVisible();
    expect(screen.getByText('Open command palette')).not.toBeVisible();
  });
});
