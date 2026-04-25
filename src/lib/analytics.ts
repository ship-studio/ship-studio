/**
 * Analytics Service
 *
 * Thin wrapper around the Rust PostHog backend.
 * All events are sent through the Tauri IPC bridge to the Rust backend,
 * which forwards them to PostHog. The API key never touches the frontend.
 *
 * Every event flows through `enrichProperties` which auto-attaches:
 * - `$session_id` — current app session (PostHog standard)
 * - `$screen_name` — current screen, if a callsite hasn't set one explicitly
 * - `project_id` / `project_name` / `project_type` / `project_age_days` — when in a project
 * - `project_session_id` — current project session, when one is active
 *
 * Call `setActiveScreen()` and `setActiveProject()` from view-switching code
 * so every event picks up correct context without per-call boilerplate.
 *
 * @module lib/analytics
 */

import { invoke } from '@tauri-apps/api/core';
import { getAppSessionId, getProjectSessionId } from './session';

// ============ Active Context ============

interface ProjectContext {
  /** 12-char hashed path (privacy-safe, stable across launches) */
  id: string;
  /** Human-readable folder name */
  name: string;
  /** Detected framework: next, vite, astro, etc. */
  type?: string;
  /** Days since the project folder was created */
  ageDays?: number;
}

let activeScreen: string | null = null;
let activeProject: ProjectContext | null = null;

/**
 * Set the current screen. Future events that don't pass `$screen_name`
 * explicitly will be tagged with this value. Pass null to clear.
 */
export function setActiveScreen(screen: string | null): void {
  activeScreen = screen;
}

/**
 * Set the current project context. Pass null when leaving a project (e.g.
 * back to dashboard). Future events will auto-include project_id, name,
 * type, and age.
 */
export function setActiveProject(ctx: ProjectContext | null): void {
  activeProject = ctx;
}

/**
 * Build the property bag we ship to PostHog. Pulls in standard context
 * (screen, app session, project) without overwriting anything the caller
 * passed explicitly.
 */
function enrichProperties(properties?: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(properties ?? {}) };

  if (!('$screen_name' in out) && activeScreen) {
    out.$screen_name = activeScreen;
  }

  if (!('$session_id' in out)) {
    out.$session_id = getAppSessionId();
  }

  const projSession = getProjectSessionId();
  if (projSession && !('project_session_id' in out)) {
    out.project_session_id = projSession;
  }

  if (activeProject) {
    if (!('project_id' in out)) out.project_id = activeProject.id;
    if (!('project_name' in out)) out.project_name = activeProject.name;
    if (activeProject.type && !('project_type' in out)) {
      out.project_type = activeProject.type;
    }
    if (typeof activeProject.ageDays === 'number' && !('project_age_days' in out)) {
      out.project_age_days = activeProject.ageDays;
    }
  }

  return out;
}

// ============ Core Tracking ============

/**
 * Track an analytics event. Fire-and-forget — never throws.
 *
 * @param eventName - The event name (e.g., "project_created")
 * @param properties - Optional key-value properties to attach
 */
export async function trackEvent(
  eventName: string,
  properties?: Record<string, unknown>
): Promise<void> {
  try {
    await invoke('track_event', {
      eventName,
      properties: enrichProperties(properties),
      distinctId: null,
    });
  } catch {
    // Never let analytics break the app
  }
}

/**
 * Track a screen view. Sets the active screen and sends a `$pageview` event
 * with a synthetic `app://ship-studio/<slug>` URL so PostHog's URL-keyed
 * dashboards (Paths, Web Analytics) work. Call on every top-level view
 * change (dashboard, workspace tabs, onboarding steps).
 */
export function trackPageview(screen: string): void {
  setActiveScreen(screen);
  // Collapse non-alphanumerics (spaces, dashes, etc.) into a single hyphen so
  // "Workspace - Preview" becomes "workspace-preview", not "workspace---preview".
  const slug = screen
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  void trackEvent('$pageview', {
    $screen_name: screen,
    $current_url: `app://ship-studio/${slug}`,
    $pathname: `/${slug}`,
  });
}

