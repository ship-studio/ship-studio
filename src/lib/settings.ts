/**
 * UI Settings
 *
 * Persisted user preferences for dashboard UI elements.
 *
 * @module lib/settings
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Check if the GitHub contribution calendar is hidden on the dashboard.
 */
export async function getCalendarHidden(): Promise<boolean> {
  try {
    return await invoke<boolean>('get_calendar_hidden');
  } catch {
    return false; // Default to visible
  }
}

/**
 * Set whether the GitHub contribution calendar is hidden (persisted across sessions).
 */
export async function setCalendarHidden(hidden: boolean): Promise<void> {
  try {
    await invoke('set_calendar_hidden', { hidden });
  } catch {
    // Silently fail
  }
}

/**
 * Check if the Slack community CTA is hidden on the dashboard.
 */
export async function getSlackCtaHidden(): Promise<boolean> {
  try {
    return await invoke<boolean>('get_slack_cta_hidden');
  } catch {
    return false;
  }
}

/**
 * Set whether the Slack community CTA is hidden (persisted across sessions).
 */
export async function setSlackCtaHidden(hidden: boolean): Promise<void> {
  try {
    await invoke('set_slack_cta_hidden', { hidden });
  } catch {
    // Silently fail
  }
}

/**
 * Check whether the terminal uses WebGL (GPU-accelerated) rendering. Defaults to true.
 * Users on macOS beta builds or certain GPU drivers may see corrupted glyphs with WebGL
 * and should disable this.
 */
export async function getTerminalGpuEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>('get_terminal_gpu_enabled');
  } catch {
    return true;
  }
}

/**
 * Set whether the terminal uses WebGL rendering (persisted across sessions).
 * Takes effect for newly opened terminals.
 */
export async function setTerminalGpuEnabled(enabled: boolean): Promise<void> {
  try {
    await invoke('set_terminal_gpu_enabled', { enabled });
  } catch {
    // Silently fail
  }
}

// ============ Projects root directory ============

/**
 * Get the projects root directory (absolute path). This is where Ship Studio
 * lists and creates projects. Falls back to the default `~/ShipStudio` when no
 * custom folder is configured.
 */
export async function getProjectsRoot(): Promise<string> {
  return invoke<string>('get_projects_root');
}

/**
 * Open a native folder picker for the projects folder. Returns the selected
 * absolute path, or `null` if the user cancelled. Does not persist — pass the
 * result to {@link setProjectsRoot}.
 */
export async function pickProjectsRoot(): Promise<string | null> {
  return invoke<string | null>('pick_projects_root');
}

/** Whether a custom (non-default) projects folder is currently configured. */
export async function isCustomProjectsRoot(): Promise<boolean> {
  try {
    return await invoke<boolean>('is_custom_projects_root');
  } catch {
    return false;
  }
}

/**
 * Set (or clear) the projects folder. Pass an empty string to reset to the
 * default `~/ShipStudio`. Throws (with a user-facing message) if the chosen path
 * isn't an existing, writable directory.
 */
export async function setProjectsRoot(path: string): Promise<void> {
  await invoke('set_projects_root', { path });
}

/** A project folder's eligibility for moving into a new projects folder. */
export interface MovableProjects {
  /** Projects that can be moved cleanly. */
  movable: string[];
  /** Projects whose name already exists in the destination. */
  collisions: string[];
  /** Projects currently open in a window or running a hot session. */
  open: string[];
}

/** One project skipped during a move, with a human-readable reason. */
export interface SkippedProject {
  name: string;
  reason: string;
}

/** Outcome of moving projects between folders. */
export interface MoveReport {
  moved: string[];
  skipped: SkippedProject[];
}

/** Preview which projects in `from` can be moved into `to`. */
export async function listMovableProjects(from: string, to: string): Promise<MovableProjects> {
  return invoke<MovableProjects>('list_movable_projects', { from, to });
}

/** Move project folders from one projects folder into another. */
export async function moveProjectsToRoot(from: string, to: string): Promise<MoveReport> {
  return invoke<MoveReport>('move_projects_to_root', { from, to });
}
