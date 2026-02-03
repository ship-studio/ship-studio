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
import { readTextFile } from '@tauri-apps/plugin-fs';
import { logger } from './logger';

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
  /** Whether to run Claude in auto-accept mode */
  auto_accept_mode: boolean | null;
  /** Whether to hide the main branch warning banner */
  hide_main_branch_warning: boolean | null;
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
  /** Unique ID for this PTY (used for backend tracking) */
  ptyId: number;
  /** Stop the dev server and clean up */
  stop: () => Promise<void>;
}

/**
 * Check if a dev script contains shell syntax that can't be safely parsed.
 * Shell operators (&&, ||, |, ;) and environment assignments (VAR=value)
 * require running through npm instead of direct npx execution.
 *
 * @param script - The dev script to check
 * @returns true if the script contains shell syntax
 */
function hasShellSyntax(script: string): boolean {
  // Check for shell operators
  const shellOperators = ['&&', '||', '|', ';'];
  for (const op of shellOperators) {
    if (script.includes(op)) {
      return true;
    }
  }

  // Check for environment variable assignments (VAR=value pattern at start of command or after operators)
  // Matches patterns like "NODE_ENV=development" or "PORT=3000"
  const envAssignmentPattern = /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/;
  if (envAssignmentPattern.test(script)) {
    return true;
  }

  return false;
}

/**
 * Parse a dev script command and return args for npx to run it with correct port.
 * Handles scripts like "vite dev --port 3000" or "next dev -p 3000".
 * Uses npx to ensure local node_modules/.bin executables are found.
 *
 * Falls back to returning null for complex shell scripts (with &&, ||, |, ;, or env vars)
 * which should be run via npm instead.
 *
 * @param script - The npm script command (e.g., "vite dev --port 3000")
 * @param desiredPort - The port we want to use
 * @returns Args array for npx command, with port replaced, or null if shell syntax detected
 */
function parseDevScriptForNpx(script: string, desiredPort: number): string[] | null {
  // Check for shell syntax that can't be safely parsed
  if (hasShellSyntax(script)) {
    logger.info('[DevServer] Dev script contains shell syntax, falling back to npm run dev', {
      script,
    });
    return null;
  }

  // Parse the script into parts, handling quoted strings
  const parts = script.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];

  if (parts.length === 0) {
    return ['vite', 'dev', '--port', desiredPort.toString()];
  }

  const args: string[] = [];

  let i = 0;
  while (i < parts.length) {
    const arg = parts[i];

    // Check for port flags and skip them (we'll add our own)
    if (arg === '--port' || arg === '-p') {
      i += 2; // Skip flag and value
      continue;
    }

    // Check for --port=VALUE or -p=VALUE format
    if (arg.startsWith('--port=') || arg.startsWith('-p=')) {
      i++;
      continue;
    }

    args.push(arg);
    i++;
  }

  // Add our desired port
  args.push('--port', desiredPort.toString());

  return args;
}

/**
 * Start the development server for a project.
 * Intelligently handles different frameworks (Vite, Next.js, etc.)
 * by parsing the dev script and ensuring the correct port is used.
 *
 * @param projectPath - Absolute path to the project directory
 * @param port - Port number for the dev server (default: 3000)
 * @param windowLabel - Window label for backend PTY tracking (required for cleanup on window close)
 * @param onOutput - Optional callback for terminal output
 * @returns Handle with PTY and stop function
 */
