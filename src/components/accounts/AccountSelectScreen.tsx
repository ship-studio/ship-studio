/**
 * AccountSelectScreen — the "Choose a workspace" picker, reached from the
 * dashboard's workspace chip, the sidebar footer, or ⌘K. Each Workspace has
 * its own isolated agent logins, GitHub CLI login, git identity, and
 * credential vault.
 *
 * Laid out like the dashboard hero and the onboarding agent picker: a centred
 * icon + title + one-line explainer, a grid of square tiles (the last one
 * creates a new workspace), and a quiet footnote for the caveats. Picking a
 * tile switches and continues; Back / Esc returns without changing anything.
 *
 * @module components/accounts/AccountSelectScreen
 */

import { useEffect, useState, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';
import { ArrowLeftIcon, NewWorkspaceIcon, SwitchWorkspaceIcon } from '@/components/icons';
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
  /** Called after a workspace was picked and activated. */
  onContinue: () => void;
  /** Return to where the user came from without switching. Also bound to Esc. */
  onBack?: () => void;
}

const INTERACTIVE = 'button, a, input, select, [role="button"]';

export function AccountSelectScreen({ onContinue, onBack }: AccountSelectScreenProps) {
  const { showToast } = useOptionalToast();

  const handleDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
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

  // Esc leaves the screen — but not while a modal owns the keyboard.
  const modalOpen = showNewModal || settingsAccount !== null;
  useEffect(() => {
    if (!onBack || modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack, modalOpen]);

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

      {onBack && (
        <Button
          variant="ghost"
          className="account-select-back"
          onClick={onBack}
          leftIcon={<ArrowLeftIcon size={14} />}
        >
          Back
        </Button>
      )}

      <main className="account-select-content">
        <header className="account-select-hero">
          <span className="account-select-hero-icon" aria-hidden="true">
            <SwitchWorkspaceIcon size={24} />
          </span>
          <h1 className="account-select-title text-style-h1">Choose a workspace</h1>
          <p className="account-select-subtitle text-style-body-medium">
            Each workspace keeps its own agent, GitHub, and git logins. Switch any time — your
            projects and settings stay where they are.
          </p>
        </header>

        {isLoading ? (
          <div className="account-select-loading">
            <Spinner size="lg" />
          </div>
        ) : (
          <div className="account-pick-grid" role="list" aria-label="Workspaces">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                isActive={account.id === activeId}
                disabled={isSwitching}
                onSelect={() => void handleSelect(account)}
                onOpenSettings={() => setSettingsAccount(account)}
              />
            ))}
            <div className="account-pick-card account-pick-card--new" role="listitem">
              <button
                type="button"
                className="account-pick-card-main"
                onClick={() => setShowNewModal(true)}
                disabled={isSwitching}
              >
                <span
                  className="account-pick-card-avatar account-pick-card-avatar--new"
                  aria-hidden
                >
                  <NewWorkspaceIcon size={22} />
                </span>
                <span className="account-pick-card-name">New workspace</span>
                <span className="account-pick-card-desc">
                  Separate logins for another client or org
                </span>
              </button>
            </div>
          </div>
        )}

        <p className="account-select-footnote text-style-hint">
          Workspaces isolate logins only — not your project files or app settings — and nothing
          syncs to the cloud. <strong>Default</strong> is your existing setup, untouched.
        </p>
      </main>

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
