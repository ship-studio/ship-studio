/**
 * The "Hosting" block inside the Push popover.
 *
 * Replaces a slot that rendered an external plugin's hover menu, which the host
 * then reshaped with CSS written against that plugin's own class names and held
 * open with a synthetic `mouseover` dispatched from a MutationObserver. All of
 * that is gone: this owns its markup, so it can own its geometry.
 *
 * @see lib/hosting for the state reducer, lib/hostingCopy for every string.
 */

import { useCallback, useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useHostingStatus } from '../../hooks/useHostingStatus';
import { useOptionalToast } from '../../contexts/ToastContext';
import { HostingRow, HostingLinks } from './HostingRow';
import { HostingUrls } from './HostingUrls';
import { HostingTokenModal } from './HostingTokenModal';
import { HostingLinkPicker } from './HostingLinkPicker';
import { copyFor } from '../../lib/hostingCopy';
import { logger } from '../../lib/logger';
import {
  getProjectAccountId,
  notifyAccountCredentialsChanged,
  DEFAULT_ACCOUNT_ID,
} from '../../lib/accounts';
import type { HostingProvider } from '../../lib/hosting';

interface Props {
  projectPath: string;
  /** True only while the popover is on screen, so nothing polls in the dark. */
  open: boolean;
  /** When the push completed, if it happened in this session. */
  pushedAt?: number;
}

export function HostingSection({ projectPath, open, pushedAt }: Props) {
  const { status, state, refresh } = useHostingStatus({ projectPath, open, pushedAt });
  const { showToast } = useOptionalToast();

  const [connecting, setConnecting] = useState<HostingProvider | null>(null);
  const [picking, setPicking] = useState(false);
  // Which workspace's keychain the token belongs to — the project's, matching
  // how git push authenticates, not whichever workspace happens to be active.
  const [accountId, setAccountId] = useState(DEFAULT_ACCOUNT_ID);

  useEffect(() => {
    let cancelled = false;
    void getProjectAccountId(projectPath)
      .then((id) => {
        if (!cancelled) setAccountId(id);
      })
      .catch(() => {
        // Falls back to Default, which is where an untagged project lives.
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const copy = copyFor(state, status?.commit.subject, status?.commit.short_sha);

  const openExternal = useCallback(
    (url?: string | null) => {
      if (!url) return;
      void openUrl(url).catch((err) => {
        logger.warn('hosting: failed to open url', { error: String(err) });
        showToast("Couldn't open that link", 'error');
      });
    },
    [showToast]
  );

  const handleAction = useCallback(() => {

    switch (state.kind) {
      // Every state that has a deployment opens it on the provider. The
      // addresses are already clickable directly above, so the button spends
      // its space on the one thing the row cannot show.
      case 'ready':
      case 'queued':
      case 'building':
      case 'publishing':
      case 'failed':
      case 'canceled':
      case 'skipped':
      case 'gated':
      case 'unknown':
        openExternal(state.deployment?.dashboard_url);
        return;
      case 'no_token':
      case 'token_rejected':
        setConnecting(state.provider ?? 'vercel');
        return;
      case 'no_link':
        setPicking(true);
        return;
      case 'offline':
        refresh();
        return;
      default:
        return;
    }
  }, [state, refresh, openExternal]);

  return (
    <>
      <section className="publish-hosting-section" aria-labelledby="publish-hosting-heading">
        <div className="publish-hosting-heading" id="publish-hosting-heading">
          Hosting
        </div>
        <HostingRow
          state={state}
          commitSubject={status?.commit.subject}
          shortSha={status?.commit.short_sha}
          onAction={handleAction}
        />
        <HostingUrls deployment={state.deployment} onOpen={openExternal} />
        <HostingLinks state={state} hint={copy.hint} />
      </section>

      {connecting ? (
        <HostingTokenModal
          provider={connecting}
          accountId={accountId}
          workspaceName="this workspace"
          wasRejected={state.kind === 'token_rejected'}
          onSaved={() => {
            setConnecting(null);
            // Terminals in this workspace get the new token too, so tell them.
            notifyAccountCredentialsChanged(accountId);
            refresh();
          }}
          onClose={() => setConnecting(null)}
        />
      ) : null}

      {picking ? (
        <HostingLinkPicker
          projectPath={projectPath}
          detected={status?.detected ?? []}
          onLinked={() => {
            setPicking(false);
            refresh();
          }}
          onNeedsToken={(provider) => {
            setPicking(false);
            setConnecting(provider);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </>
  );
}
