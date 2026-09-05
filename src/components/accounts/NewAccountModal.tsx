/**
 * NewAccountModal — create a new Workspace (Account).
 *
 * @module components/accounts/NewAccountModal
 */

import { useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { AccountColorPicker } from './AccountColorPicker';
import { useOptionalToast } from '../../contexts/ToastContext';
import { createAccount, ACCOUNT_COLORS, type Account } from '../../lib/accounts';
import { asCommandError, formatCommandError } from '../../lib/errors';

interface NewAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (account: Account) => void;
}

export function NewAccountModal({ isOpen, onClose, onCreated }: NewAccountModalProps) {
  const { showToast } = useOptionalToast();
  const [name, setName] = useState('');
  const [color, setColor] = useState(ACCOUNT_COLORS[1]);
  const [isSaving, setIsSaving] = useState(false);

  const handleClose = () => {
    setName('');
    setColor(ACCOUNT_COLORS[1]);
    onClose();
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      const created = await createAccount(name.trim(), color);
      onCreated(created);
      handleClose();
    } catch (e) {
      showToast(`Failed to create workspace: ${formatCommandError(asCommandError(e))}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ModalFrame isOpen={isOpen} onClose={handleClose} title="New Workspace">
      <div className="account-modal-body">
        <div className="account-section-title">Name</div>
        <input
          className="account-name-input"
          placeholder="e.g. Client B"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
          autoFocus
        />
        <div className="account-section-title" style={{ marginTop: 'var(--spacing-md)' }}>
          Color
        </div>
        <AccountColorPicker value={color} onChange={setColor} />
      </div>
      <div className="account-detail-footer">
        <Button variant="ghost" onClick={handleClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void handleCreate()}
          disabled={!name.trim() || isSaving}
        >
          {isSaving ? <Spinner size="sm" /> : 'Create'}
        </Button>
      </div>
    </ModalFrame>
  );
}
