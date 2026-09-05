/**
 * UI Settings
 *
 * Persisted user preferences for dashboard and workspace UI elements.
 *
 * @module lib/settings
 */

import { invoke } from '@tauri-apps/api/core';

/** Event fired after a dashboard visibility preference is persisted. */
export const DASHBOARD_VISIBILITY_CHANGED_EVENT = 'shipstudio:dashboard-visibility-changed';
/** Event fired after the workspace toolbar layout preference is persisted. */
export const COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT =
  'shipstudio:compact-workspace-toolbar-changed';
/** Event fired after the Spotify widget opt-in preference is persisted. The
 *  sidebar (which renders the widget) isn't a child of the Settings modal
 *  (which owns the toggle), so this is how the toggle reaches it live. */
export const SPOTIFY_WIDGET_ENABLED_CHANGED_EVENT = 'shipstudio:spotify-widget-enabled-changed';

/** The app icons available for the macOS Dock. */
export const APP_ICON_OPTIONS = [
  {
    id: 'brand',
    label: 'Brand',
    src: '/ShipStudio_IconBrand.png',
  },
  {
    id: 'dark',
    label: 'Dark',
    src: '/ShipStudio_IconDark.png',
  },
  {
    id: 'light',
    label: 'Light',
    src: '/ShipStudio_IconLight.png',
  },
] as const;

export type AppIcon = (typeof APP_ICON_OPTIONS)[number]['id'];

function isAppIcon(value: string): value is AppIcon {
  return APP_ICON_OPTIONS.some((option) => option.id === value);
}

/** Dashboard visibility preference changed by a settings control or inline action. */
export interface DashboardVisibilityChangedDetail {
  key: 'calendar' | 'slackCta' | 'dashboardHeader';
  hidden: boolean;
}

function notifyDashboardVisibilityChanged(detail: DashboardVisibilityChangedDetail): void {
  window.dispatchEvent(
    new CustomEvent<DashboardVisibilityChangedDetail>(DASHBOARD_VISIBILITY_CHANGED_EVENT, {
      detail,
    })
  );
}

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
    notifyDashboardVisibilityChanged({ key: 'calendar', hidden });
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
    notifyDashboardVisibilityChanged({ key: 'slackCta', hidden });
  } catch {
    // Silently fail
  }
}

/** Check if the dashboard home header is hidden. */
export async function getDashboardHeaderHidden(): Promise<boolean> {
  try {
    return await invoke<boolean>('get_dashboard_header_hidden');
  } catch {
    return false;
  }
}

/** Set whether the dashboard home header is hidden (persisted across sessions). */
export async function setDashboardHeaderHidden(hidden: boolean): Promise<void> {
  try {
    await invoke('set_dashboard_header_hidden', { hidden });
    notifyDashboardVisibilityChanged({ key: 'dashboardHeader', hidden });
  } catch {
    // Silently fail
  }
}

/** Get the persisted Dock icon choice. */
export async function getAppIcon(): Promise<AppIcon> {
  try {
    const icon = await invoke<string>('get_app_icon');
    return isAppIcon(icon) ? icon : 'brand';
  } catch {
    return 'brand';
  }
}

/** Persist the Dock icon choice and update the native app icon immediately. */
export async function setAppIcon(icon: AppIcon): Promise<void> {
  await invoke('set_app_icon', { icon });
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

// ============ Workspace toolbar layout ============

/** Whether workspace controls are consolidated into the window titlebar. */
export async function getCompactWorkspaceToolbarEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>('get_compact_workspace_toolbar_enabled');
  } catch {
    return false;
  }
}

/** Persist the workspace toolbar layout and notify the active window immediately. */
export async function setCompactWorkspaceToolbarEnabled(enabled: boolean): Promise<void> {
  try {
    await invoke('set_compact_workspace_toolbar_enabled', { enabled });
    window.dispatchEvent(
      new CustomEvent<boolean>(COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT, { detail: enabled })
    );
  } catch {
    // Silently fail, matching the other non-critical UI preferences.
  }
}

// ============ Spotify widget (macOS-only, opt-in) ============

/** Whether the Spotify "now playing" sidebar widget is enabled. Defaults to false — opt-in. */
export async function getSpotifyWidgetEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>('get_spotify_widget_enabled');
  } catch {
    return false;
  }
}

/** Persist the Spotify widget opt-in and notify the active window immediately. */
export async function setSpotifyWidgetEnabled(enabled: boolean): Promise<void> {
  try {
    await invoke('set_spotify_widget_enabled', { enabled });
    window.dispatchEvent(
      new CustomEvent<boolean>(SPOTIFY_WIDGET_ENABLED_CHANGED_EVENT, { detail: enabled })
    );
  } catch {
    // Silently fail, matching the other non-critical UI preferences.
  }
}

// ============ Project thumbnails (auto-capture consent) ============

/**
 * Consent state for automatic project-thumbnail capture.
 * `null` = the user has never been asked (the in-app explainer is shown before
 * the first auto-capture), `true` = allowed, `false` = opted out or a capture
 * failed because macOS Screen Recording permission was denied.
 */
export type ThumbnailConsent = boolean | null;

/**
 * Get the project-thumbnail auto-capture consent. Falls back to `null`
 * (undecided) on error so auto-capture stays deferred rather than triggering
 * the macOS screen-recording prompt without context.
 */
export async function getThumbnailsEnabled(): Promise<ThumbnailConsent> {
  try {
    return await invoke<boolean | null>('get_thumbnails_enabled');
  } catch {
    return null;
  }
}

/** Set the project-thumbnail auto-capture consent (persisted across sessions). */
export async function setThumbnailsEnabled(enabled: boolean): Promise<void> {
  try {
    await invoke('set_thumbnails_enabled', { enabled });
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
