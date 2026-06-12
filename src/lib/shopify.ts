/**
 * Shopify theme integration.
 *
 * Wrappers for the Shopify backend commands (CLI detection, per-project store
 * config) plus the agent prompt builders used by the preview-pane setup gate
 * and the command palette. The dev server itself (`shopify theme dev`) runs
 * through the standard custom-command PTY path in `useDevServer`.
 *
 * @module lib/shopify
 */

import { invoke } from '@tauri-apps/api/core';

/** Shopify CLI install status, mirroring the backend's AgentCliStatus. */
export interface ShopifyCliStatus {
  installed: boolean;
  version: string | null;
}

/** Check whether the Shopify CLI is installed (validated probe, not just on-disk). */
export async function checkShopifyCliStatus(): Promise<ShopifyCliStatus> {
  return invoke<ShopifyCliStatus>('check_shopify_cli_status');
}

/** Get the connected store domain for a theme project (null = not connected). */
export async function getShopifyStore(projectPath: string): Promise<string | null> {
  return invoke<string | null>('get_shopify_store', { projectPath });
}

/** Persist (or clear) the connected store domain for a theme project. */
export async function setShopifyStore(projectPath: string, store: string | null): Promise<void> {
  return invoke<void>('set_shopify_store', { projectPath, store });
}

/**
 * Reap leftover `shopify theme dev` processes for a store before spawning a
 * new one. Instances stuck on interactive prompts never bind their port (so
 * the port-based orphan reaper misses them) and their stale dev session
 * makes the next run stall on a "proceed?" confirm.
 */
export async function killStaleThemeDev(store: string): Promise<void> {
  return invoke<void>('kill_stale_theme_dev', { store });
}

/**
 * Normalize whatever the user pastes into a bare store domain, or null if it
 * can't be one. Accepts `my-store`, `my-store.myshopify.com`, full URLs, and
 * admin URLs (`admin.shopify.com/store/my-store`).
 */
export function normalizeStoreDomain(input: string): string | null {
  let s = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '');
  const adminMatch = /^admin\.shopify\.com\/store\/([a-z0-9-]+)/.exec(s);
  if (adminMatch) {
    s = `${adminMatch[1]}.myshopify.com`;
  }
  s = s.replace(/[/?#].*$/, '');
  if (!s) return null;
  if (!s.includes('.')) s = `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(s)) return null;
  return s;
}

/**
 * The dev command for a connected theme project. `shopify theme dev` renders
 * Liquid server-side against the store and hot-reloads on file change; the
 * first run opens the browser for Shopify login.
 */
export function shopifyThemeDevCommand(store: string, port: number): string {
  return `shopify theme dev --store ${store} --port ${port}`;
}

/** The store's admin dashboard URL. */
export function shopifyAdminUrl(store: string): string {
  return `https://${store}/admin`;
}

/**
 * On first run (or after token expiry), `shopify theme dev` prints a device
 * verification code and then blocks on "Press any key to open the login page
 * on your browser". The dev-server PTY is display-only — nobody can press a
 * key — so the caller watches output with this detector and writes a
 * keystroke into the PTY when the prompt appears, which opens the browser
 * login automatically.
 *
 * Returns a stateful per-chunk matcher: feeds keep a rolling tail so the
 * sentence is found even when it's split across PTY chunks, and it latches
 * after the first hit so one server run nudges at most once.
 */
export function createLoginPromptDetector(): (chunk: string) => boolean {
  const prompt = /press any key to open the login page/i;
  let tail = '';
  let fired = false;
  return (chunk: string) => {
    if (fired) return false;
    tail = (tail + chunk).slice(-512);
    if (prompt.test(tail)) {
      fired = true;
      return true;
    }
    return false;
  };
}

/** Where to create a free development store. */
export const SHOPIFY_PARTNERS_URL = 'https://partners.shopify.com';

/**
 * Agent prompt for installing the Shopify CLI — same hand-the-heavy-lifting
 * pattern as the mobile toolchain setup in DeviceMirror.
 */
export const SHOPIFY_CLI_SETUP_PROMPT =
  "I want to build a Shopify theme in Ship Studio, but the Shopify CLI isn't installed on " +
  'this machine. Please do the heavy lifting to set it up: install it with Homebrew ' +
  '(`brew tap shopify/shopify && brew install shopify-cli`) if Homebrew is available, ' +
  'otherwise use `npm install -g @shopify/cli@latest`. If Homebrew is owned by another ' +
  'user, prefer the npm route instead of sudo. Verify `shopify version` prints a version ' +
  'when you\'re done, then tell me to click "Try again".';

/**
 * Agent prompt for building a new theme section. The agent interviews the
 * user first, then scaffolds the section with a full schema and wires it into
 * a template so it shows up in the preview immediately.
 */
export function buildSectionPrompt(): string {
  return (
    'I want to add a new section to my Shopify theme. First, briefly interview me: what ' +
    'the section is for, what content it needs (headings, text, images, buttons, ' +
    'products/collections), and which page it belongs on. Then do the heavy lifting: ' +
    'create the section file under sections/ with a complete {% schema %} (name, ' +
    'settings, and a preset so it appears in the Shopify customizer), reuse the ' +
    "theme's existing CSS custom properties and design patterns, add any new " +
    'translation keys to locales/en.default.json, and add the section to the right ' +
    'template JSON (e.g. templates/index.json) so I can see it in the preview right away.'
  );
}

/**
 * Agent prompt for pushing the theme to the connected store. Defaults to an
 * unpublished theme so the user's live storefront is never clobbered.
 */
export function buildPushPrompt(store: string): string {
  return (
    `Push this theme to my Shopify store ${store} using the Shopify CLI. Use ` +
    '`shopify theme push --store ' +
    store +
    ' --unpublished` with a sensible theme name so my live theme is NOT overwritten, ' +
    'wait for it to finish, and give me the preview and editor URLs it prints. If the ' +
    'CLI asks me to log in, walk me through it. Only push to the published theme if I ' +
    'explicitly ask for that.'
  );
}
