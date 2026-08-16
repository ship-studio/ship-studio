/**
 * Frontend wrapper for the built-in static file server and project type detection.
 *
 * Used for plain HTML/CSS/JS projects that don't have a framework dev server.
 *
 * @module lib/static-server
 */

import { invoke } from '@tauri-apps/api/core';

/** Detected project type from the Rust backend */
export type ProjectType =
  | 'nextjs'
  | 'sveltekit'
  | 'astro'
  | 'nuxt'
  | 'vite'
  | 'statichtml'
  | 'reactnative'
  | 'flutter'
  | 'shopifytheme'
  | 'generic'
  | 'unknown';

/** Native mobile project types (previewed via a device mirror, not a web iframe). */
export const MOBILE_PROJECT_TYPES: readonly ProjectType[] = ['reactnative', 'flutter'];

/** Whether a detected project type is a native mobile app. */
export function isMobileProjectType(type: ProjectType): boolean {
  return MOBILE_PROJECT_TYPES.includes(type);
}

/**
 * Whether a project gets the web (iframe) Preview pane.
 *
 * The rule (issue #691):
 * - Detected web frameworks (next/vite/astro/…, static HTML, Shopify themes)
 *   always have a preview.
 * - `generic` projects have a preview ONLY when a custom dev command is
 *   configured — an Nx/monorepo root (or any tooling-only package.json
 *   project) detects as `generic`, but once the user configures a dev command
 *   the dev server actually runs on the project's port, so the Preview tab
 *   must appear. Generic projects without a configured command (script
 *   collections, Rust CLIs, …) still hide the Preview.
 * - `unknown` and native mobile types never get the web preview (mobile uses
 *   the device mirror instead).
 */
export function hasWebPreview(type: ProjectType, customDevCommand: string | null): boolean {
  if (type === 'generic') {
    return customDevCommand !== null && customDevCommand.trim() !== '';
  }
  return type !== 'unknown' && !isMobileProjectType(type);
}

/** Detect the project type for a given project path */
export async function detectProjectType(projectPath: string): Promise<ProjectType> {
  return invoke<ProjectType>('detect_project_type_command', { projectPath });
}

/** Start the built-in static file server, returns the port it's listening on */
export async function startStaticServer(windowLabel: string, projectPath: string): Promise<number> {
  return invoke<number>('start_static_server', { windowLabel, projectPath });
}

/** Stop the static file server for a window */
export async function stopStaticServer(windowLabel: string): Promise<void> {
  return invoke<void>('stop_static_server', { windowLabel });
}
