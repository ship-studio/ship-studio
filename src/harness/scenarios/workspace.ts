/**
 * The commands a project workspace asks for on open.
 *
 * Split out from `baseCommands` because the dashboard never needs them, and
 * keeping them separate makes it obvious which fixtures exist to open a
 * project versus to render the home screen.
 *
 * Every shape is taken from the `invoke<...>` type at the call site, including
 * the snake_case/camelCase split — the backend is inconsistent about it and a
 * fixture that "tidies" the casing would test a response the app never gets.
 */

import type { CommandMap } from '../types';
import { HARNESS_ROOT } from './base';

export const WORKSPACE_PROJECT = `${HARNESS_ROOT}/acme-marketing`;

export const workspaceCommands: CommandMap = {
  // ---- project identity & registration ----------------------------------
  get_workspace_subpath: null,
  get_project_account_id: 'default',
  get_project_window: null,
  register_project_for_window: null,
  register_project_session: null,
  ensure_external_project_registered: null,
  ensure_gitignore_has_shipstudio: null,
  mark_project_opened: null,
  set_window_title: null,
  get_auto_accept_mode: false,

  // ---- dev server --------------------------------------------------------
  // Null rather than a port: the harness has no dev server, and inventing a
  // running one would put the preview into a state the machine can't back up.
  get_dev_server_port: null,
  find_and_reserve_port: 3000,
  kill_port: null,
  get_force_static_serve: false,
  detect_project_type_command: 'nextjs',
  check_dependencies_installed: {
    installed: true,
    has_package_json: true,
    workspace_has_package_json: false,
  },

  // ---- git / github ------------------------------------------------------
  get_project_github_status: {
    status: 'connected',
    github_repo: 'harness-user/acme-marketing',
    github_url: 'https://github.com/harness-user/acme-marketing',
  },
  list_pull_requests: [],
  list_worktrees: [],
  detect_workspaces: [],
  /**
   * Matches `uncommitted_count: 3` on the dashboard fixture — a workspace that
   * claimed three changes and then listed none would be exactly the kind of
   * quiet inconsistency this harness exists to make visible.
   */
  get_changed_files: [
    { path: 'src/app/pricing/page.tsx', status: 'modified' },
    { path: 'src/components/PricingTable.tsx', status: 'added' },
    { path: 'README.md', status: 'modified' },
  ],

  // ---- snapshots ---------------------------------------------------------
  snapshot_status: {
    watching: true,
    can_undo: false,
    can_redo: false,
    is_git_repo: true,
    history_size: 0,
    cursor: 0,
    files_changed: [],
  },
  snapshot_start_watching: null,

  // ---- code / files ------------------------------------------------------
  list_project_files: [
    { name: 'package.json', path: 'package.json', is_directory: false, size: 812 },
    { name: 'src', path: 'src', is_directory: true, size: 0 },
    { name: 'README.md', path: 'README.md', is_directory: false, size: 1240 },
  ],
  read_project_file: {
    content: '# acme-marketing\n\nHarness fixture file.\n',
    is_binary: false,
    is_truncated: false,
    size: 41,
    language: 'markdown',
  },

  // ---- terminal ----------------------------------------------------------
  // An explicitly empty tab list, not null: null makes the workspace seed a
  // default tab and try to spawn a real agent PTY, which cannot exist here and
  // fills the pane with retry noise that would show up in every screenshot.
  get_terminal_state: { tabs: [], active_tab_index: 0 },
  get_shell_path: '/bin/zsh',
  get_system_env: {},

  // ---- preview -----------------------------------------------------------
  check_browser_availability: [
    { id: 'chrome', name: 'Google Chrome' },
    { id: 'safari', name: 'Safari' },
  ],
  is_tailwind_active: false,
  get_hide_main_branch_warning: false,
  get_terminal_gpu_enabled: true,

  // ---- agent bridge ------------------------------------------------------
  // Inert: the bridge registers a loopback MCP server against a real agent CLI,
  // which the harness has no business doing.
  get_agent_bridge_url: '',
  get_agent_bridge_active_url: '',
  agent_bridge_attach: null,

  // ---- terminal plumbing --------------------------------------------------
  // The harness has no PTY. These answer the shape the caller expects so the
  // terminal renders its chrome, and stop there — no session is really open.
  resolve_cli_path: { path: '/opt/homebrew/bin/claude', dir: '/opt/homebrew/bin' },
  attached_library_dirs: [],
  pty_session_open: { sessionId: 'harness-session', pid: 0 },
  pty_session_attach: null,
  pty_session_resize: null,
  pty_session_write: null,
  pty_session_close: null,

  // ---- MCP registration ---------------------------------------------------
  // Inert on purpose: registering an MCP server writes to the user's real
  // agent config, which a screenshot run must never do.
  register_cursor_mcp: false,
  add_mcp_server: null,
  remove_mcp_server: null,

  // ---- plugins -----------------------------------------------------------
  list_plugins: [],
};
