/**
 * Choose which provider project this repo deploys to.
 *
 * Two paths, in the order that respects what the user already did:
 *
 * 1. **A link found on disk.** If `.vercel/project.json` or
 *    `.netlify/state.json` is there, the user already linked this repo with the
 *    provider's own CLI and the answer is one click, no network.
 * 2. **Pick from the account.** Otherwise, list what the token can see. This is
 *    the only path for Cloudflare Pages, which leaves nothing on disk.
 */

import { useCallback, useRef, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { EmptyState } from '../primitives/EmptyState';
import { VercelIcon, CloudflareIcon } from '../icons';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  listHostingProjects,
  setHostingLink,
  PROVIDER_LABELS,
  type DetectedLink,
  type HostingProjectChoice,
  type HostingProvider,
} from '../../lib/hosting';

const PROVIDERS: HostingProvider[] = ['vercel', 'cloudflare', 'netlify'];

function ProviderMark({ provider }: { provider: HostingProvider }) {
  if (provider === 'vercel') return <VercelIcon size={14} />;
  if (provider === 'cloudflare') return <CloudflareIcon size={14} />;
  return <span className="hosting-row-globe" aria-hidden="true" />;
}

interface Props {
  projectPath: string;
  detected: DetectedLink[];
  onLinked: () => void;
  /** The chosen provider has no usable credential yet. */
  onNeedsToken: (provider: HostingProvider) => void;
  onClose: () => void;
}

export function HostingLinkPicker({
  projectPath,
  detected,
  onLinked,
  onNeedsToken,
  onClose,
}: Props) {
  const { showToast } = useOptionalToast();
  const [provider, setProvider] = useState<HostingProvider | null>(null);
  const [projects, setProjects] = useState<HostingProjectChoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * Which provider request is current. Pick Vercel, go back, pick Netlify, and
   * Vercel's slower response could still land last — storing Vercel's projects
   * while the header says Netlify. Choosing a row then wrote a Vercel project
   * id as the project's *Netlify* link, and a stale `NotAuthenticated` opened
   * the token flow for the wrong provider. Both persist wrong data from a
   * request the user had already abandoned.
   */
  const requestRef = useRef(0);

  const confirmDetected = useCallback(
    async (link: DetectedLink) => {
      setSaving(true);
      try {
        await setHostingLink(projectPath, {
          provider: link.provider,
          project_id: link.project_id,
          scope_id: link.scope_id,
          project_name: link.project_name,
          source: link.source,
          linked_at: 0,
        });
        onLinked();
      } catch (err) {
        showToast(formatCommandError(asCommandError(err)), 'error');
      } finally {
        setSaving(false);
      }
    },
    [projectPath, onLinked, showToast]
  );

  const choose = useCallback(
    async (next: HostingProvider) => {
      const generation = ++requestRef.current;
      const isCurrent = () => requestRef.current === generation;

      setProvider(next);
      setProjects(null);
      setLoading(true);
      try {
        const list = await listHostingProjects(projectPath, next);
        if (isCurrent()) setProjects(list);
      } catch (err) {
        if (!isCurrent()) return;
        const error = asCommandError(err);
        // A missing credential is the expected first-run state, not a failure
        // worth a red toast — hand the user straight to the connect flow.
        if (error.type === 'NotAuthenticated') {
          onNeedsToken(next);
          return;
        }
        showToast(formatCommandError(error), 'error');
        setProvider(null);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [projectPath, onNeedsToken, showToast]
  );

  const link = useCallback(
    async (choice: HostingProjectChoice) => {
      if (!provider) return;
      setSaving(true);
      try {
        await setHostingLink(projectPath, {
          provider,
          project_id: choice.id,
          scope_id: choice.scope_id,
          project_name: choice.name,
          source: 'user_picked',
          linked_at: 0,
        });
        onLinked();
      } catch (err) {
        showToast(formatCommandError(asCommandError(err)), 'error');
      } finally {
        setSaving(false);
      }
    },
    [projectPath, provider, onLinked, showToast]
  );

  return (
    <ModalFrame isOpen onClose={onClose} title="Connect hosting" className="connect-modal">
      <div className="connect-modal-body">
        {detected.length > 0 && !provider ? (
          <>
            <p>This project is already linked with the provider's own command-line tool. Use it?</p>
            {detected.map((link) => (
              <Button
                key={link.provider}
                variant="secondary"
                width="fill"
                disabled={saving}
                onClick={() => void confirmDetected(link)}
              >
                <ProviderMark provider={link.provider} />
                {link.project_name
                  ? `${PROVIDER_LABELS[link.provider]} — ${link.project_name}`
                  : PROVIDER_LABELS[link.provider]}
              </Button>
            ))}
            <p className="connect-modal-muted">Or choose a different project:</p>
          </>
        ) : null}

        {!provider ? (
          <>
            {detected.length === 0 ? (
              <p>
                Pick where this project deploys, so Ship Studio can show you whether each push went
                live.
              </p>
            ) : null}
            {PROVIDERS.map((p) => (
              <Button key={p} variant="secondary" width="fill" onClick={() => void choose(p)}>
                <ProviderMark provider={p} />
                {PROVIDER_LABELS[p]}
              </Button>
            ))}
          </>
        ) : null}

        {provider && loading ? (
          <div className="connect-modal-loading">
            <Spinner />
            <span>Loading your {PROVIDER_LABELS[provider]} projects…</span>
          </div>
        ) : null}

        {provider && !loading && projects ? (
          projects.length === 0 ? (
            <EmptyState
              title={`No ${PROVIDER_LABELS[provider]} projects`}
              description="Nothing was returned for this account. Create a project on the provider first, or try a different token."
            />
          ) : (
            <div className="connect-modal-list">
              {projects.map((choice) => (
                <Button
                  key={choice.id}
                  variant="secondary"
                  width="fill"
                  disabled={saving}
                  onClick={() => void link(choice)}
                >
                  {choice.name}
                </Button>
              ))}
            </div>
          )
        ) : null}

        <div className="connect-modal-actions">
          {/* Going back invalidates the in-flight request too, so an abandoned
              provider's response can never land behind the user. */}
          <Button
            variant="secondary"
            onClick={
              provider
                ? () => {
                    requestRef.current += 1;
                    setProvider(null);
                    setProjects(null);
                    setLoading(false);
                  }
                : onClose
            }
          >
            {provider ? 'Back' : 'Cancel'}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
