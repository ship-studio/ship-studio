/**
 * VercelTokenModal — connect a workspace's Vercel account via an access token.
 *
 * Vercel's browser login (`vercel login`) stores one *global* CLI session that
 * would bleed across workspaces, so each workspace instead supplies its own
 * access token. The token is stored in the OS keychain (`setAccountCredential`)
 * and injected as `VERCEL_TOKEN` only into this workspace's terminals — it never
 * crosses back into the webview. Works for any workspace, including Default.
 */

import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { setAccountCredential } from '../../lib/accounts';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

const VERCEL_TOKENS_URL = 'https://vercel.com/account/tokens';

export function VercelTokenModal({
  accountId,
  workspaceName,
  onSaved,
  onClose,
}: {
  accountId: string;
  workspaceName: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const { showToast } = useOptionalToast();

  const save = async () => {
    const trimmed = token.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await setAccountCredential(accountId, 'vercel_token', trimmed);
      onSaved();
    } catch (err) {
      showToast(`Couldn't save Vercel token: ${formatCommandError(asCommandError(err))}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalFrame isOpen onClose={onClose} title="Connect Vercel" className="connect-modal">
      <div className="connect-modal-body">
        <p>
          Create an access token for the Vercel account you want <strong>{workspaceName}</strong> to
          publish with, then paste it below. It's stored in your Keychain and used only by this
          workspace.
        </p>
        <Button variant="secondary" size="sm" onClick={() => void openUrl(VERCEL_TOKENS_URL)}>
          Open vercel.com/account/tokens →
        </Button>
        <label className="connect-modal-field">
          <span>
            Vercel token <span className="connect-modal-muted">(stays in your Keychain)</span>
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="vercel_xxxxxxxxxxxxxxxx"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
          />
        </label>
        <div className="connect-modal-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!token.trim() || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
