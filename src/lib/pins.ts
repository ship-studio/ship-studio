/**
 * Tauri wrappers for the pinned-projects backend commands.
 *
 * Pins are persisted on disk in `pins.json`
 * (`~/Library/Application Support/ShipStudio/pins.json` on macOS).
 * Backend invariants:
 *
 * - `pinProject` dedupes by path — repeated calls are idempotent.
 * - `reorderPins` requires the new order to contain exactly the same
 *   set of paths as the current pins (no adds, no removes, no dupes);
 *   otherwise it rejects with a `Validation` `CommandError`.
 *
 * @module lib/pins
 */

import { invoke } from '@tauri-apps/api/core';

/** Per-pin session metadata persisted across app restarts. */
export interface PinLastSession {
  /** Per-tab Claude/Codex session IDs in tab order. Used with `--resume`. */
  tabSessionIds: string[];
  /** Index of the last active tab. */
  activeTabIndex: number;
  /** Last agent ID (e.g. "claude-code", "codex"). */
  lastAgent: string | null;
  /** Unix millis when the session was last suspended/quit. */
  suspendedAt: number | null;
}

/** Add a project to the pinned list. Returns the updated ordered list. */
export async function pinProject(projectPath: string): Promise<string[]> {
  return invoke<string[]>('pin_project', { projectPath });
}

/** Remove a project from the pinned list. Returns the updated ordered list. */
export async function unpinProject(projectPath: string): Promise<string[]> {
  return invoke<string[]>('unpin_project', { projectPath });
}

/** Return the current ordered list of pinned project paths. */
export async function listPinnedProjects(): Promise<string[]> {
  return invoke<string[]>('list_pinned_projects');
}

/**
 * Replace the pin order. The new order must contain exactly the same set of
 * paths as the current pins — backend rejects sets with adds/removes/dupes.
 */
export async function reorderPins(orderedPaths: string[]): Promise<string[]> {
  return invoke<string[]>('reorder_pins', { orderedPaths });
}

/** Persist per-pin session metadata. Skipped silently if path is not pinned. */
export async function savePinSession(projectPath: string, session: PinLastSession): Promise<void> {
  return invoke('save_pin_session', { projectPath, session });
}

/** Read per-pin session metadata. Returns `null` if not yet saved. */
export async function getPinSession(projectPath: string): Promise<PinLastSession | null> {
  return invoke<PinLastSession | null>('get_pin_session', { projectPath });
}