export async function startDevServer(
  projectPath: string,
  port: number = 3000,
  windowLabel: string = 'main',
  onOutput?: (data: string) => void
): Promise<DevServerHandle> {
  const decoder = new TextDecoder();

  // Get extended PATH from backend (includes nvm, Homebrew, etc.)
  const home = await homeDir();
  const homeNormalized = home.endsWith('/') ? home : `${home}/`;
  const fullPath = await invoke<string>('get_shell_path');

  // Try to read package.json to get the dev script and parse it to use correct port
  // We use npx to run the command so that local node_modules/.bin executables are found
  let command = 'npm';
  let args: string[] = ['run', 'dev'];

  try {
    const packageJsonPath = `${projectPath}/package.json`;
    logger.info('[DevServer] Reading package.json', { path: packageJsonPath, desiredPort: port });
    const packageJson = await readTextFile(packageJsonPath);
    const pkg = JSON.parse(packageJson) as { scripts?: { dev?: string } };
    const devScript = pkg.scripts?.dev;

    if (devScript) {
      // Parse the dev script and replace any hardcoded port with our desired port
      // Use npx to run the command so local binaries are found
      // Returns null if the script contains shell syntax (&&, ||, |, ;, or env vars)
      const npxArgs = parseDevScriptForNpx(devScript, port);
      if (npxArgs) {
        command = 'npx';
        args = npxArgs;
        logger.info('[DevServer] Parsed dev script successfully', {
          original: devScript,
          command,
          args: args.join(' '),
          port,
        });
      } else {
        // Script has shell syntax - use npm run dev which respects the PORT env var
        logger.info('[DevServer] Using npm run dev for shell script', {
          original: devScript,
          port,
        });
      }
    } else {
      logger.warn('[DevServer] No dev script found in package.json, using npm run dev');
    }
  } catch (e) {
    // Fall back to npm run dev if we can't parse package.json
    const errorMessage = e instanceof Error ? e.message : String(e);
    logger.error('[DevServer] Failed to read/parse package.json, falling back to npm run dev', {
      error: errorMessage,
      projectPath,
    });
  }

  // Log the actual command being executed
  logger.info('[DevServer] Spawning dev server process', {
    command,
    args: args.join(' '),
    cwd: projectPath,
    port,
    fullCommand: `${command} ${args.join(' ')}`,
  });

  // Must pass all essential env vars since env replaces (not merges with) parent environment
  const pty = spawn(command, args, {
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
      PORT: port.toString(), // Fallback for frameworks that respect PORT env var
    },
  });

  // Generate a unique PTY ID and register with backend for cleanup on window close
  // Use modulo to keep within u32 range (Date.now() exceeds u32 max)
  const ptyId = Date.now() % 0xffffffff;

  logger.info('[DevServer] PTY spawned, waiting for PID', {
    windowLabel,
    ptyId,
    port,
  });

  // Track whether we've registered the PTY (to avoid double registration)
  let ptyRegistered = false;

  // Function to register the PTY once we have a PID
  const registerPty = (pid: number) => {
    if (ptyRegistered) return;
    ptyRegistered = true;

    invoke('register_external_pty', {
      windowLabel,
      pid,
      ptyId,
      description: `Dev server on port ${port}`,
    })
      .then(() => {
        logger.info('[DevServer] PTY registered with backend', { ptyId, pid, windowLabel });
      })
      .catch((e) => {
        logger.warn('[DevServer] Failed to register PTY with backend', { error: e });
      });
  };

  // Poll for PID availability (tauri-pty doesn't provide PID synchronously)
  // Check every 50ms for up to 2 seconds
  const maxRetries = 40;
  let retryCount = 0;
  const pidCheckInterval = setInterval(() => {
    const pid = pty.pid;
    if (pid) {
      clearInterval(pidCheckInterval);
      logger.info('[DevServer] PID became available via polling', { pid, ptyId, retryCount });
      registerPty(pid);
    } else {
      retryCount++;
      if (retryCount >= maxRetries) {
        clearInterval(pidCheckInterval);
        logger.error('[DevServer] Failed to get PID after polling timeout', {
          ptyId,
          windowLabel,
          retries: retryCount,
        });
      }
    }
  }, 50);

  // Unregister when PTY exits (if it exits normally before window close)
  pty.onExit(() => {
    clearInterval(pidCheckInterval);
    invoke('unregister_external_pty', { ptyId }).catch(() => {
      // Ignore - might already be cleaned up by window close
    });
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
    ptyId,
    stop: async () => {
      try {
        pty.kill();
        // Unregister from backend
        await invoke('unregister_external_pty', { ptyId }).catch(() => {});
      } catch {
        // Ignore errors
      }
    },
  };
}

/**
 * Get the auto-accept mode preference for a project.
 * When enabled, Claude will run with --dangerously-skip-permissions flag.
 * @param projectPath - Absolute path to the project directory
 * @returns Whether auto-accept mode is enabled
 */
export async function getAutoAcceptMode(projectPath: string): Promise<boolean> {
  return invoke<boolean>('get_auto_accept_mode', { projectPath });
}

/**
 * Set the auto-accept mode preference for a project.
 * @param projectPath - Absolute path to the project directory
 * @param enabled - Whether to enable auto-accept mode
 */
export async function setAutoAcceptMode(projectPath: string, enabled: boolean): Promise<void> {
  return invoke<void>('set_auto_accept_mode', { projectPath, enabled });
}

/**
 * Get whether the main branch warning banner should be hidden for this project.
 * @param projectPath - Absolute path to the project directory
 * @returns Whether the banner should be hidden
 */
export async function getHideMainBranchWarning(projectPath: string): Promise<boolean> {
  return invoke<boolean>('get_hide_main_branch_warning', { projectPath });
}

/**
 * Set whether the main branch warning banner should be hidden for this project.
 * @param projectPath - Absolute path to the project directory
 * @param hidden - Whether to hide the banner
 */
export async function setHideMainBranchWarning(
  projectPath: string,
  hidden: boolean
): Promise<void> {
  return invoke<void>('set_hide_main_branch_warning', { projectPath, hidden });
}
