/**
 * Recent deployments for a project, with each one's build output.
 *
 * The reason this exists: the deployments API says a build failed, and only
 * the build log says why — so without this, "Build failed" sends you to the
 * provider's dashboard, which is the trip this feature is meant to remove.
 *
 * Deliberately shaped like `RunHistoryModal`: a list you pick from on the
 * left, the raw output on the right. That similarity is the point. Reading
 * exactly what the provider returned, rather than taking a status word on
 * trust, is the same job in both places.
 *
 * @module components/hosting/DeploymentsModal
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AlertIcon } from '@/components/icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { formatRelativeTime } from '../../lib/branches';
import { logger } from '../../lib/logger';
import { useModal } from '../../contexts/ModalContext';
import {
  getDeploymentLog,
  getHostingStatus,
  listRecentDeployments,
  PROVIDER_LABELS,
  type BuildLog,
  type Deployment,
  type HostingProvider,
} from '../../lib/hosting';

/** The row's status word. Plain language, never the provider's enum. */
const PHASE_LABEL: Record<string, string> = {
  queued: 'Waiting',
  building: 'Building',
  publishing: 'Publishing',
  ready: 'Live',
  failed: 'Failed',
  canceled: 'Canceled',
  skipped: 'Skipped',
  gated: 'Needs approval',
  unknown: 'Unrecognized',
};

/** Maps a phase onto the dot colours the rest of the app already uses. */
const DOT_STATE: Record<string, string> = {
  queued: 'pending',
  building: 'running',
  publishing: 'running',
  ready: 'ok',
  failed: 'failed',
  canceled: 'pending',
  skipped: 'pending',
  gated: 'findings',
  unknown: 'pending',
};

