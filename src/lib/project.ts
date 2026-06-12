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
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { logger } from './logger';
import { trackError } from './analytics';
import { isWindows } from './setup';

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
 * Includes git status and metadata.
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
  /** Whether to run Claude in auto-accept mode */
  auto_accept_mode: boolean | null;
  /** Whether to hide the main branch warning banner */
  hide_main_branch_warning: boolean | null;
  /** Whether this project is an external (non-~/ShipStudio) project */
  is_external: boolean;
  /** Active monorepo workspace subpath (e.g. `apps/admin`), or null. */
  workspace_subpath: string | null;
}

/**
 * Get all projects with dashboard metadata.
 * Scans ~/ShipStudio for project folders and enriches with git/deployment info.
 * @returns Array of dashboard projects sorted by last_opened
 */
export async function getDashboardProjects(): Promise<DashboardProject[]> {
  return invoke<DashboardProject[]>('get_dashboard_projects');
}

/**
 * List all projects in the ~/ShipStudio directory.
 * Returns basic project info (name and path) for each project.
 * @returns Array of project name/path objects
 */
export async function listProjects(): Promise<{ name: string; path: string }[]> {
  return invoke<{ name: string; path: string }[]>('list_projects');
}

/**
 * Ensure the ~/ShipStudio directory exists, creating it if necessary.
 * @returns Absolute path to the ShipStudio directory
 */
export async function ensureShipStudioDir(): Promise<string> {
  return invoke<string>('ensure_shipstudio_dir');
}

/**
 * Spawn a pseudo-terminal process via the backend.
 * Used for running commands like git clone and npm install with progress events.
 * @param options - PTY options including cwd, command, args, and terminal size
 * @param windowLabel - Window label for backend tracking
 * @returns Unique PTY ID for tracking the process
 */
export async function spawnPty(
  options: { cwd: string; command: string; args: string[]; rows: number; cols: number },
  windowLabel: string
): Promise<number> {
  return invoke<number>('spawn_pty', { options, windowLabel });
}

/**
 * Ensure .shipstudio is included in the project's .gitignore file.
 * Creates .gitignore if it doesn't exist.
 * @param projectPath - Absolute path to the project directory
 */
export async function ensureGitignoreHasShipstudio(projectPath: string): Promise<void> {
  return invoke<void>('ensure_gitignore_has_shipstudio', { projectPath });
}

/**
 * Get the base64-encoded thumbnail image for a project.
 * @param projectPath - Absolute path to the project directory
 * @returns Base64-encoded image data, or null if no thumbnail
 */
export async function getProjectThumbnail(projectPath: string): Promise<string | null> {
  return invoke<string | null>('get_project_thumbnail', { projectPath });
}

/**
 * Save a user-uploaded image as the project's thumbnail and lock auto-capture
 * (the backend's capture_project_thumbnail will skip subsequent invocations
 * for this project, so the upload isn't overwritten on next dev-server boot).
 *
 * @param projectPath - Absolute path to the project directory
 * @param fileData - Image bytes (PNG, JPEG, WebP, etc. — anything the `image` crate decodes)
 * @returns The new thumbnail as a base64 data URL, ready for direct use in <img src>
 */
export async function uploadProjectThumbnail(
  projectPath: string,
  fileData: number[]
): Promise<string> {
  return invoke<string>('upload_project_thumbnail', { projectPath, imageData: fileData });
}

/**
 * Delete a project from disk.
 * @param path - Absolute path to the project directory to delete
 */
export async function deleteProject(path: string): Promise<void> {
  return invoke<void>('delete_project', { path });
}

/**
 * Rename a project's folder on disk and rekey path-keyed stores (pins, folders,
 * sessions). Only works for ~/ShipStudio projects, and is rejected by the
 * backend if the project is currently open or has an active session.
 * @param oldPath - Current absolute path to the project directory
 * @param newName - New folder name (single path component, no slashes)
 * @returns The new absolute path
 */
export async function renameProject(oldPath: string, newName: string): Promise<string> {
  return invoke<string>('rename_project', { oldPath, newName });
}

/**
 * Export a project as a reusable template.
 * Opens a save dialog and exports the project structure.
 * @param projectPath - Absolute path to the project directory
 * @returns Path where the template was saved, or null if cancelled
 */
export async function exportProjectAsTemplate(projectPath: string): Promise<string | null> {
  return invoke<string | null>('export_project_as_template', { projectPath });
}