/**
 * Identify a user by linking their device to a known user ID.
 * Call this when the user authenticates (e.g., GitHub login).
 *
 * @param userId - Unique user identifier (e.g., GitHub username)
 * @param properties - Person properties merged via PostHog `$set` (always overwrite)
 * @param setOnce - Person properties merged via `$set_once` (preserved on later identifies)
 */
export async function identifyUser(
  userId: string,
  properties?: Record<string, unknown>,
  setOnce?: Record<string, unknown>
): Promise<void> {
  try {
    await invoke('identify_user', {
      userId,
      properties: properties ?? null,
      setOnce: setOnce ?? null,
    });
  } catch {
    // Never let analytics break the app
  }
}

/**
 * Check if analytics are currently enabled.
 */
export async function getAnalyticsEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>('get_analytics_enabled');
  } catch {
    return true; // Default to enabled
  }
}

/**
 * Set whether analytics are enabled (persisted across sessions).
 */
export async function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  try {
    await invoke('set_analytics_enabled', { enabled });
  } catch {
    // Silently fail
  }
}

// ============ Error Tracking ============

/**
 * Track an error event. Fire-and-forget — never throws.
 * Call this in catch blocks to understand what's failing for users.
 *
 * @param action - What the user was trying to do (e.g., "git_push", "plugin_install")
 * @param error - The caught error (string, Error, or unknown)
 * @param screenName - Screen where the error occurred (overrides active screen)
 */
export function trackError(action: string, error: unknown, screenName?: string): void {
  let message = 'Unknown error';
  let errorType = 'unknown';

  if (error instanceof Error) {
    message = error.message;
    errorType = error.name || 'Error';
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      message += ` (${cause.message})`;
    } else if (typeof cause === 'string') {
      message += ` (${cause})`;
    }
  } else if (typeof error === 'string') {
    message = error;
    errorType = 'string';
  } else if (error && typeof error === 'object') {
    message = JSON.stringify(error);
    errorType = 'object';
  }

  const props: Record<string, unknown> = {
    action,
    error_message: message.slice(0, 500), // Cap length for PostHog
    error_type: errorType,
  };
  if (screenName) props.$screen_name = screenName;

  void trackEvent('error_occurred', props);
}

// ============ Debounced Search Tracking ============

const searchTimers: Record<string, ReturnType<typeof setTimeout>> = {};

/** Cap on every query that lands in PostHog, regardless of search type. */
const SEARCH_QUERY_CAP = 100;

/**
 * Track a search query with 1-second debounce.
 * Call this on every keystroke — it only fires after the user stops typing.
 * Empty queries are ignored. The query is capped at SEARCH_QUERY_CAP chars
 * so a paste of an arbitrary string into a search box can't dump unbounded
 * user content to analytics.
 *
 * @param searchType - Category of search (e.g., "project_search", "skills_search")
 * @param query - The raw search string
 * @param screenName - Screen name override (defaults to active screen)
 */
export function trackSearch(searchType: string, query: string, screenName?: string): void {
  if (searchTimers[searchType]) clearTimeout(searchTimers[searchType]);

  const trimmed = query.trim();
  if (!trimmed) return;

  searchTimers[searchType] = setTimeout(() => {
    const props: Record<string, unknown> = {
      search_type: searchType,
      query: trimmed.slice(0, SEARCH_QUERY_CAP),
      query_length: trimmed.length,
    };
    if (screenName) props.$screen_name = screenName;
    void trackEvent('search_performed', props);
  }, 1000);
}

/**
 * Cancel any pending debounced search for the given type. Call when the
 * surface that owns the search closes — otherwise a search event can fire
 * after its parent (e.g. a closed palette) is gone, polluting analytics.
 */
export function cancelTrackedSearch(searchType: string): void {
  if (searchTimers[searchType]) {
    clearTimeout(searchTimers[searchType]);
    delete searchTimers[searchType];
  }
}