/** How long a build took, when the provider told us both ends of it. */
function buildDuration(deployment: Deployment): string | null {
  if (!deployment.ready_at || !deployment.created_at) return null;
  const seconds = Math.round((deployment.ready_at - deployment.created_at) / 1000);
  if (seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function titleFor(deployment: Deployment): string {
  return deployment.commit_message?.trim() || deployment.commit_sha.slice(0, 7) || 'Deployment';
}

interface Props {
  projectPath: string;
}

/**
 * Reads its own open state so it can be opened from the command palette as
 * well as from the hosting row, and resolves which provider this project
 * deploys to rather than being handed one — a payload-free modal is what the
 * rest of this app's modal context supports.
 */
export function DeploymentsModal({ projectPath }: Props) {
  const { isOpen, close } = useModal('deployments');
  const [provider, setProvider] = useState<HostingProvider | null>(null);
  const { showToast } = useOptionalToast();
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keyed by the deployment it describes, so switching selection derives
  // "loading" rather than clearing state in an effect — which would flash the
  // previous deployment's log under the new one's heading for a render.
  const [logEntry, setLogEntry] = useState<{
    id: string;
    log?: BuildLog;
    error?: string;
  } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const name = provider ? PROVIDER_LABELS[provider] : 'your host';
  const selected =
    deployments?.find((d) => d.id === selectedId) ?? deployments?.[0] ?? null;

  const forSelected = selected && logEntry?.id === selected.id ? logEntry : null;
  const log = forSelected?.log ?? null;
  const logError = forSelected?.error ?? null;
  const loadingLog = selected != null && forSelected === null;

  // Which provider this project deploys to. Cheap: the status call is cached
  // backend-side for a few seconds and the popover has usually just made it.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void getHostingStatus(projectPath)
      .then((status) => {
        if (!cancelled) setProvider(status.providers[0]?.link.provider ?? null);
      })
      .catch(() => {
        if (!cancelled) setProvider(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectPath]);

  useEffect(() => {
    if (!isOpen || !provider) return;
    let cancelled = false;
    listRecentDeployments(projectPath, provider, 15)
      .then((list) => {
        if (cancelled) return;
        setDeployments(list);
        setSelectedId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(formatCommandError(asCommandError(err)));
        setDeployments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectPath, provider]);

  // The log is fetched per selection rather than up front: it's a separate
  // request per deployment, and most of them are never opened.
  useEffect(() => {
    if (!selected || !provider) return;
    const id = selected.id;
    let cancelled = false;
    getDeploymentLog(projectPath, provider, id)
      .then((next) => {
        if (!cancelled) setLogEntry({ id, log: next });
      })
      .catch((err) => {
        if (!cancelled) {
          setLogEntry({ id, error: formatCommandError(asCommandError(err)) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, provider, selected]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!deployments || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
      event.preventDefault();
      const index = deployments.findIndex((d) => d.id === selected?.id);
      const next =
        deployments[
          Math.min(
            deployments.length - 1,
            Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1))
          )
        ];
      if (!next) return;
      setSelectedId(next.id);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-deployment-id="${CSS.escape(next.id)}"]`)
        ?.focus();
    },
    [deployments, selected]
  );

  const open = useCallback(
    (url?: string | null) => {
      if (!url) return;
      void openUrl(url).catch((err) => {
        logger.warn('deployments: failed to open url', { error: String(err) });
        showToast("Couldn't open that link", 'error');
      });
    },
    [showToast]
  );

  if (!isOpen) return null;

  return (
    <ModalFrame
      isOpen
      onClose={close}
      title={`Deployments — ${name}`}
      className="deployments-modal"
    >
      <div className="deployments">
        <div
          className="deployments-list"
          role="listbox"
          aria-label={`Recent ${name} deployments`}
          aria-activedescendant={selected ? `deployment-${selected.id}` : undefined}
          ref={listRef}
          onKeyDown={handleKeyDown}
        >
          {deployments === null && (
            <p className="deployments-empty text-style-hint">Loading…</p>
          )}
          {deployments?.length === 0 && (
            <p className="deployments-empty text-style-hint">
              {loadError ?? `${name} has no deployments for this project yet.`}
            </p>
          )}
          {deployments?.map((deployment) => (
            <button
              key={deployment.id}
              id={`deployment-${deployment.id}`}
              data-deployment-id={deployment.id}
              type="button"
              role="option"
              aria-selected={deployment.id === selected?.id}
              tabIndex={deployment.id === selected?.id ? 0 : -1}
              className={`deployments-item${
                deployment.id === selected?.id ? ' is-selected' : ''
              }`}
              onClick={() => setSelectedId(deployment.id)}
            >
              <span
                className="deployments-item-dot"
                data-state={DOT_STATE[deployment.phase.phase] ?? 'pending'}
                aria-hidden
              />
              <span className="deployments-item-body">
                <span className="deployments-item-title text-style-control-semibold">
                  {titleFor(deployment)}
                </span>
                <span className="deployments-item-meta text-style-hint">
                  {PHASE_LABEL[deployment.phase.phase] ?? 'Unrecognized'}
                  {` · ${formatRelativeTime(deployment.created_at)}`}
                  {deployment.environment === 'preview' && ' · Preview'}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="deployments-detail">
          {selected ? (
            <>
              <div className="deployments-detail-header">
                <div className="deployments-detail-meta">
                  {selected.branch && (
                    <span className="deployments-chip">{selected.branch}</span>
                  )}
                  <span className="deployments-chip">{selected.commit_sha.slice(0, 7)}</span>
                  {buildDuration(selected) && (
                    <span className="text-style-hint">Built in {buildDuration(selected)}</span>
                  )}
                </div>
                <div className="deployments-detail-actions">
                  {selected.urls.primary && (
                    <Button size="compact" onClick={() => open(selected.urls.primary)}>
                      Open site
                    </Button>
                  )}
                  {selected.dashboard_url && (
                    <Button
                      size="compact"
                      variant="secondary"
                      onClick={() => open(selected.dashboard_url)}
                    >
                      Open in {name}
                    </Button>
                  )}
                </div>
              </div>

              {/* Said plainly and first: if this build failed, the reason is
                  what you opened the panel for. */}
              {selected.error_message && (
                <p className="deployments-error">
                  <AlertIcon size={12} />
                  <span>{selected.error_message}</span>
                </p>
              )}

              <div className="deployments-log">
                {loadingLog ? (
                  <div className="deployments-log-loading">
                    <Spinner size="sm" />
                    <span className="text-style-hint">Loading build output…</span>
                  </div>
                ) : logError ? (
                  <p className="deployments-log-note text-style-hint">{logError}</p>
                ) : log && log.lines.length > 0 ? (
                  <pre className="deployments-log-body">
                    {log.lines.map((line) => line.text).join('\n')}
                  </pre>
                ) : (
                  <p className="deployments-log-note text-style-hint">
                    {name} returned no build output for this deployment.
                  </p>
                )}
              </div>

              {log?.truncated && (
                <p className="deployments-note text-style-hint">
                  Showing the most recent output — {name} caps how much it returns.
                </p>
              )}
            </>
          ) : (
            <p className="text-style-hint">Nothing to show.</p>
          )}
        </div>
      </div>
    </ModalFrame>
  );
}
