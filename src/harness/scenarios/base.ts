/**
 * The default backend every scenario starts from: a healthy, fully set-up
 * machine with a couple of projects. Scenarios override only the commands
 * they are actually about, so a hosting scenario doesn't have to restate
 * what onboarding returns.
 *
 * Every shape here is copied from the real type declarations in `src/lib`
 * (and, for hosting, from `src-tauri/src/commands/hosting/model.rs`), not
 * invented — a fixture that drifts from the real response teaches the agent
 * the wrong thing.
 */

import type { CommandMap } from '../types';

export const HARNESS_ROOT = '/Users/harness/ShipStudio';

/**
 * `DashboardProject` (see `src/lib/project.ts`) — every field the real command
 * returns, so the dashboard renders its full card rather than a card with
 * silently-missing metadata.
 */
export const dashboardProject = (name: string, over: Partial<Record<string, unknown>> = {}) => ({
  name,
  path: `${HARNESS_ROOT}/${name}`,
  thumbnail: null,
  last_opened: Date.now() - 3_600_000,
  git_branch: 'main',
  uncommitted_count: 0,
  auto_accept_mode: false,
  hide_main_branch_warning: false,
  is_external: false,
  workspace_subpath: null,
  worktree_count: 0,
  ...over,
});

export const projects = [
  dashboardProject('acme-marketing', { uncommitted_count: 3, git_branch: 'feat/pricing-page' }),
  dashboardProject('portfolio-site', { last_opened: Date.now() - 86_400_000 }),
  dashboardProject('docs-astro', { worktree_count: 2 }),
];

const setupItem = (id: string, friendlyName: string, version?: string, username?: string) => ({
  id,
  friendlyName,
  status: 'ready' as const,
  ...(version ? { version } : {}),
  ...(username ? { username } : {}),
});

export const readySetupItems = [
  setupItem('homebrew', 'Homebrew', '4.3.0'),
  setupItem('node', 'Node.js', 'v22.11.0'),
  setupItem('git', 'Git', '2.50.1'),
  setupItem('gh', 'GitHub CLI', '2.95.0'),
  setupItem('gh_auth', 'GitHub Account', undefined, 'harness-user'),
  setupItem('claude', 'Claude Code', '2.1.0'),
  setupItem('claude_auth', 'Claude Account', undefined, 'harness-user'),
  setupItem('vercel', 'Vercel CLI', '54.21.1'),
  setupItem('vercel_auth', 'Vercel Account', undefined, 'harness-user'),
];

/** A well-formed "this commit deploys nowhere" answer — the honest default. */
export const unlinkedHostingStatus = {
  commit: {
    sha: '9f3c1ab7d2e40518c6b9a7f0d4e2c8b1a5f60937',
    short_sha: '9f3c1ab',
    subject: 'Tighten the empty-state copy',
    branch: 'main',
    has_upstream: true,
  },
  providers: [],
  detected: [],
};

