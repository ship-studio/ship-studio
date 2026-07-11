/**
 * AccountSelectScreen — "Select a Workspace" picker shown at app startup
 * (and via "Switch Workspace"). Each Workspace has its own isolated Claude
 * Code login, GitHub CLI login, and credential vault.
 *
 * @module components/accounts/AccountSelectScreen
 */

import { useEffect, useState, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { AccountCard } from './AccountCard';
import { NewAccountModal } from './NewAccountModal';
import { AccountSettingsModal } from './AccountSettingsModal';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  listAccounts,
  getActiveAccountId,
  setActiveAccountId,
  type Account,
} from '../../lib/accounts';
import { asCommandError, formatCommandError } from '../../lib/errors';
import '../../styles/features/account-select.css';

interface AccountSelectScreenProps {
  onContinue: () => void;
}

export function AccountSelectScreen({ onContinue }: AccountSelectScreenProps) {
  const { showToast } = useOptionalToast();

  const handleDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    const win = getCurrentWindow();
    void win.isMaximized().then((maximized) => {
      void (maximized ? win.unmaximize() : win.maximize());
    });
  }, []);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  const [settingsAccount, setSettingsAccount] = useState<Account | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [list, active] = await Promise.all([listAccounts(), getActiveAccountId()]);
      setAccounts(list);
      setActiveId(active);
    } catch (e) {
      showToast(`Failed to load workspaces: ${formatCommandError(asCommandError(e))}`, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSelect = async (account: Account) => {
    setIsSwitching(true);
    try {
      await setActiveAccountId(account.id);
      onContinue();
    } catch (e) {
      showToast(`Failed to switch workspace: ${formatCommandError(asCommandError(e))}`, 'error');
    } finally {
      setIsSwitching(false);
    }
  };

  return (
    <div className="account-select-screen">
      <div
        className="account-select-drag-region"
        onMouseDown={handleDrag}
        onDoubleClick={handleDoubleClick}
      />
      <div className="account-select-header">
        <span className="account-select-title">
          Select a Workspace {accounts.length > 0 && `(${accounts.length})`}
        </span>
        <Button variant="primary" onClick={() => setShowNewModal(true)}>
          + New Workspace
        </Button>
      </div>

      <p className="account-select-subtitle">
        Each workspace keeps its own Claude, GitHub, and Codex logins, git identity, and tokens, so
        different clients or orgs stay completely separate. Sign in once per workspace and switch
        anytime without logging out.
        <span className="account-select-subtitle-muted">
          {' '}
          They isolate logins only — not your project files or app settings, and nothing syncs to
          the cloud. Your <strong>Default</strong> workspace is your existing setup, untouched.
        </span>
      </p>

      {isLoading ? (
        <div className="account-select-loading">
          <Spinner size="lg" />
        </div>
      ) : (
        <div className="account-grid">
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              isActive={account.id === activeId}
              onSelect={() => void handleSelect(account)}
              onOpenSettings={() => setSettingsAccount(account)}
            />
          ))}
        </div>
      )}

      {isSwitching && (
        <div className="account-select-overlay">
          <Spinner size="lg" />
        </div>
      )}

      <NewAccountModal
        isOpen={showNewModal}
        onClose={() => setShowNewModal(false)}
        onCreated={(account) => setAccounts((prev) => [...prev, account])}
      />

      {settingsAccount && (
        <AccountSettingsModal
          account={settingsAccount}
          isOpen={true}
          onClose={() => setSettingsAccount(null)}
          onUpdated={(updated) => {
            setAccounts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
            setSettingsAccount(updated);
          }}
          onDeleted={(id) => {
            setAccounts((prev) => prev.filter((a) => a.id !== id));
            setSettingsAccount(null);
            if (activeId === id) setActiveId('default');
          }}
        />
      )}
    </div>
  );
}
