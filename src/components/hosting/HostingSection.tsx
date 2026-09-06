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

import { useCallback } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useHostingStatus } from '../../hooks/useHostingStatus';
import { useOptionalToast } from '../../contexts/ToastContext';
import { HostingRow, HostingLinks } from './HostingRow';
import { copyFor } from '../../lib/hostingCopy';
import { logger } from '../../lib/logger';

interface Props {
  projectPath: string;
  /** True only while the popover is on screen, so nothing polls in the dark. */
  open: boolean;
  /** When the push completed, if it happened in this session. */
  pushedAt?: number;
  /** Opens the connect-a-token flow. */
  onConnect?: () => void;
}

export function HostingSection({ projectPath, open, pushedAt, onConnect }: Props) {
  const { status, state, refresh } = useHostingStatus({ projectPath, open, pushedAt });
  const { showToast } = useOptionalToast();

  const copy = copyFor(state, status?.commit.subject, status?.commit.short_sha);

  const handleAction = useCallback(() => {
    const openExternal = (url?: string | null) => {
      if (!url) return;
      void openUrl(url).catch((err) => {
        logger.warn('hosting: failed to open url', { error: String(err) });
        showToast("Couldn't open that link", 'error');
      });
    };

    switch (state.kind) {
      case 'ready':
        openExternal(state.deployment?.urls.primary);
        return;
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
      case 'no_link':
        onConnect?.();
        return;
      case 'offline':
        refresh();
        return;
      default:
        return;
    }
  }, [state, onConnect, refresh, showToast]);

  return (
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
      <HostingLinks state={state} hint={copy.hint} />
    </section>
  );
}
