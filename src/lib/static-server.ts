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
  | 'generic'
  | 'unknown';

/** Native mobile project types (previewed via a device mirror, not a web iframe). */
export const MOBILE_PROJECT_TYPES: readonly ProjectType[] = ['reactnative', 'flutter'];

/** Whether a detected project type is a native mobile app. */
export function isMobileProjectType(type: ProjectType): boolean {
  return MOBILE_PROJECT_TYPES.includes(type);
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