/**
 * Open a project in a new application window.
 * @param projectPath - Absolute path to the project directory
 * @param projectName - Display name of the project
 */
export async function openProjectInNewWindow(
  projectPath: string,
  projectName: string
): Promise<void> {
  return invoke<void>('open_project_in_new_window', { projectPath, projectName });
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
 * @param customCommand - Optional custom command string (bypasses package.json parsing)
 * @returns Handle with PTY and stop function
 */
export async function startDevServer(
  projectPath: string,
  port: number = 3000,
  windowLabel: string = 'main',
  onOutput?: (data: string) => void,
  customCommand?: string
): Promise<DevServerHandle> {
  const decoder = new TextDecoder();

  // Get extended PATH from backend (includes nvm, Homebrew, etc.)
  const home = await homeDir();
  const homeNormalized = home.endsWith('/') ? home : `${home}/`;
  const fullPath = await invoke<string>('get_shell_path');

  let command = 'npm';
  let args: string[] = ['run', 'dev', '--', '--port', port.toString()];

  if (customCommand) {
    // Custom command provided — split into command + args, bypass package.json parsing
    const parts = customCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    if (parts.length > 0) {
      command = parts[0]!;
      args = parts.slice(1);
      logger.info('[DevServer] Using custom dev command', {
        customCommand,
        command,
        args: args.join(' '),
      });
    }
  } else {
    // Try to read package.json to get the dev script and parse it to use correct port
    // We use npx to run the command so that local node_modules/.bin executables are found
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
      // Fall back to npm run dev with port forwarded via -- --port
      // This handles external projects where readTextFile is blocked by Tauri scope
      trackError('devserver_package_json', e, 'Workspace');
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error('[DevServer] Failed to read/parse package.json, falling back to npm run dev', {
        error: errorMessage,
        projectPath,
      });
    }
  }

  // Log the actual command being executed
  logger.info('[DevServer] Spawning dev server process', {
    command,
    args: args.join(' '),
    cwd: projectPath,
    port,
    fullCommand: `${command} ${args.join(' ')}`,
  });

  // Must pass all essential env vars since env replaces (not merges with) parent environment.
  // On Windows, many system env vars (SystemRoot, COMSPEC, PATHEXT, TEMP, etc.) are required
  // for Node.js and cmd.exe to function, so we fetch them from the backend.
  const systemEnv = await invoke<Record<string, string>>('get_system_env');
  const env: Record<string, string> = isWindows()
    ? {
        ...systemEnv,
        PATH: fullPath,
        PORT: port.toString(),
        NUXT_TELEMETRY_DISABLED: '1',
      }
    : {
        PATH: fullPath,
        HOME: homeNormalized.slice(0, -1),
        USER: homeNormalized.split('/').filter(Boolean).pop() || 'user',
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        SHELL: '/bin/zsh',
        PORT: port.toString(),
        NUXT_TELEMETRY_DISABLED: '1',
      };

  // npm/pnpm record where the user invoked them in INIT_CWD (and pnpm in
  // PNPM_SCRIPT_SRC_DIR), and the PTY merges our env over the app's own —
  // so when Ship Studio itself runs under `pnpm tauri dev`, those leak into
  // every child. Tools that trust them over process.cwd() then resolve paths
  // against the WRONG directory: the Shopify CLI reads INIT_CWD first, sees a
  // non-theme directory, and `theme dev` mirrors it by deleting every file on
  // the remote development theme. Pin both to the real working directory.
  env.INIT_CWD = projectPath;
  env.PNPM_SCRIPT_SRC_DIR = projectPath;

  // On Windows, commands like npm/npx are .cmd batch scripts that CreateProcessW
  // cannot execute directly (os error 193). Wrap through cmd.exe to resolve them.
  const spawnCmd = isWindows() ? 'cmd.exe' : command;
  const spawnArgs = isWindows() ? ['/C', command, ...args] : args;

  logger.info('[DevServer] Actual spawn params', {
    spawnCmd,
    spawnArgs: spawnArgs.join(' '),
    cwd: projectPath,
    envKeys: Object.keys(env).join(', '),
    isWindows: isWindows(),
  });

  // On Windows, tauri-plugin-pty's conpty doesn't reliably forward output.
  // Use the backend spawn_pty (Command::new with pipes) which works on Windows.
  // Pass original command/args since backend spawn_pty already wraps with cmd.exe /C.
  if (isWindows()) {
    return startDevServerWindows(command, args, projectPath, port, windowLabel, onOutput);
  }

  const pty = spawn(spawnCmd, spawnArgs, {
    cwd: projectPath,
    cols: 80,
    rows: 24,
    env,
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
      projectPath,
    })
      .then(() => {
        logger.info('[DevServer] PTY registered with backend', {
          ptyId,
          pid,
          windowLabel,
          projectPath,
        });
      })
      .catch((e) => {
        logger.warn('[DevServer] Failed to register PTY with backend', { error: e });
      });
  };

  // tauri-pty populates `pty.pid` only after its internal `_init` promise
  // resolves (that's where the backend returns the handler). Await that
  // directly instead of polling — polling would either busy-loop or, on
  // slow spawns, hit the retry cap and log a misleading "timeout" error
  // even though the PID showed up a tick later.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  const ptyInit = (pty as any)._init as Promise<unknown> | undefined;
  if (ptyInit) {
    ptyInit
      .then(() => {
        const pid = pty.pid;
        if (typeof pid === 'number') {
          logger.info('[DevServer] PID available via _init', { pid, ptyId });
          registerPty(pid);
        } else {
          logger.warn('[DevServer] _init resolved without a PID', { ptyId });
        }
      })
      .catch((e) => {
        logger.warn('[DevServer] _init rejected', { ptyId, error: String(e) });
      });
  }

  // Unregister when PTY exits (if it exits normally before window close)
  pty.onExit((e) => {
    logger.info('[DevServer] PTY exited', { ptyId, exitCode: e.exitCode, signal: e.signal });
    invoke('unregister_external_pty', { ptyId }).catch(() => {
      // Ignore - might already be cleaned up by window close
    });
  });

  // Store the disposable so we can remove the onData listener on stop.
  // Without this, killed PTY processes continue flooding JS with IPC messages,
  // causing 100% CPU even after the dev server is "stopped".
  let dataDisposable: { dispose(): void } | null = null;
  if (onOutput) {
    dataDisposable = pty.onData((data) => {
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
        // Dispose the onData listener FIRST to stop any remaining writes.
        dataDisposable?.dispose();
        // Kill via the plugin directly so we can await it and know the
        // session was removed from backend state. The backend's updated
        // `kill` handler removes the session from its map, which causes
        // the next `read` invoke to return "EOF" — tauri-pty's internal
        // for(;;) loop catches that and exits cleanly, no CPU spin.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        const pid = (pty as any).pid as number | undefined;
        if (typeof pid === 'number') {
          await invoke('plugin:pty|kill', { pid }).catch(() => {
            // Already dead — fine.
          });
        }
        // Unregister from backend
        await invoke('unregister_external_pty', { ptyId }).catch(() => {});
      } catch (e) {
        // Log but don't throw - the PTY might already be dead
        logger.warn('[DevServer] Error during PTY stop, may already be dead', { error: e, ptyId });
      }
    },
  };
}

