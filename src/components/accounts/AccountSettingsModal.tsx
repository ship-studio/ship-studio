/**
 * AccountSettingsModal — edit a Workspace's name/color, view Claude/GitHub
 * connection status, manage its credential vault, and delete it.
 *
 * @module components/accounts/AccountSettingsModal
 */

import { useEffect, useState, useCallback } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { GitHubIcon, VercelIcon } from '../icons';
import { useWorkspaceConnect, type ConnectServiceId } from '../../hooks/useWorkspaceConnect';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  updateAccount,
  deleteAccount,
  getAccountCredentialStatus,
  setAccountCredential,
  clearAccountCredential,
  CREDENTIAL_LABELS,
  CREDENTIAL_DESCRIPTIONS,
  ACCOUNT_COLORS,
  STATUS_FIELD_TO_KEY,
  SENSITIVE_KEYS,
  type Account,
  type AccountCredentialStatus,
  type CredentialKey,
} from '../../lib/accounts';
import '../../styles/features/account-select.css';

interface EditingCred {
  key: CredentialKey;
  value: string;
}

interface AccountSettingsModalProps {
  account: Account;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: (account: Account) => void;
  onDeleted: (id: string) => void;
}

export function AccountSettingsModal({
  account,
  isOpen,
  onClose,
  onUpdated,
  onDeleted,
}: AccountSettingsModalProps) {
  const { showToast } = useOptionalToast();

  const [editName, setEditName] = useState(account.name);
  const [editColor, setEditColor] = useState(account.color);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [credStatus, setCredStatus] = useState<AccountCredentialStatus | null>(null);
  const [isLoadingCreds, setIsLoadingCreds] = useState(false);
  const [editingCred, setEditingCred] = useState<EditingCred | null>(null);
  const [isSavingCred, setIsSavingCred] = useState(false);
  const [showValues, setShowValues] = useState<Set<CredentialKey>>(new Set());

  const loadCredStatus = useCallback(async (id: string) => {
    setIsLoadingCreds(true);
    setCredStatus(null);
    try {
      const status = await getAccountCredentialStatus(id);
      setCredStatus(status);
    } finally {
      setIsLoadingCreds(false);
    }
  }, []);

  // The same shared connect layer the dashboard uses, so the two surfaces can
  // never drift. Works for any workspace (not just the active one) — this is the
  // only place to manage a *non-active* workspace's logins.
  const {
    connect: connectService,
    disconnect: disconnectService,
    modals: connectModals,
  } = useWorkspaceConnect({
    accountId: account.id,
    accountName: account.name,
    isDefault: account.isDefault,
    onChanged: () => void loadCredStatus(account.id),
  });

  useEffect(() => {
    if (!isOpen) return;
    setEditName(account.name);
    setEditColor(account.color);
    setEditingCred(null);
    void loadCredStatus(account.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, account.id]);

  const handleSave = async () => {
    if (!editName.trim()) return;
    setIsSaving(true);
    try {
      const updated = await updateAccount(account.id, editName, editColor);
      onUpdated(updated);
      showToast('Workspace updated', 'success');
    } catch (e) {
      showToast(`Failed to update: ${String(e)}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  // No window.confirm — in Tauri's WebKit it doesn't block (returns a truthy
  // promise), so the delete fired before the user answered. Confirmation is an
  // inline two-step in the footer instead.
  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteAccount(account.id);
      onDeleted(account.id);
      showToast('Workspace deleted', 'success');
    } catch (e) {
      showToast(`Failed to delete: ${String(e)}`, 'error');
      setIsDeleting(false);
    }
  };

  const handleSaveCred = async () => {
    if (!editingCred || !editingCred.value.trim()) return;
    setIsSavingCred(true);
    try {
      await setAccountCredential(account.id, editingCred.key, editingCred.value);
      setEditingCred(null);
      await loadCredStatus(account.id);
      showToast('Credential saved', 'success');
    } catch (e) {
      showToast(`Failed to save: ${String(e)}`, 'error');
    } finally {
      setIsSavingCred(false);
    }
  };

  const handleClearCred = async (key: CredentialKey) => {
    try {
      await clearAccountCredential(account.id, key);
      await loadCredStatus(account.id);
      showToast('Credential removed', 'success');
    } catch (e) {
      showToast(`Failed to clear: ${String(e)}`, 'error');
    }
  };

  const toggleShowValue = (key: CredentialKey) => {
    setShowValues((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const credRows = credStatus
    ? (Object.entries(STATUS_FIELD_TO_KEY) as [keyof AccountCredentialStatus, CredentialKey][])
    : [];

  return (
    <>
      <ModalFrame
        isOpen={isOpen}
        onClose={onClose}
        title="Workspace Settings"
        className="account-modal-frame"
      >
        <div className="account-detail">
          <div className="account-detail-scroll">
            {/* Name + color */}
            <div>
              <div className="account-section-title">Name</div>
              <div className="account-header-row">
                <input
                  className="account-name-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  disabled={account.isDefault}
                  placeholder="Workspace name"
                />
              </div>
              {!account.isDefault && (
                <div style={{ marginTop: 'var(--spacing-sm)' }}>
                  <div className="account-section-title">Color</div>
                  <div className="account-color-picker">
                    {ACCOUNT_COLORS.map((c) => (
                      <button
                        key={c}
                        className={`account-color-swatch ${c === editColor ? 'selected' : ''}`}
                        style={{ background: c }}
                        onClick={() => setEditColor(c)}
                        title={c}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Coding agents — status only; sign-in is managed from the dashboard's
              Workspace accounts card (which also owns install / default state). */}
            <div>
              <div className="account-section-title">Coding agents</div>
              {isLoadingCreds ? (
                <Spinner size="sm" />
              ) : (
                <div className="account-cred-list">
                  {(
                    [
                      { label: 'Claude Code', identity: credStatus?.claudeAuthEmail },
                      { label: 'Codex', identity: credStatus?.codexAuthEmail },
                      { label: 'Opencode', identity: credStatus?.opencodeAuthEmail },
                    ] as const
                  ).map((row) => (
                    <div key={row.label} className="account-cred-row">
                      <span className="account-cred-label">{row.label}</span>
                      <div className="account-cred-status">
                        <span className={`account-cred-badge ${row.identity ? 'set' : 'unset'}`}>
                          {row.identity ? 'Connected' : 'Not connected'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="account-settings-hint">
                Sign coding agents in from the dashboard’s <strong>Workspace accounts</strong> card.
              </p>
            </div>

            {/* Services — actionable via the same shared connect layer as the
              dashboard, so the two surfaces stay in sync. */}
            <div>
              <div className="account-section-title">Services</div>
              {isLoadingCreds ? (
                <Spinner size="sm" />
              ) : (
                <div className="account-cred-list">
                  {(
                    [
                      {
                        id: 'github' as ConnectServiceId,
                        label: 'GitHub',
                        icon: <GitHubIcon size={16} />,
                        identity: credStatus?.githubAuthEmail ?? null,
                      },
                      {
                        id: 'vercel' as ConnectServiceId,
                        label: 'Vercel',
                        icon: <VercelIcon size={14} />,
                        identity: credStatus?.vercelUsername ?? null,
                      },
                    ] as const
                  ).map((svc) => {
                    const connected = !!svc.identity;
                    return (
                      <div key={svc.id} className="account-cred-row">
                        <span className="account-cred-label">
                          {svc.icon} {svc.label}
                        </span>
                        <div className="account-cred-status">
                          <span className={`account-cred-badge ${connected ? 'set' : 'unset'}`}>
                            {connected ? `Connected as ${svc.identity}` : 'Not connected'}
                          </span>
                          <div className="account-cred-actions">
                            {connected ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => connectService(svc.id)}
                                >
                                  {account.isDefault ? 'Sign in again' : 'Switch'}
                                </Button>
                                {!account.isDefault && (
                                  <Button
                                    variant="danger"
                                    size="sm"
                                    onClick={() => void disconnectService(svc.id)}
                                  >
                                    Disconnect
                                  </Button>
                                )}
                              </>
                            ) : (
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => connectService(svc.id)}
                              >
                                Connect
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Credential vault */}
            <div>
              <div className="account-section-title">Credential Vault</div>
              {isLoadingCreds ? (
                <Spinner size="sm" />
              ) : (
                <div className="account-cred-list">
                  {credRows.map(([statusField, key]) => {
                    const isSet = credStatus ? credStatus[statusField] : false;
                    const isEditing = editingCred?.key === key;
                    const isSensitive = SENSITIVE_KEYS.has(key);
                    const revealed = showValues.has(key);

                    return (
                      <div
                        key={key}
                        className={`account-cred-row${isEditing ? ' is-editing' : ''}`}
                      >
                        {isEditing ? (
                          <div className="account-cred-input-row">
                            <input
                              className="account-cred-input"
                              type={isSensitive && !revealed ? 'password' : 'text'}
                              value={editingCred.value}
                              onChange={(e) => setEditingCred({ key, value: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleSaveCred();
                                if (e.key === 'Escape') setEditingCred(null);
                              }}
                              autoFocus
                              placeholder={isSensitive ? '••••••••' : CREDENTIAL_LABELS[key]}
                            />
                            {isSensitive && (
                              <button
                                type="button"
                                className="account-cred-reveal"
                                onClick={() => toggleShowValue(key)}
                                title={revealed ? 'Hide' : 'Show'}
                              >
                                {revealed ? 'Hide' : 'Show'}
                              </button>
                            )}
                            <div className="account-cred-actions">
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => void handleSaveCred()}
                                disabled={!editingCred.value.trim() || isSavingCred}
                              >
                                {isSavingCred ? <Spinner size="sm" /> : 'Save'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingCred(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="account-cred-info">
                              <span className="account-cred-label">{CREDENTIAL_LABELS[key]}</span>
                              <span className="account-cred-description">
                                {CREDENTIAL_DESCRIPTIONS[key]}
                              </span>
                            </div>
                            <div className="account-cred-status">
                              <span className={`account-cred-badge ${isSet ? 'set' : 'unset'}`}>
                                {isSet ? 'Set' : 'Not set'}
                              </span>
                              <div className="account-cred-actions">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setEditingCred({ key, value: '' })}
                                >
                                  {isSet ? 'Update' : 'Set'}
                                </Button>
                                {isSet && (
                                  <Button
                                    variant="danger"
                                    size="sm"
                                    onClick={() => void handleClearCred(key)}
                                  >
                                    Clear
                                  </Button>
                                )}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="account-detail-footer">
            {account.isDefault ? (
              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                The Default workspace cannot be renamed or deleted.
              </span>
            ) : confirmingDelete ? (
              <div className="account-delete-confirm">
                <span className="account-delete-confirm-text">
                  Delete “{account.name}”? Its stored credentials are removed and any projects in it
                  move to Default — your files aren’t touched.
                </span>
                <div className="account-delete-confirm-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={isDeleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => void handleDelete()}
                    disabled={isDeleting}
                  >
                    {isDeleting ? <Spinner size="sm" /> : 'Delete'}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Button variant="danger" size="sm" onClick={() => setConfirmingDelete(true)}>
                  Delete Workspace
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={!editName.trim() || isSaving}
                >
                  {isSaving ? <Spinner size="sm" /> : 'Save Changes'}
                </Button>
              </>
            )}
          </div>
        </div>
      </ModalFrame>
      {connectModals}
    </>
  );
}
