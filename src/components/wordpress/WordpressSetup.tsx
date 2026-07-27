/**
 * Preview-pane setup gate for WordPress projects.
 *
 * Two paths, matching the two ways people arrive at a WordPress project:
 *
 * - **Connect an existing site.** Ship Studio previews the live site (see
 *   lib/wordpress for why there's no local-theme preview) and stores the SSH
 *   connection so the agent can run `wp` against it. WordPress content and
 *   config live in the site's database, not the repo, so SSH is the only way
 *   an agent can change them. On WP Engine every field derives from the
 *   install name, so that path asks for one input.
 *
 * - **Create a new site.** No host, no account: the agent stands up a local
 *   WordPress on PHP + SQLite, which the preview proxy then treats as an
 *   ordinary localhost target.
 *
 * If a site is already connected the gate clears itself without painting.
 *
 * @module components/WordpressSetup
 */

import { useEffect, useState } from 'react';
import {
  deriveWpEngineConfig,
  detectLocalWordpress,
  getWordpressSiteUrl,
  isLocalSite,
  localSiteSetupPrompt,
  normalizeSiteUrl,
  probeWordpressSite,
  setWordpressSiteUrl,
  setWordpressSsh,
  sshSetupPrompt,
  type WordpressSsh,
} from '../../lib/wordpress';
import { useOptionalToast } from '../../contexts/ToastContext';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { preferredPortForProject } from '../../lib/ports';

/**
 * Port a locally-provisioned site is served on.
 *
 * Derived per project, never a constant: WordPress bakes its URL into its
 * database, so two local projects sharing a port would fight over it — and,
 * worse, a project with no install of its own would find the *other* project's
 * server answering and adopt it as its own site.
 */
function localSitePort(projectPath: string): number {
  return preferredPortForProject(projectPath);
}

/** A localhost target that isn't answering usually means "not started yet",
 *  not "wrong address" — say so, or the user reads a normal wait as a bug. */
function unreachableMessage(siteUrl: string): string {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(siteUrl);
  return isLocal
    ? `Nothing is answering on ${siteUrl} yet. If the agent is still setting the site up, let it finish and check again.`
    : `Couldn't reach ${siteUrl}. Check the address and your connection.`;
}

type Mode = 'choose' | 'wpengine' | 'manual' | 'create';

interface WordpressSetupProps {
  projectPath: string;
  /** Paste a prompt into the active agent terminal (user still presses Enter). */
  onSendToAgent?: (prompt: string) => void;
  /** A site was already connected — show the preview immediately. */
  onReady: (siteUrl: string) => void;
  /** A site was just connected — show the preview and adopt the new target. */
  onConnected: (siteUrl: string) => void;
}

