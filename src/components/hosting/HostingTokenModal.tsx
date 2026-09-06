/**
 * Connect a hosting provider by storing a token in the OS keychain.
 *
 * Generalises the old Vercel-only modal over all three providers. The token is
 * kept by `setAccountCredential` and injected into this workspace's terminals
 * as the provider's documented environment variable — it never crosses back
 * into the webview.
 *
 * Why a token rather than the CLI's own login: the Vercel CLI's credential is a
 * short-lived OAuth access token (about seven hours on a real machine). Ship
 * Studio will happily borrow it when it's there — that's what makes hosting
 * work with no setup at all — but it stops working mid-afternoon, and the only
 * durable fix is a token the user owns. See
 * `docs/internal/hosting-provider-matrix.md`.
 */

import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { setAccountCredential, type CredentialKey } from '../../lib/accounts';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { PROVIDER_LABELS, type HostingProvider } from '../../lib/hosting';

interface ProviderCopy {
  credentialKey: CredentialKey;
  tokensUrl: string;
  tokensLabel: string;
  placeholder: string;
  /** Anything the user must get right when creating the token. */
  requirement?: string;
}

const PROVIDERS: Record<HostingProvider, ProviderCopy> = {
  vercel: {
    credentialKey: 'vercel_token',
    tokensUrl: 'https://vercel.com/account/tokens',
    tokensLabel: 'vercel.com/account/tokens',
    placeholder: 'vercel_xxxxxxxxxxxxxxxx',
  },
  cloudflare: {
    credentialKey: 'cloudflare_api_token',
    tokensUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    tokensLabel: 'dash.cloudflare.com/profile/api-tokens',
    placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
    requirement:
      'Give it the Cloudflare Pages:Read and Account Settings:Read permissions — without both, deployments come back empty.',
  },
  netlify: {
    credentialKey: 'netlify_auth_token',
    tokensUrl: 'https://app.netlify.com/user/applications',
    tokensLabel: 'app.netlify.com/user/applications',
    placeholder: 'nfp_xxxxxxxxxxxxxxxx',
  },
};

interface Props {
  provider: HostingProvider;
  accountId: string;
  workspaceName: string;
  /** True when we had a credential and the provider refused it. */
  wasRejected?: boolean;
  onSaved: () => void;
  onClose: () => void;
}

export function HostingTokenModal({
  provider,
  accountId,
  workspaceName,
  wasRejected = false,
  onSaved,
  onClose,
}: Props) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const { showToast } = useOptionalToast();

  const name = PROVIDER_LABELS[provider];
  const copy = PROVIDERS[provider];

  const save = async () => {
    const trimmed = token.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await setAccountCredential(accountId, copy.credentialKey, trimmed);
      onSaved();
    } catch (err) {
      showToast(
        `Couldn't save the ${name} token: ${formatCommandError(asCommandError(err))}`,
        'error'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalFrame isOpen onClose={onClose} title={`Connect ${name}`} className="connect-modal">
      <div className="connect-modal-body">
        <p>
          {wasRejected
            ? `${name} refused the sign-in Ship Studio was using. Create a token for the account you deploy with and paste it below.`
            : `Create a token for the ${name} account ${workspaceName} deploys with, then paste it below. It's stored in your Keychain and used only by this workspace.`}
        </p>
        {copy.requirement ? <p className="connect-modal-muted">{copy.requirement}</p> : null}
        <Button variant="secondary" onClick={() => void openUrl(copy.tokensUrl)}>
          Open {copy.tokensLabel} →
        </Button>
        <label className="connect-modal-field">
          <span>
            {name} token <span className="connect-modal-muted">(stays in your Keychain)</span>
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={copy.placeholder}
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
