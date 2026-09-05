import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSelectScreen } from './AccountSelectScreen';
import { describeProjectsRoot } from './AccountCard';
import type { Account } from '../../lib/accounts';

const { startDragging, listAccounts, getActiveAccountId, setActiveAccountId } = vi.hoisted(() => ({
  startDragging: vi.fn(),
  listAccounts: vi.fn(),
  getActiveAccountId: vi.fn(),
  setActiveAccountId: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    startDragging,
    isMaximized: () => Promise.resolve(false),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
  }),
}));

vi.mock('../../lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/accounts')>()),
  listAccounts,
  getActiveAccountId,
  setActiveAccountId,
}));

// The modals talk to the backend on their own; here only their open state matters.
vi.mock('./NewAccountModal', () => ({
  NewAccountModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="new-workspace-modal" /> : null,
}));
vi.mock('./AccountSettingsModal', () => ({
  AccountSettingsModal: ({ account }: { account: Account }) => (
    <div data-testid="settings-modal">{account.name}</div>
  ),
}));

const DEFAULT: Account = {
  id: 'default',
  name: 'Default',
  color: '#6b7280',
  isDefault: true,
  createdAt: 1,
};
const CLIENT: Account = {
  id: 'client-b',
  name: 'Client B',
  color: '#ef4444',
  isDefault: false,
  createdAt: 2,
  projectsRoot: '/Users/me/Clients/AcmeCo',
};

describe('AccountSelectScreen', () => {
  beforeEach(() => {
    listAccounts.mockResolvedValue([DEFAULT, CLIENT]);
    getActiveAccountId.mockResolvedValue('default');
    setActiveAccountId.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('lists every workspace as a tile, marks the current one, and offers a new-workspace tile', async () => {
    render(<AccountSelectScreen onContinue={vi.fn()} />);

    const current = await screen.findByRole('button', { name: 'Default (current workspace)' });
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current).toHaveTextContent('Current');
    expect(screen.getByRole('button', { name: 'Switch to Client B' })).not.toHaveAttribute(
      'aria-current'
    );
    expect(screen.getByRole('button', { name: /New workspace/ })).toBeInTheDocument();
    // Settings stays reachable per tile, as its own control (not nested in the tile button).
    expect(screen.getByRole('button', { name: 'Client B settings' })).toBeInTheDocument();
  });

  it('activates the picked workspace, then continues', async () => {
    const onContinue = vi.fn();
    render(<AccountSelectScreen onContinue={onContinue} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Client B' }));

    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    expect(setActiveAccountId).toHaveBeenCalledWith('client-b');
  });

  it('opens the new-workspace modal from the last tile', async () => {
    render(<AccountSelectScreen onContinue={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /New workspace/ }));
    expect(screen.getByTestId('new-workspace-modal')).toBeInTheDocument();
  });

  it('opens settings for a tile without switching to it', async () => {
    const onContinue = vi.fn();
    render(<AccountSelectScreen onContinue={onContinue} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Client B settings' }));
    expect(screen.getByTestId('settings-modal')).toHaveTextContent('Client B');
    expect(setActiveAccountId).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('goes back via the Back button and via Esc, without switching', async () => {
    const onBack = vi.fn();
    render(<AccountSelectScreen onContinue={vi.fn()} onBack={onBack} />);
    await screen.findByRole('button', { name: 'Switch to Client B' });

    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onBack).toHaveBeenCalledTimes(2);
    expect(setActiveAccountId).not.toHaveBeenCalled();
  });

  it('does not let Esc leave while a modal is open', async () => {
    const onBack = vi.fn();
    render(<AccountSelectScreen onContinue={vi.fn()} onBack={onBack} />);
    fireEvent.click(await screen.findByRole('button', { name: /New workspace/ }));

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onBack).not.toHaveBeenCalled();
  });

  it('shows no Back affordance when there is nowhere to go back to', async () => {
    render(<AccountSelectScreen onContinue={vi.fn()} />);
    await screen.findByRole('button', { name: 'Switch to Client B' });
    expect(screen.queryByRole('button', { name: /Back/ })).toBeNull();
  });
});

describe('describeProjectsRoot', () => {
  it('names the custom folder but never guesses the default one', () => {
    // The built-in default resolves to the app's projects folder, which the
    // user may have moved — say what it is, not where we think it is.
    expect(describeProjectsRoot(DEFAULT)).toBe('Default projects folder');
    expect(describeProjectsRoot(CLIENT)).toBe('Projects in AcmeCo');
    expect(describeProjectsRoot({ ...CLIENT, projectsRoot: 'C:\\Work\\Acme\\' })).toBe(
      'Projects in Acme'
    );
    expect(describeProjectsRoot({ ...CLIENT, projectsRoot: '/' })).toBe('Custom projects folder');
  });
});