/**
 * Windows-specific dev server start using backend spawn_pty.
 * tauri-plugin-pty's conpty doesn't reliably forward output on Windows,
 * so we use the backend's Command::new with piped stdout/stderr instead.
 */
async function startDevServerWindows(
  command: string,
  args: string[],
  projectPath: string,
  port: number,
  windowLabel: string,
  onOutput?: (data: string) => void
): Promise<DevServerHandle> {
  // Spawn via backend spawn_pty (uses Command::new with piped stdout/stderr)
  const ptyId = await invoke<number>('spawn_pty', {
    options: {
      cwd: projectPath,
      command,
      args,
      rows: 24,
      cols: 80,
    },
    windowLabel,
    projectPath,
  });

  logger.info('[DevServer] Windows backend PTY spawned', {
    ptyId,
    command,
    args: args.join(' '),
    port,
  });

  // Listen for output events from the backend
  let unlistenOutput: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;

  if (onOutput) {
    unlistenOutput = await listen<{ id: number; data: string }>('pty-output', (event) => {
      if (event.payload.id === ptyId) {
        onOutput(event.payload.data);
      }
    });
  }

  // Listen for exit
  unlistenExit = await listen<{ id: number; code: number | null }>('pty-exit', (event) => {
    if (event.payload.id === ptyId) {
      logger.info('[DevServer] Windows PTY exited', { ptyId, code: event.payload.code });
      unlistenOutput?.();
      unlistenExit?.();
    }
  });

  // Create a minimal IPty-compatible object for the DevServerHandle interface
  const fakePty = {
    kill: () => {
      void invoke('kill_pty', { id: ptyId });
    },
  } as IPty;

  return {
    pty: fakePty,
    ptyId,
    stop: async () => {
      try {
        await invoke('kill_pty', { id: ptyId });
        unlistenOutput?.();
        unlistenExit?.();
      } catch {
        // Ignore errors
      }
    },
  };
}

