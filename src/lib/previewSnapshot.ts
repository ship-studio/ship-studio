/**
 * Native in-app thumbnail capture: snapshot the preview pane straight out of
 * the app's own webview (WKWebView takeSnapshot on macOS) instead of spawning
 * a headless browser against the dev server.
 *
 * This is the preferred thumbnail path — it has none of the external-browser
 * failure modes (profile locks, crashpad races, missing browsers, zombie
 * processes) and costs no per-capture browser launch. When it can't run
 * (platform unsupported, preview hidden or covered), callers fall back to the
 * headless `capture_project_thumbnail` path.
 */

import { invoke } from '@tauri-apps/api/core';
import { logger } from './logger';
import { asCommandError, formatCommandError } from './errors';

export interface SnapshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Selector for the live preview iframe rendered by Preview.tsx. */
const PREVIEW_IFRAME_SELECTOR = 'iframe.preview-iframe';

/** Below this on-screen size a snapshot would make a useless thumbnail —
 *  matches the backend's own floor. */
const MIN_SNAPSHOT_WIDTH = 200;
const MIN_SNAPSHOT_HEIGHT = 150;

/**
 * Compute the preview pane's snapshot rect, or null when a snapshot taken now
 * would be wrong: preview unmounted, collapsed, scrolled off-screen, or
 * covered by an overlay (a modal over the preview would be baked into the
 * thumbnail — the app UI is part of the same webview content).
 */
export function previewSnapshotRect(doc: Document = document): SnapshotRect | null {
  const iframe = doc.querySelector<HTMLIFrameElement>(PREVIEW_IFRAME_SELECTOR);
  if (!iframe) return null;

  const rect = iframe.getBoundingClientRect();
  if (rect.width < MIN_SNAPSHOT_WIDTH || rect.height < MIN_SNAPSHOT_HEIGHT) return null;

  const win = doc.defaultView;
  if (!win) return null;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  if (centerX < 0 || centerY < 0 || centerX > win.innerWidth || centerY > win.innerHeight) {
    return null;
  }

  // Occlusion probe: from the parent document, the topmost element at the
  // preview's center should be the iframe itself. Anything else means an
  // overlay (modal, dropdown, edit-mode chrome) is covering it. A null
  // result (jsdom, exotic edge cases) is treated as clear.
  const topmost = doc.elementFromPoint(centerX, centerY);
  if (topmost && topmost !== iframe) return null;

  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * Try to capture the project thumbnail via the native webview snapshot.
 * Returns true on success; false whenever the caller should fall back to the
 * headless capture path. Never throws.
 */
export async function captureThumbnailFromPreview(projectPath: string): Promise<boolean> {
  if (document.hidden) return false;
  const rect = previewSnapshotRect();
  if (!rect) return false;

  try {
    await invoke('capture_thumbnail_from_webview', { projectPath, rect });
    return true;
  } catch (error) {
    const message = formatCommandError(asCommandError(error));
    // Known quiet fallbacks (Expected on the backend, which mirrors to a
    // plain message here): platform unsupported, capture already running,
    // rect raced to something unusable.
    const quietFallback =
      message.includes('not supported on this platform') ||
      message.includes('already in progress') ||
      message.includes('too small or invalid');
    if (!quietFallback) {
      logger.warn('[Thumbnail] Native webview snapshot failed, falling back to headless', {
        error: message,
      });
    }
    return false;
  }
}
