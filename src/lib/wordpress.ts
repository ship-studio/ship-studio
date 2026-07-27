/**
 * WordPress integration.
 *
 * Wrappers for the WordPress backend commands (per-project site config) plus
 * the URL normalization used by the preview-pane setup gate.
 *
 * WordPress differs from the other theme integrations Ship Studio supports.
 * Shopify and HubSpot each ship a CLI (`shopify theme dev`, `hs cms theme
 * preview`) that renders *local* theme files against *remote* account data, so
 * their previews show local edits. WordPress has no such tool — it is PHP plus
 * a database, and runs only where both exist. So the preview reverse-proxies
 * the project's live site instead: real content, real rendering, but the
 * deployed theme rather than the working copy. Local edits appear only after
 * they are deployed.
 *
 * @module lib/wordpress
 */

import { invoke } from '@tauri-apps/api/core';

/** Get the live site a WordPress project previews (null = not connected). */
export async function getWordpressSiteUrl(projectPath: string): Promise<string | null> {
  return invoke<string | null>('get_wordpress_site_url', { projectPath });
}

/** Persist (or clear) the live site a WordPress project previews. */
export async function setWordpressSiteUrl(
  projectPath: string,
  siteUrl: string | null
): Promise<void> {
  return invoke<void>('set_wordpress_site_url', { projectPath, siteUrl });
}

/**
 * Probe a candidate site before saving it, so the setup gate can report a
 * dead host instead of handing the user a blank preview. Resolves to the HTTP
 * status, or null if the host was unreachable.
 */
export async function probeWordpressSite(siteUrl: string): Promise<number | null> {
  return invoke<number | null>('probe_wordpress_site', { siteUrl });
}

/**
 * Normalize whatever the user pastes into a bare `https://host` origin, or
 * null if it can't be one. Accepts `example.com`, `https://example.com/`,
 * `www.example.com/blog`, and hosts with an explicit port.
 *
 * Defaults to HTTPS when no scheme is given — a live WordPress site in 2026
 * is served over TLS, and guessing `http://` would trip the host's own
 * redirect on every request.
 */
export function normalizeSiteUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    // Bare single labels ("localhost" aside) are almost always a typo.
    if (parsed.hostname !== 'localhost') return null;
  }
  // The backend rejects anything carrying a path — the proxy owns paths.
  return `${parsed.protocol}//${parsed.host}`;
}

/** Host portion of a normalized origin, for display and for the proxy target. */
export function siteHost(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return siteUrl;
  }
}

/** Whether a normalized origin is served over TLS. */
export function siteIsTls(siteUrl: string): boolean {
  return siteUrl.startsWith('https://');
}