/**
 * Get the custom dev command for a project (for generic projects).
 * @param projectPath - Absolute path to the project directory
 * @returns The custom dev command, or null if not configured
 */
export async function getCustomDevCommand(projectPath: string): Promise<string | null> {
  return invoke<string | null>('get_custom_dev_command', { projectPath });
}

/**
 * Set the custom dev command for a project (for generic projects).
 * @param projectPath - Absolute path to the project directory
 * @param command - The command to set, or null to clear
 */
export async function setCustomDevCommand(
  projectPath: string,
  command: string | null
): Promise<void> {
  return invoke<void>('set_custom_dev_command', { projectPath, command });
}

/** A runnable app discovered inside a monorepo at import time. */
export interface WorkspaceInfo {
  /** Package name from the workspace's `package.json`. */
  name: string;
  /** POSIX-separated path relative to the repo root (e.g. `apps/admin`). */
  relativePath: string;
  /** Whichever of `dev`/`start` is present. */
  devScript: string | null;
  /** Port parsed from the dev script (`-p 3001`, `--port 3001`, etc.). */
  portHint: number | null;
  /** True for next/vite/astro/etc. — used to pre-select a default in the picker. */
  isWeb: boolean;
}

/** Detect monorepo workspaces in a freshly-cloned repo. Returns [] for single-package projects. */
export async function detectWorkspaces(projectPath: string): Promise<WorkspaceInfo[]> {
  const raw = await invoke<
    Array<{
      name: string;
      relative_path: string;
      dev_script: string | null;
      port_hint: number | null;
      is_web: boolean;
    }>
  >('detect_workspaces', { projectPath });
  return raw.map((w) => ({
    name: w.name,
    relativePath: w.relative_path,
    devScript: w.dev_script,
    portHint: w.port_hint,
    isWeb: w.is_web,
  }));
}

/** Get the active workspace subpath for a monorepo project (e.g. `apps/admin`), or null. */
export async function getWorkspaceSubpath(projectPath: string): Promise<string | null> {
  return invoke<string | null>('get_workspace_subpath', { projectPath });
}

/** Lock the active workspace subpath. Pass null to clear (treat as single-package). */
export async function setWorkspaceSubpath(
  projectPath: string,
  subpath: string | null
): Promise<void> {
  return invoke<void>('set_workspace_subpath', { projectPath, subpath });
}

/** Resolve the effective working directory for dev-server / preview / asset ops. */
export function resolveWorkspacePath(projectPath: string, subpath: string | null): string {
  if (!subpath) return projectPath;
  const trimmed = subpath.replace(/^\/+|\/+$/g, '');
  return trimmed ? `${projectPath}/${trimmed}` : projectPath;
}

/** Status of a project's npm/pnpm/yarn dependencies. */
export interface DependencyStatus {
  /** True when `node_modules` is present (or the project has no package.json). */
  installed: boolean;
  /** True when the project has a `package.json` at all. */
  hasPackageJson: boolean;
}

/** Check whether dependencies are installed for a project. */
export async function checkDependenciesInstalled(projectPath: string): Promise<DependencyStatus> {
  const raw = await invoke<{ installed: boolean; has_package_json: boolean }>(
    'check_dependencies_installed',
    { projectPath }
  );
  return { installed: raw.installed, hasPackageJson: raw.has_package_json };
}

/**
 * Persist the saved terminal-tab list for a project. Wraps the
 * `set_terminal_state` Tauri command. Components import this rather than
 * `invoke` directly per the project's no-restricted-imports policy.
 * @param projectPath - Absolute path to the project directory
 * @param state - Serialized tab list and active-tab index. `customTitle`
 *                is optional per tab and falls back to the PTY-emitted
 *                title at runtime when absent.
 */
export interface SavedTerminalTabPayload {
  agent_id: string;
  session_id: string;
  custom_title?: string;
}

export async function setTerminalState(
  projectPath: string,
  state: { tabs: SavedTerminalTabPayload[]; active_tab_index: number }
): Promise<void> {
  return invoke<void>('set_terminal_state', { projectPath, state });
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
