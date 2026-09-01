/**
 * Plugin management utilities for Ship Studio.
 *
 * Plugins are project-level: each project has its own set of plugins
 * stored at <project>/.shipstudio/plugins/.
 *
 * @module lib/plugins
 */

import { invoke } from '@tauri-apps/api/core';

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

/**
 * Built-in hosting integrations. They install like any other plugin (cloned
 * into `.shipstudio/plugins/<id>`) but the app renders them in a dedicated
 * header slot and the user never chose to add them — so a missing-on-disk
 * deactivation is an app-provisioning gap, not something the user did (issue
 * #386). Lives here rather than in a component so non-UI code can check it
 * without importing the workspace header.
 */
export const HOSTING_PLUGIN_IDS = ['vercel', 'cloudflare', 'netlify'];

const REGISTRY_URL =
  'https://raw.githubusercontent.com/ship-studio/plugin-registry/main/registry.json';

/** Cached registry to avoid re-fetching */
let registryCache: { plugins: PluginRegistryEntry[]; fetchedAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch the plugin library from the remote registry.
 */
export async function fetchPluginRegistry(): Promise<PluginRegistryEntry[]> {
  if (registryCache && Date.now() - registryCache.fetchedAt < CACHE_TTL) {
    return registryCache.plugins;
  }

  const response = await fetch(REGISTRY_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch plugin registry: ${response.status}`);
  }

  const data = (await response.json()) as { plugins: PluginRegistryEntry[] };
  registryCache = { plugins: data.plugins, fetchedAt: Date.now() };
  return data.plugins;
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
