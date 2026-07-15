/**
 * Decision logic for automatic project-thumbnail capture.
 *
 * macOS surfaces window screenshots as a scary "record audio and screen
 * content" permission prompt (#160). These helpers make sure the prompt never
 * appears without context: auto-capture is gated on explicit in-app consent,
 * and a capture failure that looks like a permission denial permanently stops
 * auto-capture instead of re-triggering the prompt every 5 minutes.
 *
 * Kept pure (no Tauri, no React) so the gate is unit-testable.
 *
 * @module lib/thumbnailGate
 */

import type { ThumbnailConsent } from './settings';
import { asCommandError, formatCommandError } from './errors';

/**
 * What the auto-capture path should do given the persisted consent state.
 * - `proceed` — user allowed thumbnails; capture normally.
 * - `ask`     — never asked; defer the capture and show the in-app explainer.
 * - `skip`    — user opted out (or a capture hit a permission denial); never
 *               capture automatically until re-enabled in Settings.
 */
export type AutoCaptureDecision = 'proceed' | 'ask' | 'skip';

/** Gate for the background thumbnail capture. Manual captures are never gated. */
export function decideAutoCapture(consent: ThumbnailConsent): AutoCaptureDecision {
  if (consent === true) return 'proceed';
  if (consent === false) return 'skip';
  return 'ask';
}

/**
 * Heuristic: does a capture error look like a macOS screen-recording
 * permission denial (as opposed to a dead dev server, missing Playwright,
 * etc.)? Requires both a denial word and a screen/capture word so generic
 * failures ("EACCES: permission denied, open …") don't disable thumbnails.
 */
export function isPermissionDenialError(error: unknown): boolean {
  const message = formatCommandError(asCommandError(error)).toLowerCase();
  const denial = /permission|denied|not authorized|declined/.test(message);
  const screen =
    /screen recording|screen capture|screencapturekit|scstream|tcc|cgdisplay|record/.test(message);
  return denial && screen;
}