export function WordpressSetup({
  projectPath,
  onSendToAgent,
  onReady,
  onConnected,
}: WordpressSetupProps) {
  const { showToast } = useOptionalToast();
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<Mode>('choose');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // The local-site prompt has been handed to the agent. The site won't exist
  // until the agent actually runs it, so the flow waits here rather than
  // dropping the user into a connect form that is guaranteed to fail.
  const [promptSent, setPromptSent] = useState(false);
  // A WordPress site is already answering on the local port.
  const [localSiteFound, setLocalSiteFound] = useState(false);

  // WP Engine path: one input.
  const [install, setInstall] = useState('');
  // Manual path: the same fields, entered explicitly.
  const [siteInput, setSiteInput] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshUser, setSshUser] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [wpPath, setWpPath] = useState('');

  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    void getWordpressSiteUrl(projectPath)
      .then(async (url) => {
        if (cancelled) return;
        if (url) {
          // A local URL with no install behind it is a stale connection — it
          // would preview whatever else happens to be on that port. Drop it
          // and start over rather than showing another project's site.
          if (isLocalSite(url) && !(await detectLocalWordpress(projectPath))) {
            await setWordpressSiteUrl(projectPath, null).catch(() => {});
            if (!cancelled) setChecking(false);
            return;
          }
          onReady(url);
          return;
        }
        setChecking(false);
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // onReady is intentionally not a dep — the parent passes an inline closure
    // and this should re-run only on project change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  /** Save a verified connection and hand the preview its target. */
  const persist = async (siteUrl: string, ssh: WordpressSsh | null) => {
    await setWordpressSiteUrl(projectPath, siteUrl);
    if (ssh) await setWordpressSsh(projectPath, ssh);
    onConnected(siteUrl);
  };

  /** Probe before saving so a typo surfaces here, not as a blank preview. */
  const probeThenPersist = async (siteUrl: string, ssh: WordpressSsh | null) => {
    const status = await probeWordpressSite(siteUrl);
    if (status === null) {
      setError(unreachableMessage(siteUrl));
      return false;
    }
    // A 4xx/5xx still proves the host is answering — a site behind a login
    // wall or a CDN challenge is worth previewing so the user can see it.
    if (status >= 400) {
      showToast(`${siteUrl} responded with ${status} — previewing anyway`, 'error');
    }
    await persist(siteUrl, ssh);
    return true;
  };

  const handleWpEngine = async () => {
    setError(null);
    setIsSaving(true);
    try {
      const conn = await deriveWpEngineConfig(install);
      const ok = await probeThenPersist(conn.siteUrl, conn.ssh);
      if (ok && onSendToAgent) {
        showToast('Site connected — SSH setup prompt sent to the agent', 'success');
        onSendToAgent(sshSetupPrompt(conn.ssh));
      }
    } catch (err) {
      logger.error('[WordpressSetup] WP Engine connect failed', { error: String(err) });
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setIsSaving(false);
    }
  };

  const handleManual = async () => {
    const normalized = normalizeSiteUrl(siteInput);
    if (!normalized) {
      setError('Enter a site address, like example.com');
      return;
    }
    setError(null);
    setIsSaving(true);
    try {
      // SSH is optional here — a site can be previewed without it; only
      // agentic editing needs the connection.
      const ssh: WordpressSsh | null = sshHost.trim()
        ? {
            host: sshHost.trim(),
            user: sshUser.trim() || null,
            keyPath: sshKeyPath.trim() || null,
            wpPath: wpPath.trim() || null,
          }
        : null;
      await probeThenPersist(normalized, ssh);
    } catch (err) {
      logger.error('[WordpressSetup] Manual connect failed', { error: String(err) });
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateLocal = () => {
    onSendToAgent?.(localSiteSetupPrompt(projectPath, localSitePort(projectPath)));
    showToast('Prompt pasted — press Enter in the terminal to run it', 'success');
    setPromptSent(true);
    setError(null);
  };

  // Entering the create screen, look for a site that's already running. The
  // agent may have finished in an earlier session, or the component may have
  // remounted — without this the only offer is "set it up again", which is
  // wrong when the site is sitting there working.
  useEffect(() => {
    if (mode !== 'create') return;
    let cancelled = false;
    // Files on disk, not a port probe: a port only tells you *someone* is
    // serving, which may be a different project entirely.
    void detectLocalWordpress(projectPath)
      .then((dir) => {
        if (!cancelled && dir) setLocalSiteFound(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mode, projectPath]);

  /**
   * Connect the local site.
   *
   * Checks the filesystem, not the port. Ship Studio serves local sites itself
   * and only starts doing so once one is connected, so requiring a live
   * response here would deadlock: the agent finishes and stops its server, and
   * nothing can ever start it again. An install on disk is the real proof.
   */
  const handleCheckLocal = async () => {
    setError(null);
    setIsSaving(true);
    try {
      const url = `http://localhost:${localSitePort(projectPath)}`;
      // Already serving (agent left one up, or a previous session) — take it.
      if ((await probeWordpressSite(url)) !== null) {
        await persist(url, null);
        return;
      }
      const installDir = await detectLocalWordpress(projectPath);
      if (!installDir) {
        setError(
          `No WordPress install found in this project yet. If the agent is still setting it up, let it finish and check again.`
        );
        return;
      }
      await persist(url, null);
      showToast('Site connected — starting the server', 'success');
    } catch (err) {
      logger.error('[WordpressSetup] Local site check failed', { error: String(err) });
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setIsSaving(false);
    }
  };

  if (checking) {
    return (
      <div className="wp-setup">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="wp-setup">
      <div className="wp-setup-card">
        {mode === 'choose' && (
          <>
            <h3 className="wp-setup-title">Set up WordPress</h3>
            <p className="wp-setup-hint">
              Connect a site you already have, or have the agent build you a new one locally.
            </p>
            <div className="wp-setup-choices">
              <button className="wp-setup-choice" onClick={() => setMode('wpengine')}>
                <span className="wp-setup-choice-title">Connect a WP Engine site</span>
                <span className="wp-setup-choice-sub">
                  Just the install name — the rest is derived
                </span>
              </button>
              <button className="wp-setup-choice" onClick={() => setMode('manual')}>
                <span className="wp-setup-choice-title">Connect another site</span>
                <span className="wp-setup-choice-sub">Any host — enter the address and SSH</span>
              </button>
              <button className="wp-setup-choice" onClick={() => setMode('create')}>
                <span className="wp-setup-choice-title">Create a new site</span>
                <span className="wp-setup-choice-sub">
                  Local WordPress, no host or account needed
                </span>
              </button>
            </div>
          </>
        )}

        {mode === 'wpengine' && (
          <>
            <h3 className="wp-setup-title">Connect your WP Engine site</h3>
            <p className="wp-setup-hint">
              Your install name — the site becomes{' '}
              <code>{install.trim() || 'install'}.wpenginepowered.com</code>, with SSH at{' '}
              <code>{install.trim() || 'install'}.ssh.wpengine.net</code>.
            </p>
            <input
              type="text"
              className="wp-setup-input"
              placeholder="myinstall"
              value={install}
              onChange={(e) => setInstall(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleWpEngine();
              }}
              disabled={isSaving}
              autoFocus
            />
            {error && <p className="wp-setup-error">{error}</p>}
            <Button
              variant="primary"
              onClick={() => void handleWpEngine()}
              disabled={isSaving || !install.trim()}
              block
            >
              {isSaving ? 'Connecting…' : 'Connect site'}
            </Button>
            <button className="wp-setup-back" onClick={() => setMode('choose')}>
              Back
            </button>
          </>
        )}

        {mode === 'manual' && (
          <>
            <h3 className="wp-setup-title">Connect your site</h3>
            <p className="wp-setup-hint">
              The preview shows this site as it&apos;s deployed. SSH is optional — it&apos;s what
              lets the agent run <code>wp</code> against the site&apos;s content.
            </p>
            <input
              type="text"
              className="wp-setup-input"
              placeholder="example.com"
              value={siteInput}
              onChange={(e) => setSiteInput(e.target.value)}
              disabled={isSaving}
              autoFocus
            />
            <input
              type="text"
              className="wp-setup-input"
              placeholder="SSH host (optional) — myinstall.ssh.wpengine.net"
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              disabled={isSaving}
            />
            {sshHost.trim() && (
              <>
                <input
                  type="text"
                  className="wp-setup-input"
                  placeholder="SSH user"
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  disabled={isSaving}
                />
                <input
                  type="text"
                  className="wp-setup-input"
                  placeholder="Key path — ~/.ssh/id_ed25519"
                  value={sshKeyPath}
                  onChange={(e) => setSshKeyPath(e.target.value)}
                  disabled={isSaving}
                />
                <input
                  type="text"
                  className="wp-setup-input"
                  placeholder="WordPress path — /sites/myinstall"
                  value={wpPath}
                  onChange={(e) => setWpPath(e.target.value)}
                  disabled={isSaving}
                />
              </>
            )}
            {error && <p className="wp-setup-error">{error}</p>}
            <Button
              variant="primary"
              onClick={() => void handleManual()}
              disabled={isSaving || !siteInput.trim()}
              block
            >
              {isSaving ? 'Connecting…' : 'Connect site'}
            </Button>
            <button className="wp-setup-back" onClick={() => setMode('choose')}>
              Back
            </button>
          </>
        )}

        {mode === 'create' && (
          <>
            <h3 className="wp-setup-title">Create a new WordPress site</h3>
            <p className="wp-setup-hint">
              The agent installs PHP and WP-CLI, then stands up WordPress on SQLite — no Docker, no
              hosting account. It runs on <code>localhost:{localSitePort(projectPath)}</code>, and
              unlike a connected live site, your local theme edits show up immediately.
            </p>
            {localSiteFound ? (
              <>
                <p className="wp-setup-hint">
                  A site is already running on <code>localhost:{localSitePort(projectPath)}</code>.
                </p>
                {error && <p className="wp-setup-error">{error}</p>}
                <Button
                  variant="primary"
                  onClick={() => void handleCheckLocal()}
                  disabled={isSaving}
                  block
                >
                  {isSaving ? 'Connecting…' : 'Connect it'}
                </Button>
              </>
            ) : !promptSent ? (
              <Button variant="primary" onClick={handleCreateLocal} block>
                Send setup to the agent
              </Button>
            ) : (
              <>
                <p className="wp-setup-hint">
                  The prompt is in the terminal — <strong>press Enter to run it</strong>. It
                  installs PHP and WP-CLI, so give it a few minutes. When the agent says the site is
                  up, check for it here.
                </p>
                {error && <p className="wp-setup-error">{error}</p>}
                <Button
                  variant="primary"
                  onClick={() => void handleCheckLocal()}
                  disabled={isSaving}
                  block
                >
                  {isSaving ? 'Checking…' : 'Check for the site'}
                </Button>
              </>
            )}
            <button className="wp-setup-back" onClick={() => setMode('choose')}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
