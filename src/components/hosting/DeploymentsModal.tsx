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

/**
 * Fallback status words, for a deployment whose provider sent none.
 *
 * The provider's own `status_label` wins — this panel and the Push popover
 * describe the same deployments, and until now they disagreed about them: the
 * row printed Vercel's "Ready" while this list called the same deploy "Live",
 * and "Error" here read as "Failed". Two vocabularies for one deployment is
 * the thing the rest of this feature was rewritten to stop doing, and a user
 * comparing either against the Vercel dashboard had three.
 */
const PHASE_LABEL: Record<string, string> = {
  queued: 'Queued',
  building: 'Building',
  publishing: 'Publishing',
  ready: 'Ready',
  failed: 'Error',
  canceled: 'Canceled',
  skipped: 'Skipped',
  gated: 'Needs approval',
  unknown: 'Unrecognized',
};

/** The provider's own word, exactly as the hosting row resolves it. */
function statusWord(deployment: Deployment): string {
  return deployment.status_label?.trim() || PHASE_LABEL[deployment.phase.phase] || 'Unrecognized';
}

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
  /**
   * Three states, not two. `undefined` is "we haven't asked yet", `null` is
   * "asked, and this project deploys nowhere".
   *
   * Collapsing those into one `null` is what made this panel claim to be
   * loading forever: the fetch below bails on a falsy provider, so
   * `deployments` stayed null, and null renders "Loading…". Every project
   * without a hosting link — which is every project before you connect one —
   * opened this to a spinner for a request that was never going to be made.
   */
  const [provider, setProvider] = useState<HostingProvider | null | undefined>(undefined);
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

  // No "your host" placeholder in a heading: until we know the provider the
  // honest title is just "Deployments", and once we know there isn't one the
  // panel says so in its body rather than in its name.
  const name = provider ? PROVIDER_LABELS[provider] : null;
  const title = name ? `Deployments — ${name}` : 'Deployments';
  const selected = deployments?.find((d) => d.id === selectedId) ?? deployments?.[0] ?? null;

  const forSelected = selected && logEntry?.id === selected.id ? logEntry : null;
  const log = forSelected?.log ?? null;
  const logError = forSelected?.error ?? null;
  const loadingLog = selected != null && forSelected === null;

  // Which provider this project deploys to. Cheap: the status call is cached
  // backend-side for a few seconds and the popover has usually just made it.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // No state is cleared here on purpose. Everything in this component is
    // scoped to one project, and `WorkspaceModals` keys it by `projectPath`
    // so a switch remounts it — which discards all of it at once, rather than
    // relying on this effect to remember every field. Clearing by hand also
    // trips `react-hooks/set-state-in-effect`, and the rule is right: the fix
    // for "this state belongs to a different prop" is a key, not a reset.
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
    <ModalFrame isOpen onClose={close} title={title} className="deployments-modal">
      <div className="deployments">
        <div
          className="deployments-list"
          role="listbox"
          aria-label={name ? `Recent ${name} deployments` : 'Recent deployments'}
          aria-activedescendant={selected ? `deployment-${selected.id}` : undefined}
          ref={listRef}
          onKeyDown={handleKeyDown}
        >
          {/* "Loading" is claimed only while a request is actually outstanding.
              A project that deploys nowhere gets told so, because the request
              that would fill this list is never going to be made. */}
          {provider === undefined && <p className="deployments-empty text-style-hint">Loading…</p>}
          {provider === null && (
            <p className="deployments-empty text-style-hint">
              This project doesn’t deploy anywhere yet. Connect a host in the Push menu and
              deployments will show up here.
            </p>
          )}
          {provider && deployments === null && (
            <p className="deployments-empty text-style-hint">Loading…</p>
          )}
          {deployments?.length === 0 && (
            <p className="deployments-empty text-style-hint">
              {loadError ?? `${name ?? 'This host'} has no deployments for this project yet.`}
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
              className={`deployments-item${deployment.id === selected?.id ? ' is-selected' : ''}`}
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
                  {statusWord(deployment)}
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
                  {selected.branch && <span className="deployments-chip">{selected.branch}</span>}
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
