/**
 * Shared web-links addon factory for xterm terminals.
 *
 * Makes plain-text URLs (e.g. a dev server printing http://localhost:3000)
 * clickable. OSC 8 explicit hyperlinks already work via xterm's built-in
 * support; this covers everything that isn't emitted as a hyperlink escape.
 * Links open in the system browser via the Tauri opener plugin — the
 * addon's default window.open is wrong inside a Tauri webview.
 *
 * @module lib/terminalLinks
 */

import { WebLinksAddon } from '@xterm/addon-web-links';
import { openUrl } from '@tauri-apps/plugin-opener';
import { logger } from './logger';

/** Create a WebLinksAddon that opens links in the system browser. */
export function createWebLinksAddon(): WebLinksAddon {
  return new WebLinksAddon((_event, uri) => {
    openUrl(uri).catch((err: unknown) => {
      logger.warn('[terminalLinks] Failed to open link', { uri, error: String(err) });
    });
  });
}
