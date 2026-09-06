/**
 * Browser detection and URL opening utilities.
 *
 * Provides functions for:
 * - Checking which browsers are installed on the system
 * - Opening URLs in a specific browser
 *
 * @module lib/browser
 */

import { invoke } from '@tauri-apps/api/core';

/** Information about an available browser */
export interface BrowserInfo {
  /**
   * Opaque launch identifier (macOS: bundle identifier, e.g. "com.google.Chrome";
   * Windows: the resolved executable path). The backend resolves it to a path.
   */
  id: string;
  /** Display name (e.g., "Google Chrome", "Zen") */
  name: string;
  /** The app's own icon as a PNG data URI, when the backend could extract one */
  icon?: string | null;
}

/**
 * Check which browsers are available on the system.
 * @returns List of installed browsers
 */
export async function checkBrowserAvailability(): Promise<BrowserInfo[]> {
  return invoke<BrowserInfo[]>('check_browser_availability');
}

/**
 * Open a URL in a specific browser.
 * @param url - The URL to open
 * @param browserId - The browser identifier (e.g., "chrome", "safari")
 */
export async function openUrlInBrowser(url: string, browserId: string): Promise<void> {
  return invoke('open_url_in_browser', { url, browserId });
}
