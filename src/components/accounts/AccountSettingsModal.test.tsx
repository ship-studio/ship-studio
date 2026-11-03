import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsModal } from './AccountSettingsModal';
import {
  ACCOUNT_COLORS,
  getAccountCredentialStatus,
  updateAccount,
  type Account,
} from '../../lib/accounts';

const mocks = vi.hoisted(() => ({
  updateAccount: vi.fn(),
  getAccountCredentialStatus: vi.fn(),
}));

vi.mock('../../lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/accounts')>()),
  updateAccount: mocks.updateAccount,
  getAccountCredentialStatus: mocks.getAccountCredentialStatus,
}));

vi.mock('../../hooks/useWorkspaceConnect', () => ({
  useWorkspaceConnect: () => ({ connect: vi.fn(), disconnect: vi.fn(), modals: null }),
}));

const DEFAULT_ACCOUNT: Account = {
  id: 'default',
  name: 'Default',
  color: ACCOUNT_COLORS[0],
  isDefault: true,
  createdAt: 1,
};

const CUSTOM_ACCOUNT: Account = {
  id: 'client-a',
  name: 'Client A',
  color: ACCOUNT_COLORS[1],
  isDefault: false,
  createdAt: 2,
};

const EMPTY_CREDENTIAL_STATUS = {
  claudeAuthEmail: null,
  codexAuthEmail: null,
  opencodeAuthEmail: null,
  githubAuthEmail: null,
  vercelUsername: null,
  hasAnthropicBaseUrl: false,
  hasVercelToken: false,
  hasCloudflareApiToken: false,
  hasNetlifyAuthToken: false,
  hasGitName: false,
  hasGitEmail: false,
};

function SettingsHarness({ initialAccount }: { initialAccount: Account }) {
  const [account, setAccount] = useState(initialAccount);
  const [isOpen, setIsOpen] = useState(true);

  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)}>
        Open workspace settings
      </button>
      <AccountSettingsModal
        account={account}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onUpdated={setAccount}
        onDeleted={() => undefined}
      />
    </>
  );
}

describe('AccountSettingsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccountCredentialStatus).mockResolvedValue(EMPTY_CREDENTIAL_STATUS);
  });

  it('saves the Default workspace color and shows the saved color after reopening', async () => {
    const user = userEvent.setup();
    const savedAccount = { ...DEFAULT_ACCOUNT, color: ACCOUNT_COLORS[2] };
    vi.mocked(updateAccount).mockResolvedValue(savedAccount);

    render(<SettingsHarness initialAccount={DEFAULT_ACCOUNT} />);

    const nameInput = screen.getByPlaceholderText('Workspace name');
    expect(nameInput).toBeDisabled();
    expect(nameInput).toHaveValue('Default');
    expect(
      screen.getByText('The Default workspace cannot be renamed or deleted.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Workspace' })).not.toBeInTheDocument();

    const savedColor = screen.getByRole('button', {
      name: `Use ${ACCOUNT_COLORS[2]} as the workspace color`,
    });
    await user.click(savedColor);
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(updateAccount).toHaveBeenCalledWith('default', 'Default', ACCOUNT_COLORS[2]);
    });

    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    await user.click(screen.getByRole('button', { name: 'Open workspace settings' }));

    expect(
      screen.getByRole('button', {
        name: `Use ${ACCOUNT_COLORS[2]} as the workspace color`,
      })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps name, color, and delete controls available for custom workspaces', async () => {
    const user = userEvent.setup();
    const renamedAccount = {
      ...CUSTOM_ACCOUNT,
      name: 'Client A Updated',
      color: ACCOUNT_COLORS[3],
    };
    vi.mocked(updateAccount).mockResolvedValue(renamedAccount);

    render(
      <AccountSettingsModal
        account={CUSTOM_ACCOUNT}
        isOpen
        onClose={vi.fn()}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
      />
    );

    const nameInput = screen.getByPlaceholderText('Workspace name');
    expect(nameInput).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete Workspace' })).toBeInTheDocument();

    await user.clear(nameInput);
    await user.type(nameInput, renamedAccount.name);
    await user.click(
      screen.getByRole('button', {
        name: `Use ${ACCOUNT_COLORS[3]} as the workspace color`,
      })
    );
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(updateAccount).toHaveBeenCalledWith(
        CUSTOM_ACCOUNT.id,
        renamedAccount.name,
        ACCOUNT_COLORS[3]
      );
    });
  });
});
