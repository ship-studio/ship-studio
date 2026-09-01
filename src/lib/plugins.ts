/**
 * Plugin management utilities for Ship Studio.
 *
 * Plugins are project-level: each project has its own set of plugins
 * stored at <project>/.shipstudio/plugins/.
 *
 * @module lib/plugins
 */

import { invoke } from '@tauri-apps/api/core';
import { asCommandError, formatCommandError } from './errors';
import { logger } from './logger';

/** Setup item contributed by a plugin */
export interface PluginSetupItem {
  id: string;
  label: string;
  depends_on: string[];
  check_command: string;
  install_command: string;
}

/** Plugin manifest from plugin.json */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  slots: string[];
  author: string;
  repository: string;
  setup: PluginSetupItem[];
  min_app_version: string;
  icon: string;
  required_commands: string[];
  api_version?: number;
}

/** Plugin info with registry state */
export interface PluginInfo {
  manifest: PluginManifest;
  enabled: boolean;
  installed_at: number;
  source_url: string;
  is_dev: boolean;
  local_path: string;
}

/** Result of checking for a plugin update */
export interface PluginUpdateCheck {
  has_update: boolean;
  installed_version: string;
  installed_commit: string;
  remote_commit: string;
}

/** A plugin entry from the remote plugin library */
export interface PluginRegistryEntry {
  id: string;
  name: string;
  description: string;
  repo: string;
  author: string;
  category: string;
  icon?: string;
}

/** Official Vercel plugin repository URL */
export const VERCEL_PLUGIN_REPO = 'https://github.com/ship-studio/plugin-vercel';

const REGISTRY_URL =
  'https://raw.githubusercontent.com/ship-studio/plugin-registry/main/registry.json';

/** Cached registry to avoid re-fetching */
let registryCache: { plugins: PluginRegistryEntry[]; fetchedAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Attempts (including the first) for a retryable registry fetch failure. */
const REGISTRY_FETCH_ATTEMPTS = 3;
/** First backoff step; doubled per retry. */
const REGISTRY_RETRY_BASE_MS = 500;
/** Ceiling on an honored `Retry-After`, so a rude header can't stall the modal. */
const REGISTRY_MAX_RETRY_WAIT_MS = 5000;

/**
 * Statuses worth a retry: raw.githubusercontent.com rate-limits shared egress
 * IPs with 429 (issue #713), and 5xx/408 are transient by definition. A 404 or
 * other 4xx is a real answer — retrying it just wastes the user's time.
 */
function isRetryableRegistryStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** `Retry-After` in ms (delta-seconds or HTTP-date), clamped, or null. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, REGISTRY_MAX_RETRY_WAIT_MS);
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - Date.now(), 0), REGISTRY_MAX_RETRY_WAIT_MS);
}

type RegistryFetchOutcome =
  | { kind: 'ok'; plugins: PluginRegistryEntry[] }
  /** Worth another attempt. `waitMs` is the server's `Retry-After`, if any. */
  | { kind: 'retry'; waitMs: number | null; error: Error }
  | { kind: 'fail'; error: Error };