export const baseCommands: CommandMap = {
  // ---- boot gates -------------------------------------------------------
  quick_setup_check: { allPresent: true, setupCompleteCached: true },
  get_full_setup_status: {
    allReady: true,
    items: readySetupItems,
    optionalAuths: { githubAuthenticated: true },
    detectedAgents: ['claude'],
  },
  get_onboarding_test_mode: { mock: false, forceOnboarding: false },
  get_default_agent_id: 'claude',
  get_reserved_port_for_window: null,
  get_shipstudio_dir: HARNESS_ROOT,
  get_log_path: '/Users/harness/Library/Logs/ShipStudio',
  log_frontend_event: null,

  // ---- dashboard --------------------------------------------------------
  get_dashboard_projects: projects,
  list_projects: projects,
  get_projects: projects,
  list_external_projects: [],
  list_folders: [],
  list_pinned_projects: [],
  get_pinned_projects: [],
  get_settings: {},
  get_compact_workspace_toolbar_enabled: false,
  check_ide_availability: { vscode: true, cursor: false },

  // ---- workspaces (accounts) --------------------------------------------
  list_accounts: [
    {
      id: 'default',
      name: 'Default',
      color: '#6b7280',
      isDefault: true,
      createdAt: 1_750_000_000_000,
      projectsRoot: null,
    },
  ],
  get_active_account_id: 'default',

  // ---- CLI status --------------------------------------------------------
  check_github_cli_status: { installed: true, authenticated: true },
  check_claude_cli_status: { installed: true, version: '2.1.0' },
  check_codex_cli_status: { installed: false, version: null },
  check_opencode_cli_status: { installed: false, version: null },

  // ---- workflows & inbox --------------------------------------------------
  list_all_workflows: [],
  list_inbox_items: [],

  // ---- surfaces reachable from anywhere -----------------------------------
  // These live in the base layer, not the workspace layer: Help, Skills, MCP
  // and friends open from the dashboard as well as from inside a project, and
  // a fixture that only exists in one context white-screens the other.
  get_shell_path: '/bin/zsh',
  resolve_cli_path: { path: '/opt/homebrew/bin/gh', dir: '/opt/homebrew/bin' },
  // ---- feature surfaces ---------------------------------------------------
  // Empty collections are a real backend answer ("nothing configured yet"),
  // not invented data — the distinction the harness cares about is between
  // "a state we chose" and "a value we made up". A scenario that needs these
  // populated overrides them explicitly.
  get_backups: [],
  get_css_variables: [],
  get_conflict_info: [],
  list_attached_libraries: [],
  list_claude_skills: [],
  list_env_files: [],
  list_mcp_servers: [],
  get_shopify_store: null,
  get_default_base_branch: 'main',
  get_branch_prefix_preference: false,
  get_i18n_status: {
    framework: 'nextjs-app',
    supported: true,
    unsupported_reason: null,
    configured: false,
    locales: [],
    default_locale: null,
    config_file: null,
    parse_warning: null,
    agent_setup_available: true,
  },

  // ---- side-effecting commands -------------------------------------------
  // Answered inertly so a capture run can invoke them safely. Nothing here
  // touches the machine — the whole IPC layer is fake — but they are grouped
  // separately so it stays obvious which commands would do something real.
  open_in_ide: null,
  open_in_finder: null,
  pull_and_merge: null,
  clear_project_cache: null,
  unregister_external_pty: null,
  pty_session_detach: null,
  mark_all_inbox_read: null,
  register_external_project: null,
  set_compact_workspace_toolbar_enabled: null,
  fetch_community_templates: '[]',

  // ---- agents -------------------------------------------------------------
  get_agents_status: [
    {
      id: 'claude',
      displayName: 'Claude Code',
      binaryName: 'claude',
      installed: true,
      version: '2.1.0',
      authed: true,
      authEmail: 'harness@example.com',
      needsReconnect: false,
      isDefault: true,
      installSupported: true,
      uninstallSupported: true,
    },
    {
      id: 'codex',
      displayName: 'Codex',
      binaryName: 'codex',
      installed: false,
      version: null,
      authed: false,
      authEmail: null,
      needsReconnect: false,
      isDefault: false,
      installSupported: true,
      uninstallSupported: true,
    },
    {
      id: 'opencode',
      displayName: 'Opencode',
      binaryName: 'opencode',
      installed: false,
      version: null,
      authed: false,
      authEmail: null,
      needsReconnect: false,
      isDefault: false,
      installSupported: true,
      uninstallSupported: true,
    },
  ],

  // ---- dashboard chrome toggles -------------------------------------------
  get_dashboard_header_hidden: false,
  // Hidden by default: the contributions calendar fetches GitHub directly, so
  // with the network blocked it races between skeleton and failed-fetch and
  // two runs disagree. The `dashboard-calendar` scenario turns it back on for
  // anyone reviewing that component specifically.
  get_calendar_hidden: true,
  get_slack_cta_hidden: false,
  get_spotify_widget_enabled: false,
  get_filed_project_paths: [],
  get_github_username: 'harness-user',

  // ---- telemetry ----------------------------------------------------------
  // Swallowed deliberately: the harness must never emit real analytics.
  track_event: null,
  identify_user: null,

  // ---- workspace credentials ----------------------------------------------
  get_account_credential_status: {
    claudeAuthEmail: 'harness@example.com',
    codexAuthEmail: null,
    opencodeAuthEmail: null,
    githubAuthEmail: 'harness@example.com',
    vercelUsername: null,
    hasAnthropicBaseUrl: false,
    hasVercelToken: false,
    hasCloudflareApiToken: false,
    hasNetlifyAuthToken: false,
    hasGitName: true,
    hasGitEmail: true,
  },

  // ---- git --------------------------------------------------------------
  get_current_branch: 'main',
  check_git_has_changes: false,
  list_branches: [
    {
      name: 'main',
      is_current: true,
      is_remote: false,
      is_default: true,
      last_commit_date: Date.now(),
      last_commit_author: 'Harness User',
      ahead_of_main: 0,
      behind_main: 0,
    },
  ],

  // ---- hosting ----------------------------------------------------------
  get_hosting_status: unlinkedHostingStatus,
  detect_hosting_links: [],
};
