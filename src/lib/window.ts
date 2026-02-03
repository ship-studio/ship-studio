/**
 * Window management and compact mode utilities.
 *
 * Provides functions for:
 * - Entering/exiting compact mode
 * - Managing always-on-top state
 * - Saving/restoring window position
 * - Controlling window expansion state
 * - Multi-window port management
 *
 * Compact mode transforms Ship Studio into a minimal floating input bar
 * that can stay on top of other windows for easy access.
 *
 * @module lib/window
 */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Window position coordinates */
export interface WindowPosition {
  x: number;
  y: number;
}

/** Compact mode preferences persisted across sessions */
export interface CompactModePreferences {
  /** Last saved window position */
  position: WindowPosition | null;
  /** Whether compact mode window should stay on top */
  alwaysOnTop: boolean;
  /** Whether the output area is currently expanded */
  isExpanded: boolean;
}

/**
 * Enter compact mode - transforms window to minimal floating bar.
 * Removes window decorations, resizes to compact dimensions,
 * and restores saved position/always-on-top state.
 */
export async function enterCompactMode(): Promise<void> {
  return invoke('enter_compact_mode');
}

/**
 * Exit compact mode - restores window to full size.
 * Saves current position before exiting, restores decorations,
 * and centers the window on screen.
 */
export async function exitCompactMode(): Promise<void> {
  return invoke('exit_compact_mode');
}

/**
 * Toggle always-on-top state for the window.
 * When enabled, window stays above all other windows.
 * State is persisted across sessions.
 *
 * @param enabled - Whether to enable always-on-top
 */
export async function setAlwaysOnTop(enabled: boolean): Promise<void> {
  return invoke('set_always_on_top', { enabled });
}

/**
 * Save compact mode window position.
 * Position is automatically restored when entering compact mode.
 *
 * @param x - X coordinate
 * @param y - Y coordinate
 */
export async function saveCompactPosition(x: number, y: number): Promise<void> {
  return invoke('save_compact_position', { x, y });
}

/**
 * Get current compact mode preferences.
 * @returns Saved preferences including position, always-on-top, and expanded state
 */
export async function getCompactPreferences(): Promise<CompactModePreferences> {
  return invoke<CompactModePreferences>('get_compact_preferences');
}

/**
 * Set compact mode expanded state and optionally set height.
 * When expanded, window grows to show terminal output.
 * When collapsed, window shrinks to minimal input bar.
 *
 * @param expanded - Whether to expand the output area
 * @param height - Optional height in pixels (for resizable compact mode)
 */
export async function setCompactExpanded(expanded: boolean, height?: number): Promise<void> {
  return invoke('set_compact_expanded', { expanded, height });
}

/**
 * Get current window position.
 * Useful for tracking position during drag operations.
 *
 * @returns Current window position
 */
export async function getWindowPosition(): Promise<WindowPosition> {
  return invoke<WindowPosition>('get_window_position');
}

/**
 * Set window position.
 * Used for programmatic window positioning.
 *
 * @param x - X coordinate
 * @param y - Y coordinate
 */
export async function setWindowPosition(x: number, y: number): Promise<void> {
  return invoke('set_window_position', { x, y });
}

/**
 * Start native window drag.
 * Call this on mousedown to allow user to drag the window.
 * The window will follow the cursor until mouse is released.
 */
export async function startWindowDrag(): Promise<void> {
  return invoke('start_window_drag');
}

/**
 * Focus the window and bring it to front.
 * Useful after opening external apps (like a browser) that may steal focus.
 */
export async function focusWindow(): Promise<void> {
  return invoke('focus_window');
}

/**
 * Set the window title dynamically.
 * Useful for showing project name in the title bar.
 *
 * @param title - The new window title
 */
export async function setWindowTitle(title: string): Promise<void> {
  return invoke('set_window_title', { title });
}

/**
 * Get the current window's label.
 * Used for multi-window support to identify which window is making requests.
 *
 * @returns The window label (e.g., "main" or "project-12345")
 */
export function getWindowLabel(): string {
  return getCurrentWindow().label;
}

/**
 * Find and reserve an available port for this window's dev server.
 * This prevents race conditions when multiple windows try to start dev servers
 * at the same time.
 *
 * @param preferredPort - Preferred port to start searching from
 * @returns The reserved port number
 */
export async function findAndReservePort(preferredPort: number): Promise<number> {
  const windowLabel = getWindowLabel();
  return invoke<number>('find_and_reserve_port', {
    windowLabel,
    preferredPort,
  });
}

/**
 * Release the reserved port for this window.
 * Called when the window closes or dev server stops.
 */
export async function releaseReservedPort(): Promise<void> {
  const windowLabel = getWindowLabel();
  return invoke('release_reserved_port', { windowLabel });
}

/**
 * Check if a project is already open in another window.
 * Returns the window label if open, or null if not.
 *
 * @param projectPath - Path to the project
 * @returns Window label if project is open, null otherwise
 */
export async function getProjectWindow(projectPath: string): Promise<string | null> {
  return invoke<string | null>('get_project_window', { projectPath });
}

/**
 * Focus a window by its label.
 * Used to bring an existing project window to the front.
 *
 * @param windowLabel - Label of the window to focus
 */
export async function focusWindowByLabel(windowLabel: string): Promise<void> {
  return invoke('focus_window_by_label', { windowLabel });
}