/** Port the proxy should connect to, defaulting to the scheme's. */
export function sitePort(siteUrl: string): number {
  try {
    const parsed = new URL(siteUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 443;
  }
}

/** SSH connection details for running `wp` against a WordPress install. */
export interface WordpressSsh {
  host?: string | null;
  user?: string | null;
  keyPath?: string | null;
  wpPath?: string | null;
}

/** A complete connection: what to preview, and how to reach it. */
export interface WordpressConnection {
  siteUrl: string;
  ssh: WordpressSsh;
}

/**
 * Derive a full WP Engine connection from an install name. WP Engine names
 * everything after the install, so one input yields host, user, path and URL.
 */
export async function deriveWpEngineConfig(install: string): Promise<WordpressConnection> {
  return invoke<WordpressConnection>('derive_wpengine_config', { install });
}

/** Read the stored SSH connection for a project (null = not configured). */
export async function getWordpressSsh(projectPath: string): Promise<WordpressSsh | null> {
  return invoke<WordpressSsh | null>('get_wordpress_ssh', { projectPath });
}

/** Persist (or clear) the SSH connection for a project. */
export async function setWordpressSsh(
  projectPath: string,
  ssh: WordpressSsh | null
): Promise<void> {
  return invoke<void>('set_wordpress_ssh', { projectPath, ssh });
}

/**
 * Drop the pending marker once the project has real WordPress files, so
 * detection stands on its own evidence. Resolves true if it cleared one.
 */
export async function reconcileWordpressPending(projectPath: string): Promise<boolean> {
  return invoke<boolean>('reconcile_wordpress_pending', { projectPath });
}

/** Mark a project as WordPress before any theme files exist. */
export async function setWordpressPending(projectPath: string, pending: boolean): Promise<void> {
  return invoke<void>('set_wordpress_pending', { projectPath, pending });
}

/**
 * The `ssh … wp …` command line for this connection, for display and for
 * handing to the agent. Returns null unless the connection is complete.
 */
export function wpSshCommand(ssh: WordpressSsh | null): string | null {
  if (!ssh?.host || !ssh.user || !ssh.wpPath) return null;
  const key = ssh.keyPath ? `-i ${ssh.keyPath} ` : '';
  return `ssh ${key}${ssh.user}@${ssh.host} "wp <command> --path=${ssh.wpPath}"`;
}

/**
 * Prompt for the agent to stand up a local WordPress site.
 *
 * PHP + SQLite rather than Docker: it needs no daemon, no account and no
 * payment, so the agent can run the whole thing unattended. The resulting
 * site is an ordinary HTTP origin on localhost, which the preview proxy
 * already handles as a non-remote target — no extra wiring needed.
 */
export function localSiteSetupPrompt(projectPath: string, port: number): string {
  return [
    `Set up a local WordPress site for this project at ${projectPath}.`,
    '',
    'Steps:',
    '1. Ensure PHP and WP-CLI are available (`brew install php wp-cli` on macOS).',
    '2. `wp core download --path=wp` inside the project.',
    '3. Add the SQLite drop-in so no MySQL server is needed:',
    '   download the `sqlite-database-integration` plugin into',
    '   `wp/wp-content/plugins/`, then copy its `db.copy` to',
    '   `wp/wp-content/db.php` (edit the placeholder paths as its README says).',
    '4. `wp config create --dbname=wordpress --dbuser=root --skip-check --path=wp`',
    '5. `wp core install --url=http://localhost:' +
      port +
      ' --title="My Site" --admin_user=admin --admin_password=admin --admin_email=admin@example.com --path=wp`',
    '',
    'Notes:',
    "- WP-CLI's default 128M memory limit can kill `wp core download` during",
    '  extraction. If that happens, run commands as',
    '  `php -d memory_limit=512M $(which wp) <command> --path=wp`.',
    `- The install URL must be http://localhost:${port} exactly — WordPress`,
    '  stores it in the database and serves absolute links from it.',
    '- **Do not leave a server running.** Ship Studio starts and supervises it',
    "  as the project's dev server; a server backgrounded from your shell dies",
    '  with the session and the preview would break. To verify, start one',
    '  briefly, check it responds, then stop it.',
    '',
    'When the install is complete, tell me — Ship Studio will serve it.',
    'Do not modify anything outside this project.',
  ].join('\n');
}

/**
 * Prompt for the agent to set up SSH access to an existing install, so it can
 * run `wp` remotely. Content and config live in the site's database, not the
 * repo, so this is the only way an agent can change them.
 */
export function sshSetupPrompt(ssh: WordpressSsh): string {
  const keyPath = ssh.keyPath ?? '~/.ssh/wordpress_site';
  return [
    'Set up SSH access to this WordPress install so `wp` can be run remotely.',
    '',
    `1. If ${keyPath} does not exist, generate it:`,
    `   \`ssh-keygen -t ed25519 -f ${keyPath} -N ""\``,
    `2. Print the public key (${keyPath}.pub) and tell me to add it to the`,
    "   host's control panel — I have to do that part myself in the browser.",
    '3. Once I confirm, verify the connection end to end:',
    `   \`ssh -i ${keyPath} ${ssh.user ?? '<user>'}@${ssh.host ?? '<host>'} "wp option get home --path=${ssh.wpPath ?? '<path>'}"\``,
    '',
    'Report the verified home URL back to me.',
  ].join('\n');
}

/**
 * Command Ship Studio runs to serve a local WordPress site.
 *
 * The site must be owned by Ship Studio rather than left running by the agent:
 * a server the agent backgrounds dies with its shell session, so the preview
 * works once and then 502s with nothing listening. Running it as the project's
 * dev server means it's supervised, visible in the dev-server panel, and comes
 * back when the project is reopened.
 */
export function localServerCommand(port: number, wpDir = 'wp'): string {
  // PHP's built-in server (what `wp server` wraps) is single-threaded by
  // default, so a page plus its assets serialize through one process and the
  // preview crawls. Workers are set via the environment, and `env` is used
  // rather than shell syntax because the PTY layer splits the command on
  // whitespace and never invokes a shell.
  return `env PHP_CLI_SERVER_WORKERS=${LOCAL_SERVER_WORKERS} wp server --port=${port} --path=${wpDir}`;
}

/** Worker processes for the local PHP server. */
const LOCAL_SERVER_WORKERS = 4;

/** What the dev server should do for a WordPress project. */
export interface LocalServerPlan {
  serve: boolean;
  port: number | null;
  installDir: string | null;
  /** Why, for the log line — every non-serving case is a distinct situation. */
  reason: string;
}

/**
 * Decide whether Ship Studio should serve this WordPress project locally.
 *
 * Shared by the dev server's start and restart paths *on purpose*: they were
 * separate copies of this logic, they drifted, and the restart path shipped
 * without a WordPress branch at all — falling through to `npm run dev` in a
 * project with no package.json. One decision, two callers.
 */
export function planLocalServer(
  siteUrl: string | null | undefined,
  installDir: string | null
): LocalServerPlan {
  const nothing = (reason: string): LocalServerPlan => ({
    serve: false,
    port: null,
    installDir: null,
    reason,
  });

  if (!siteUrl) return nothing('no site connected yet');
  if (!isLocalSite(siteUrl)) return nothing('project previews a live site; nothing to serve');
  if (!installDir) return nothing('no WordPress install on disk yet');

  // The site's URL is baked into its database at install time, so it has to be
  // served on that exact port — not a reserved dev-server port.
  return {
    serve: true,
    port: sitePort(siteUrl),
    installDir,
    reason: 'serving local WordPress install',
  };
}

/**
 * Find a WordPress install inside the project (returns its directory relative
 * to the project, `.` for the root, or null if there isn't one).
 *
 * This is how the setup flow knows a local site exists. It deliberately does
 * not depend on the site answering over HTTP: Ship Studio serves the site, and
 * only does so once one is connected, so probing first would deadlock.
 */
export async function detectLocalWordpress(projectPath: string): Promise<string | null> {
  return invoke<string | null>('detect_local_wordpress', { projectPath });
}

/** Whether a connected site is a local one Ship Studio should serve itself. */
export function isLocalSite(siteUrl: string | null | undefined): boolean {
  if (!siteUrl) return false;
  const host = siteHost(siteUrl);
  return host === 'localhost' || host === '127.0.0.1';
}
