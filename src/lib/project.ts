/**
 * Project management utilities for Tauri backend communication.
 *
 * Provides functions for:
 * - Listing and managing projects in ~/ShipStudio
 * - Checking system prerequisites (node, npm, git, claude)
 * - Starting/stopping the Next.js dev server
 *
 * @module lib/project
 */

import { invoke } from '@tauri-apps/api/core';
import { spawn, IPty } from 'tauri-pty';
import { homeDir } from '@tauri-apps/api/path';

/** Basic project information */
export interface Project {
  /** Project folder name */
  name: string;
  /** Absolute path to project directory */
  path: string;
  /** Path to thumbnail image (or null if none) */
  thumbnail: string | null;
}

/**
 * Extended project information for the dashboard view.
 * Includes git status, deployment info, and metadata.
 */
export interface DashboardProject {
  /** Project folder name */
  name: string;
  /** Absolute path to project directory */
  path: string;
  /** Path to thumbnail image (or null if none) */
  thumbnail: string | null;
  /** Unix timestamp of last time project was opened (or null) */
  last_opened: number | null;
  /** Current git branch name */
  git_branch: string | null;
  /** Number of uncommitted changes (staged + unstaged) */
  uncommitted_count: number | null;
  /** Production URL from Vercel */
  production_url: string | null;
  /** Relative time string for last deployment (e.g., "2h ago") */
  last_deployed: string | null;
  /** Deployment state: READY, BUILDING, ERROR, QUEUED, CANCELED */
  deployment_state: string | null;
}

/** System prerequisite check result */
export interface Prerequisite {
  /** Tool name (e.g., "node", "git", "claude") */
  name: string;
  /** Whether the tool is available in PATH */
  available: boolean;
  /** Path to the tool executable (or null if not found) */
  path: string | null;
}

/**
 * Check if required system tools are installed.
 * @returns Array of prerequisite check results
 */
export async function checkPrerequisites(): Promise<Prerequisite[]> {
  return invoke<Prerequisite[]>('check_prerequisites');
}

/**
 * Get all projects with dashboard metadata.
 * Scans ~/ShipStudio for project folders and enriches with git/deployment info.
 * @returns Array of dashboard projects sorted by last_opened
 */
export async function getDashboardProjects(): Promise<DashboardProject[]> {
  return invoke<DashboardProject[]>('get_dashboard_projects');
}

/** Handle for controlling a running dev server */
export interface DevServerHandle {
  /** The underlying PTY instance */
  pty: IPty;
  /** Stop the dev server and clean up */
  stop: () => Promise<void>;
}

/**
 * Start the Next.js development server for a project.
 * Spawns `npm run dev` in a PTY and returns a handle for control.
 *
 * @param projectPath - Absolute path to the project directory
 * @param port - Port number for the dev server (default: 3000)
 * @param onOutput - Optional callback for terminal output
 * @returns Handle with PTY and stop function
 */
export async function startDevServer(
  projectPath: string,
  port: number = 3000,
  onOutput?: (data: string) => void
): Promise<DevServerHandle> {
  const decoder = new TextDecoder();

  // Get extended PATH from backend (includes nvm, Homebrew, etc.)
  const home = await homeDir();
  const homeNormalized = home.endsWith('/') ? home : `${home}/`;
  const fullPath = await invoke<string>('get_shell_path');

  // Must pass all essential env vars since env replaces (not merges with) parent environment
  // PORT env var tells Next.js which port to use
  const pty = spawn('npm', ['run', 'dev'], {
    cwd: projectPath,
    cols: 80,
    rows: 24,
    env: {
      PATH: fullPath,
      HOME: homeNormalized.slice(0, -1),
      USER: homeNormalized.split('/').filter(Boolean).pop() || 'user',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      SHELL: '/bin/zsh',
      PORT: port.toString(),
    },
  });

  if (onOutput) {
    pty.onData((data) => {
      // tauri-pty passes data as Uint8Array or array-like object
      let text: string;
      if (typeof data === 'string') {
        text = data;
      } else {
        // Convert array-like object to Uint8Array for decoding
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        text = decoder.decode(bytes);
      }
      onOutput(text);
    });
  }

  return {
    pty,
    stop: () => {
      try {
        pty.kill();
      } catch {
        // Ignore errors
      }
      return Promise.resolve();
    },
  };
}
