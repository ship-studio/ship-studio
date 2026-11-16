/**
 * Remembering where somebody put their panels.
 *
 * Two levels, and the relationship between them is the point:
 *
 * - **The default** is the layout every project starts from.
 * - **A project entry** is written only once you arrange *that* project.
 *
 * A project with no entry follows the default *live*. So changing your default
 * moves every project you have never personally arranged, and "Reset layout"
 * deletes a project's entry rather than writing the default into it — it goes
 * back to following rather than being frozen at today's copy of it.
 *
 * `localStorage`, not `.shipstudio/project.json`. That file is inside the
 * repository and holds what the *project* has (its hosting link); a pane width
 * is something a *person* has, and committing one would push your arrangement
 * onto everyone who clones the repo. It also puts this beside every other panel
 * preference the workspace already keeps — floating positions, floating sizes,
 * Team's per-project open flag.
 *
 * Every read is guarded and every write is best-effort: a private window, a
 * browser with site data blocked, or a full quota costs the preference and
 * never the workspace.
 *
 * @module lib/workspaceLayoutStore
 */

import {
  DEFAULT_LAYOUT,
  PANEL_IDS,
  clampPanelWidth,
  layoutFromLegacyPreferences,
  normalizeLayout,
  type PanelId,
  type WorkspaceLayout,
} from './workspaceLayout';
import { DEFAULT_FOCUS_SPLIT_RATIO } from './workspaceFocusSplit';

const DEFAULT_KEY = 'shipstudio.layout.default';
const PROJECT_PREFIX = 'shipstudio.layout.project:';
const FOCUS_SPLIT_PREFIX = 'shipstudio.focus.split:';
/** The one app-level preference controlling whether edits are shared. */
export const LAYOUT_SCOPE_KEY = 'shipstudio.layout.scope';
/** Set once the one-time read of the pre-rail per-panel flags has happened. */
const MIGRATED_KEY = 'shipstudio.layout.migratedFromPins';

export type LayoutScope = 'project' | 'global';

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The arrangement still applies for this session; it just doesn't survive.
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same bargain as `write`.
  }
}

/**
 * Read the selected persistence scope. Missing and invalid values intentionally
 * fall back to the pre-scope behaviour: an unarranged project follows the
 * shared default, while an arranged project keeps its own override.
 */
export function readLayoutScope(): LayoutScope {
  try {
    const value = localStorage.getItem(LAYOUT_SCOPE_KEY);
    if (value === 'global' || value === JSON.stringify('global')) return 'global';
    return 'project';
  } catch {
    return 'project';
  }
}

/** Persist the selected scope without allowing storage failures to escape. */
export function writeLayoutScope(scope: LayoutScope): void {
  try {
    localStorage.setItem(LAYOUT_SCOPE_KEY, scope);
  } catch {
    // The current session still uses the selected scope; it just won't survive.
  }
}

function projectKey(projectPath: string): string {
  return `${PROJECT_PREFIX}${projectPath}`;
}

function focusSplitKey(projectPath: string): string {
  return `${FOCUS_SPLIT_PREFIX}${projectPath}`;
}

// ============ Migration from the pre-rail preferences ============

function legacyFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function legacyWidth(key: string, panel: PanelId): number | undefined {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? clampPanelWidth(panel, value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The agent panel's width, from the split ratio it used to be.
 *
 * It was the left half of a two-pane split stored as a percentage of the row,
 * and the rail stores pixels. Converting needs a row width, and at the moment
 * this runs there is no rail to measure — so this is an estimate from the
 * window, clamped like any other width. It is a one-time read of a preference
 * whose whole job is to stop the first launch after an upgrade looking
 * rearranged; being a few pixels out is the correct amount of wrong.
 */
function legacyAgentWidth(): number | undefined {
  try {
    const percent = Number(localStorage.getItem('agentPanelDockedSplit'));
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) return undefined;
    const row = typeof window === 'undefined' ? 0 : window.innerWidth;
    if (row <= 0) return undefined;
    return clampPanelWidth('agent', (row * percent) / 100);
  } catch {
    return undefined;
  }
}

/**
 * Read the panel preferences that existed before the rail, once.
 *
 * Returns `null` after the first run (and for a fresh install, which has
 * nothing to read), so somebody who deliberately arranges their panels back to
 * something the old flags disagree with is not re-migrated on next launch.
 */
function migrateLegacyDefault(): WorkspaceLayout | null {
  if (read(MIGRATED_KEY) !== null) return null;
  write(MIGRATED_KEY, true);

  const widths: Partial<Record<PanelId, number>> = {};
  const agent = legacyAgentWidth();
  if (agent !== undefined) widths.agent = agent;
  const navigator = legacyWidth('elementTreeDockedWidth', 'navigator');
  if (navigator !== undefined) widths.navigator = navigator;
  const variables = legacyWidth('variablesPanelDockedWidth', 'variables');
  if (variables !== undefined) widths.variables = variables;
  const editor = legacyWidth('cssPanelDockedWidth', 'editor');
  if (editor !== undefined) widths.editor = editor;
  const team = legacyWidth('shipstudio.team.panelDockedWidth', 'team');
  if (team !== undefined) widths.team = team;

  return layoutFromLegacyPreferences({
    // Defaults match what each flag defaulted to before, so an install that
    // never touched a pin migrates to exactly the arrangement it was showing.
    agentPinned: legacyFlag('agentPanelPinned', true),
    navigatorPinned: legacyFlag('elementTreePinned', true),
    variablesPinned: legacyFlag('variablesPanelPinned', false),
    editorPinned: legacyFlag('visualEditorPinned', false),
    teamPinned: legacyFlag('teamPanelPinned', false),
    widths,
  });
}

// ============ Reading and writing ============

/** The layout projects start from. */
export function readDefaultLayout(): WorkspaceLayout {
  const saved = read(DEFAULT_KEY);
  if (saved !== null) {
    const normalized = normalizeLayout(saved);
    // Persist the canonical v2 shape when an older flat layout is encountered
    // so the migration is one-time rather than repeated on every launch.
    write(DEFAULT_KEY, normalized);
    return normalized;
  }

  const migrated = migrateLegacyDefault();
  if (migrated) {
    write(DEFAULT_KEY, migrated);
    return migrated;
  }
  return normalizeLayout(DEFAULT_LAYOUT);
}

export function writeDefaultLayout(layout: WorkspaceLayout): void {
  write(DEFAULT_KEY, normalizeLayout(layout));
}

export function hasProjectLayout(projectPath: string): boolean {
  return read(projectKey(projectPath)) !== null;
}

/** This project's arrangement, or the default it is still following. */
export function readProjectLayout(projectPath: string): WorkspaceLayout {
  const saved = read(projectKey(projectPath));
  if (saved === null) return readDefaultLayout();
  const normalized = normalizeLayout(saved);
  // Project layouts written by pre-v2 builds are migrated on first read and
  // then remain canonical in storage.
  write(projectKey(projectPath), normalized);
  return normalized;
}

export function writeProjectLayout(projectPath: string, layout: WorkspaceLayout): void {
  write(projectKey(projectPath), normalizeLayout(layout));
}

/** The topbar Focus split ratio for this project, or an even split by default. */
export function readProjectFocusSplitRatio(projectPath: string): number {
  const ratio = read(focusSplitKey(projectPath));
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
    ? ratio
    : DEFAULT_FOCUS_SPLIT_RATIO;
}

/** Save an explicit Focus resize without coupling it to the workspace layout. */
export function writeProjectFocusSplitRatio(projectPath: string, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return;
  write(focusSplitKey(projectPath), ratio);
}

/**
 * Stop this project having its own arrangement.
 *
 * Deletes rather than overwriting with the default, so the project resumes
 * *following* the default instead of being pinned to whatever it happens to be
 * right now.
 */
export function clearProjectLayout(projectPath: string): void {
  remove(projectKey(projectPath));
}

/** Every panel id, for callers that iterate the rail without importing the model. */
export { PANEL_IDS };