async function attemptRegistryFetch(): Promise<RegistryFetchOutcome> {
  let response: Response;
  try {
    response = await fetch(REGISTRY_URL);
  } catch (err) {
    // Network-level failure (offline, DNS, TLS handshake) — often a blip.
    return {
      kind: 'retry',
      waitMs: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  if (response.ok) {
    const data = (await response.json()) as { plugins: PluginRegistryEntry[] };
    return { kind: 'ok', plugins: data.plugins };
  }
  const error = new Error(`Failed to fetch plugin registry: ${response.status}`);
  if (!isRetryableRegistryStatus(response.status)) {
    return { kind: 'fail', error };
  }
  return { kind: 'retry', waitMs: parseRetryAfter(response.headers.get('Retry-After')), error };
}

/**
 * Fetch the plugin library from the remote registry.
 *
 * Retries rate-limited (429), transient-server, and network failures with
 * backoff, honoring `Retry-After` when the server sends one — a single 429
 * from raw.githubusercontent.com used to empty the Library tab outright
 * (issue #713).
 */
export async function fetchPluginRegistry(): Promise<PluginRegistryEntry[]> {
  if (registryCache && Date.now() - registryCache.fetchedAt < CACHE_TTL) {
    return registryCache.plugins;
  }

  let backoff = REGISTRY_RETRY_BASE_MS;
  for (let attempt = 1; ; attempt++) {
    const outcome = await attemptRegistryFetch();
    if (outcome.kind === 'ok') {
      registryCache = { plugins: outcome.plugins, fetchedAt: Date.now() };
      return outcome.plugins;
    }
    if (outcome.kind === 'fail' || attempt >= REGISTRY_FETCH_ATTEMPTS) {
      throw outcome.error;
    }
    const waitMs = outcome.waitMs ?? backoff;
    logger.warn('Plugin registry fetch failed; retrying', {
      attempt,
      waitMs,
      error: outcome.error.message,
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    backoff = Math.min(backoff * 2, REGISTRY_MAX_RETRY_WAIT_MS);
  }
}

/**
 * True when a {@link fetchPluginRegistry} rejection means we couldn't reach or
 * read a response from the registry host (offline, DNS, TLS, a rate-limit or
 * server status that survived the retries) rather than the registry being
 * malformed. Reachability is the user's network; a broken body is ours to fix,
 * so only the former is downgraded out of telemetry (issue #713).
 */
export function isRegistryUnreachableError(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  return value.message.startsWith('Failed to fetch plugin registry:') || value instanceof TypeError;
}

/**
 * Backend plugin failures that are by-design refusals or user-environment
 * states, not app defects: manifest/bundle/id validation (issue #472), version
 * and command-permission checks, unclonable or unreachable repository URLs
 * (#803/#732), a missing bundle the self-heal couldn't repair (#770), and the
 * filesystem-permission classifications (#762).
 *
 * The backend already marks these `CommandError::expected`, but `Expected`
 * serializes across IPC identically to `Other`, so the frontend re-checks the
 * wording — exactly like `isExpectedProjectImportRefusal` in `lib/errors`.
 * Callers use it to pick `logger.warn` over `logger.error` and an `'info'`
 * toast over `'error'`; both of those otherwise auto-file a bug report for the
 * app behaving correctly (issues #734, #833, #762).
 */
const EXPECTED_PLUGIN_FAILURE_PHRASES = [
  // Manifest / bundle / id validation (install, update, dev-link)
  'Invalid plugin:',
  "Plugin manifest must have 'id' and 'name' fields",
  'Plugin ID contains invalid characters',
  'has no built bundle (dist/index.js)',
  'Plugin bundle not found',
  'requires Ship Studio v',
  'requests commands that are not available to plugins',
  'is already installed. Uninstall it first',
  // Repository URL refusals and remote-git classifications
  'Plugin repository URL',
  'points at a page inside a repository',
  "Couldn't find a git repository at that URL",
  "Couldn't reach the plugin's repository",
  'repository requires sign-in',
  "Git isn't installed or couldn't be located",
  // Filesystem / project-folder environment states (classify_fs_error,
  // validate_project_path)
  'Grant access in System Settings',
  'Windows denied access',
  'the disk or volume is read-only',
  'no longer exists — it may have been moved',
];

/** True when a plugin-command failure is one of the backend's by-design
 *  refusals or environment states (see {@link EXPECTED_PLUGIN_FAILURE_PHRASES}). */
export function isExpectedPluginFailure(value: unknown): boolean {
  const message = formatCommandError(asCommandError(value));
  return EXPECTED_PLUGIN_FAILURE_PHRASES.some((phrase) => message.includes(phrase));
}

/** Result of a plugin shell command */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

/**
 * List all installed plugins for a project.
 */
export async function listPlugins(projectPath: string): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>('list_plugins', { projectPath });
}

/**
 * Install a plugin from a GitHub repository URL into a project.
 */
export async function installPlugin(projectPath: string, repoUrl: string): Promise<PluginInfo> {
  return invoke<PluginInfo>('install_plugin', { projectPath, repoUrl });
}

/**
 * Uninstall a plugin by its ID from a project.
 */
export async function uninstallPlugin(projectPath: string, pluginId: string): Promise<void> {
  return invoke('uninstall_plugin', { projectPath, pluginId });
}

/**
 * Update a plugin to the latest version from its source.
 */
export async function updatePlugin(projectPath: string, pluginId: string): Promise<PluginInfo> {
  return invoke<PluginInfo>('update_plugin', { projectPath, pluginId });
}

/**
 * Check if a plugin has an update available.
 */
export async function checkPluginUpdate(
  projectPath: string,
  pluginId: string
): Promise<PluginUpdateCheck> {
  return invoke<PluginUpdateCheck>('check_plugin_update', { projectPath, pluginId });
}

/**
 * Read the JavaScript bundle source for a plugin.
 */
export async function readPluginBundle(projectPath: string, pluginId: string): Promise<string> {
  return invoke<string>('read_plugin_bundle', { projectPath, pluginId });
}

/**
 * Toggle a plugin's enabled/disabled state.
 */
export async function togglePlugin(
  projectPath: string,
  pluginId: string,
  enabled: boolean
): Promise<void> {
  return invoke('toggle_plugin', { projectPath, pluginId, enabled });
}

/**
 * Execute a shell command in a plugin's context.
 * Command runs in the project directory with a configurable timeout (default 120s).
 */
export async function execPluginShell(
  pluginId: string,
  projectPath: string,
  command: string,
  args: string[],
  timeoutSecs?: number
): Promise<ShellResult> {
  return invoke<ShellResult>('exec_plugin_shell', {
    pluginId,
    projectPath,
    command,
    args,
    timeoutSecs,
  });
}

/**
 * Read plugin storage data for a project.
 */
export async function readPluginStorage(
  pluginId: string,
  projectPath: string
): Promise<Record<string, unknown>> {
  return invoke('read_plugin_storage', { pluginId, projectPath });
}

/**
 * Write plugin storage data for a project.
 */
export async function writePluginStorage(
  pluginId: string,
  projectPath: string,
  data: Record<string, unknown>
): Promise<void> {
  return invoke('write_plugin_storage', { pluginId, projectPath, data });
}

/**
 * Link a local dev plugin folder into a project.
 * Opens a native folder picker. Returns null if user cancels.
 */
export async function linkDevPlugin(projectPath: string): Promise<PluginInfo | null> {
  return invoke<PluginInfo | null>('link_dev_plugin', { projectPath });
}

/**
 * Unlink a dev plugin from a project (removes from registry, keeps local files).
 */
export async function unlinkDevPlugin(projectPath: string, pluginId: string): Promise<void> {
  return invoke('unlink_dev_plugin', { projectPath, pluginId });
}
