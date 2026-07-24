/**
 * HubSpot CMS integration.
 *
 * Wrappers for the HubSpot backend commands (CLI detection, auth status,
 * per-project theme destination) plus the agent prompt builders used by the
 * preview-pane setup gate and the command palette. The preview server itself
 * (`hs cms theme preview`) runs through the standard custom-command PTY path
 * in `useDevServer`.
 *
 * @module lib/hubspot
 */

import { invoke } from '@tauri-apps/api/core';

/** HubSpot CLI install status, mirroring the backend's AgentCliStatus. */
export interface HubspotCliStatus {
  installed: boolean;
  version: string | null;
}

/** Check whether the HubSpot CLI (`hs`) is installed (validated probe). */
export async function checkHubspotCliStatus(): Promise<HubspotCliStatus> {
  return invoke<HubspotCliStatus>('check_hubspot_cli_status');
}

/** Check whether the HubSpot CLI has a configured (signed-in) account. */
export async function checkHubspotAuthStatus(): Promise<boolean> {
  return invoke<boolean>('check_hubspot_auth_status');
}

/** Get the Design Tools destination path for a theme project (null = unset). */
export async function getHubspotDest(projectPath: string): Promise<string | null> {
  return invoke<string | null>('get_hubspot_dest', { projectPath });
}

/** Persist (or clear) the Design Tools destination path for a theme project. */
export async function setHubspotDest(projectPath: string, dest: string | null): Promise<void> {
  return invoke<void>('set_hubspot_dest', { projectPath, dest });
}

/**
 * The project-relative directory holding the theme (`"."` or a direct child
 * like `rti-2026`), or null when no theme markers are found. Nested themes are
 * common in real projects (theme folder beside docs and agent config).
 */
export async function getHubspotThemeSrc(projectPath: string): Promise<string | null> {
  return invoke<string | null>('get_hubspot_theme_src', { projectPath });
}

/**
 * Reap leftover `hs cms theme preview` processes before spawning a new one.
 * Instances stuck on interactive prompts never bind their port, so the
 * port-based orphan reaper misses them.
 */
export async function killStaleHubspotPreview(): Promise<void> {
  return invoke<void>('kill_stale_hubspot_preview');
}

/**
 * Normalize whatever the user types into a Design Tools path, or null if it
 * can't be one. Lowercases, converts spaces to hyphens, strips surrounding
 * slashes, and rejects anything left that isn't a plain path.
 */
export function normalizeThemeDest(input: string): string | null {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '');
  if (!s) return null;
  if (s.includes('..')) return null;
  if (!/^[a-z0-9][a-z0-9-_./]*$/.test(s)) return null;
  return s;
}

/**
 * The default Design Tools destination for a project: the theme folder's name
 * (the src dir when the theme is nested, else the project folder), normalized.
 * Keeps the preview zero-config for the common case.
 */
export function defaultThemeDest(projectPath: string, themeSrc?: string | null): string {
  const base =
    themeSrc && themeSrc !== '.'
      ? themeSrc
      : (projectPath
          .replace(/[/\\]+$/, '')
          .split(/[/\\]/)
          .pop() ?? 'theme');
  return normalizeThemeDest(base) ?? 'theme';
}

/**
 * The preview command for a HubSpot theme project. `hs cms theme preview`
 * uploads the theme at `src` to the given Design Tools path, watches for
 * changes, and serves a local preview rendered against the connected account.
 * `--noSsl` keeps it plain HTTP so the app's preview proxy can attach
 * directly. It MUST be the camelCase form: the CLI's help advertises
 * `--no-ssl`, but its strict parser rejects that spelling with "Unknown
 * argument: ssl" (verified against hs 8.10.0); only `--noSsl` parses.
 */
export function hubspotPreviewCommand(src: string, dest: string, port: number): string {
  return `hs cms theme preview --src ${src} --dest ${dest} --noSsl --port ${port}`;
}

/** Where to get a free HubSpot developer/sandbox account. */
export const HUBSPOT_DEVELOPERS_URL = 'https://developers.hubspot.com';

/**
 * Agent prompt for installing the HubSpot CLI — same hand-the-heavy-lifting
 * pattern as the Shopify CLI setup.
 */
export const HUBSPOT_CLI_SETUP_PROMPT =
  "I want to work on a HubSpot CMS theme in Ship Studio, but the HubSpot CLI isn't " +
  'installed on this machine. Please do the heavy lifting to set it up: install it ' +
  'with `npm install -g @hubspot/cli@latest`. If npm hits a permissions error, fix ' +
  "the npm prefix rather than using sudo. Verify `hs --version` prints a version when you're " +
  'done, then tell me to click "Try again".';

/**
 * Agent prompt for connecting the HubSpot CLI to an account. `hs account auth`
 * is interactive (opens the browser for a personal access key), so the agent
 * walks the user through it rather than running it blind.
 */
export const HUBSPOT_AUTH_SETUP_PROMPT =
  'The HubSpot CLI is installed but not signed in to an account. Please run ' +
  '`hs account auth` for me and walk me through it: it opens a browser page where I ' +
  'create or copy a personal access key, and I paste that key back into the ' +
  'terminal. If no config exists yet it may ask to create one; accept the defaults. ' +
  'When `hs account list` shows a default account, tell me to click "Try again".';

/**
 * Agent prompt for pushing the theme to the connected HubSpot account.
 * Defaults to draft mode so the user's live pages are never clobbered.
 */
export function buildHubspotPushPrompt(src: string, dest: string): string {
  return (
    'Upload this theme to my HubSpot account using the HubSpot CLI. Use ' +
    '`hs cms upload ' +
    src +
    ' ' +
    dest +
    ' --cms-publish-mode draft` so my live site is NOT changed, wait for it to ' +
    'finish, and summarize what was uploaded. If the CLI reports auth problems, ' +
    'walk me through `hs account auth`. Only use publish mode if I explicitly ask ' +
    'for that.'
  );
}
