# Analytics Reference

Single source of truth for every PostHog event Ship Studio emits, what
properties it carries, and the question the event answers.

The pipeline: TypeScript [`src/lib/analytics.ts`](../src/lib/analytics.ts) →
Tauri `track_event` IPC → Rust [`src-tauri/src/commands/analytics.rs`](../src-tauri/src/commands/analytics.rs)
→ PostHog HTTP capture API. The API key never leaves the Rust backend. A
handful of workflow events are sent straight from Rust via
`track_backend_event`, because they happen with no window involved.

## The organizing principle

An event answers **"which feature did this person use, and did it work?"** —
one event per feature use, carrying the outcome where there is one. It is not
a record of clicks. The things that are deliberately *not* events:

- Window focus/blur, idle, quit. Session length lives on
  `project_session_ended`.
- Tab and sub-tab switches, panel and sidebar toggles, popovers opening, list
  reorders, modal open/close. A workspace tab change is a `$pageview`; nothing
  else about navigation is recorded.
- Button clicks that lead somewhere the outcome is already recorded
  ("New Project" clicked → `project_created`; "Submit for review" opened →
  `pr_created`).
- Search and filter queries. They were free text.
- Per-element selection inside the visual editor.
- Branch names, file paths, route patterns, finding text, prompts. The
  question is always answerable from shape alone.

When you are about to add an event, ask what dashboard breaks without it. If
the answer is "none", it is a click, not a feature.

## Standard properties (auto-attached)

`enrichProperties()` in `lib/analytics.ts` adds these to every event so no
callsite has to remember:

| Property | Source | Notes |
|---|---|---|
| `$session_id` | App session UUID, generated at module load | PostHog standard — groups all events from one launch |
| `$screen_name` | `setActiveScreen()` / `trackPageview()` | Set by view transitions; explicit per-event values override |
| `project_id` | `getProjectId(path)` (FNV-1a hash, 8 chars) | Privacy-safe, stable across launches |
| `project_name` | Folder name | Human-readable; only emitted when in a project context |
| `project_session_id` | UUID per project session | Spans open → close/switch |
| `app_version` | Backend (`CARGO_PKG_VERSION`) | Added in Rust |
| `$os` | Backend (`#cfg!(target_os)`) | Added in Rust |

## User identification (`$identify`)

Fired from `useIntegrationStatus` once GitHub auth resolves with a username.

| Action | Properties |
|---|---|
| `$set` (overwrites every identify) | `github_username`, `latest_app_version`, `last_identified_at` |
| `$set_once` (first identify only) | `first_identified_at`, `first_app_version` |

## Events by domain

### Lifecycle

| Event | Fired when | Key properties | Question it answers |
|---|---|---|---|
| `app_launched` | App boot | — | DAU/MAU baseline |
| `project_opened` | Project enters workspace | inherited project context | Per-project engagement; the retention event |
| `project_session_ended` | Switch / back / close / quit | `duration_seconds`, `reason` (`project_switched` / `back_to_projects` / `project_closed` / `app_quit`) | Session length and how it ended |

### Screens (`$pageview`)

`trackPageview(name)` ships `$pageview` with `$current_url: app://ship-studio/<slug>`
and `$pathname: /<slug>`. Screens emitted:

- `Dashboard`
- `Workspace - Preview | Code | Branches | Pull Requests` — a workspace tab
  switch *is* this event; there is no separate tab-switch event

Onboarding sets `$screen_name` (`Onboarding - <step>`) for context on its own
events but does not emit pageviews — the `setup_*` funnel below is the record.

### Cmd+K palette

| Event | Properties | Question it answers |
|---|---|---|
| `palette_opened` | `context`, `initial_tab` | Palette adoption; opens minus runs is the abandonment rate |
| `palette_command_run` | `command_id`, `category`, `position`, `total_results`, `query_length`, `had_query`, `tab`, `context` | Which features people reach through the palette (the query text itself is never sent) |

### Dashboard & projects

| Event | Properties | Notes |
|---|---|---|
| `project_created` | `source: 'new'` | |
| `project_imported` | `source` (`github` / `local_folder`) | |
| `project_deleted` | `count` | One event per action — a bulk delete from the list view is one event with `count > 1` |
| `project_removed_from_app` | `count`, `is_external` (single removal only) | Same shape as above |
| `project_renamed` / `project_thumbnail_uploaded` / `project_exported_as_template` | — | |
| `project_moved_to_folder` / `project_moved_to_workspace` | — | |
| `folder_created` / `folder_deleted` | — | |
| `project_pinned` / `project_unpinned` | `project_id`, `project_name`, `pin_count` | The project rail's adoption metric |
| `projects_moved` | `moved_count`, `skipped_count` | After moving projects into a newly-chosen projects folder — did the risky move work |
| `backup_restored` | — | Snapshot rewind used |

### Settings

| Event | Properties |
|---|---|
| `setting_changed` | `setting`, `value` — one event for every settings toggle. `setting` is one of `analytics` (only ever `true`; the opt-out can't send), `calendar_visible`, `terminal_gpu`, `compact_workspace_toolbar`, `thumbnails`, `spotify_widget`, `projects_root` (`value` is whether the root is now custom) |
| `thumbnail_consent_answered` | `allowed` — the user's answer to the first-run "Preview thumbnails" explainer (#160) |

### Dev server & dependencies

| Event | Properties |
|---|---|
| `dev_server_started` | `project_type`, `port` |
| `dev_server_restarted` | `project_type` |
| `custom_dev_command_saved` | `has_command` |
| `install_dependencies_succeeded` | `package_manager` |
| `install_dependencies_failed` | `package_manager`, `exit_code`, `error_detail` (home-dir scrubbed, capped 300) |

### Agent terminal

| Event | Properties | Notes |
|---|---|---|
| `terminal_tab_added` | `tab_count`, `agent_id` | Every agent session started, including the one a finding hand-off spawns |
| `terminal_tab_restarted` | — | Relaunched an exited agent tab |
| `agent_switched` | `agent_id` | Changed the agent CLI on a tab |
| `split_view_enabled` | `pane_count` | Side-by-side adoption |

### Preview & browser tools

| Event | Properties |
|---|---|
| `screenshot_captured` | `mode` (`viewport`/`fullpage`), `success`, `fell_back`, `fallback_success` (fullpage only, present when `fell_back`) |
| `preview_breakpoint_changed` | `breakpoint` |
| `preview_size_applied` | `width`, `has_height` (exact size set from the dimensions popover) |
| `preview_fix_with_agent` | `has_logs`, `is_static`, `reason` (`server-down`/`blank-iframe`), `process_gone` |
| `preview_connect_stopped` | `retry_count` — the preview gave up connecting; a fault signal |
| `inspect_panel_opened` | — (the dev-logs / browser-tools panel was opened; closes and sub-tab switches are not recorded) |
| `browser_tools_sent_to_agent` | `tab`, `entry_count` (null for elements), `had_data`, `char_count` |
| `logs_sent_to_agent` | `source` (`full_buffer`/`selection`), `char_count`, `line_count`, `had_question` (selection only) |
| `agent_bridge_tool_used` | `tool` (preview_console/network/dom/navigate/reload/screenshot), `is_error` — the workspace agent called a preview MCP tool via the agent bridge |

### Code mode

| Event | Properties |
|---|---|
| `code_file_saved` | `file_extension` (a file edited in-app and written to disk) |
| `code_snippet_sent_to_agent` | `file_extension`, `language`, `line_count`, `char_count`, `had_question` |

Entering Code mode is the `Workspace - Code` pageview; opening a file is not
an event.

### Visual editing

| Event | Properties | Notes |
|---|---|---|
| `visual_edit_started` | `mode` | Edit mode toggled on — the adoption metric |
| `visual_edit_stopped` | `mode`, `duration_ms`, `edits_committed` | The session's outcome |
| `visual_edit_saved` | `kind`, `mode`, optional `op` / `count` | **One event per edit persisted to source**, whatever the editor. `kind` is one of `style`, `text`, `image`, `insert`, `duplicate`, `delete`, `class`, `custom_class` (with `op`: `create`/`apply`/`unapply`/`edit`), `attribute`, `rule`, `keyframes`, `variable` |
| `visual_prep_started` | `mode: 'css'` | Opened the "Prepare for visual editing" agent prompt |

`mode` is `tailwind` (the utility-class editor), `css` (the CSS editor panel)
or `css-code` (the cascade/code editor). Selecting an element is not an event.

### Environment variables

| Event | Properties |
|---|---|
| `env_saved` | `file`, `var_count` |
| `env_synced` | `target` (`.env.example` / `.env.local`), `key_count` |
| `env_file_created` / `env_file_deleted` | `file` |

### Assets

| Event | Properties |
|---|---|
| `asset_managed` | `action` (`upload` with `file_count` / `delete` with `is_folder` / `rename` / `create_folder` / `download` / `change_root`) — one event for every assets-panel operation |

### Languages (i18n)

| Event | Properties |
|---|---|
| `i18n_config_saved` | `locale_count` |
| `i18n_translate_requested` | see `LanguagesModal` — locale counts only |
| `i18n_app_router_setup_started` | `locale_count` |
| `i18n_ai_fallback_used` | `framework` |

### Branches & PRs

Branch names are never sent. Every event here is shape-only.

| Event | Properties |
|---|---|
| `branch_created` | — |
| `branch_switched` | `source: 'external'` when detected from the CLI/agent rather than the UI |
| `branch_deleted` | — |
| `branch_published` | `is_main`, `time_since_last_publish_seconds` (publish dropdown); `source: 'external'` when an outside push is detected |
| `git_pulled` | `result` (`pulled` / `up_to_date` / `merge_conflict`) |
| `worktree_created` | `created_branch` (new vs existing branch), `copied_env` |
| `worktree_switched` | `via` (`branches_tab` / `branch_switch_redirect`) |
| `worktree_removed` | `forced` |
| `pr_created` | `used_ai`, `title_length`, `description_length` |
| `pr_merged` | `from_submit_modal` (when merged from the submit flow) |
| `pr_closed` / `pr_checked_out` | — |
| `post_merge_cleanup` | — (switched back and deleted the merged branch) |
| `pr_conflict_sent_to_agent` / `pr_conflict_resolve_in_app` | — (which way the user chose to resolve a PR conflict) |

### Conflicts

| Event | Properties |
|---|---|
| `conflict_resolved` | `resolution` (`current` / `incoming`) — one per conflict block |
| `merge_completed` | `total_conflicts` |
| `merge_aborted` | — |

### Plugins / Skills / MCP

| Event | Properties |
|---|---|
| `plugin_installed` / `plugin_uninstalled` / `plugin_updated` | `plugin_id` |
| `plugin_toggled` | `plugin_id`, `enabled` |
| `plugin_dev_linked` / `plugin_dev_unlinked` | `plugin_id` |
| `skill_installed` | `package`, `scope` |
| `skill_removed` | `plugin`, `scope` |
| `mcp_server_added` / `mcp_server_removed` | `scope` |

### Workflows & Inbox

Shape only. No workflow name, no instruction text, no finding title, no project
path — everything this feature touches is someone's private repository, and the
questions worth asking ("does anyone arm a schedule?", "do runs fail?", "does a
finding ever become work?") are all answerable without any of it.

| Event | Fired when | Properties | Question it answers |
|---|---|---|---|
| `workflow_created` | A workflow file is saved from the editor (`source: 'form'`), or the backend first lists a file that appeared on disk without it (`source: 'file'` — in practice the bundled agent skill, though a pull or a hand-written file looks the same) | `source`, `trigger_kind`, `permission`, `agent`, `auto_run`, `severity_floor` | Which authoring path people use, and whether they schedule or only ever press Run |
| `workflow_edited` | An existing workflow is saved from the editor | `trigger_kind`, `permission`, `agent`, `auto_run`, `severity_floor` | Do workflows get tuned after the first run? |
| `workflow_deleted` | Deleted from the editor (`source: 'form'`, with `trigger_kind`, `auto_run`) or the file vanished from disk (`source: 'file'`, shape unknown) | `source`, … | Churn |
| `workflow_toggled` | The auto-run switch in the list | `auto_run`, `trigger_kind` | The moment a workflow becomes unattended |
| `workflow_run_started` | A run begins — **emitted from Rust** | `source` (`manual`/`schedule`/`event`), `trigger_kind`, `permission`, `agent`, `auto_run` | Paired with the finish: a start with no finish is a run the app was quit out of |
| `workflow_run_finished` | Every run completes or fails — **emitted from Rust**, so scheduled and event-triggered runs count too | `source`, `trigger_kind`, `permission`, `agent`, `auto_run`, `status` (`ok`/`findings`/`failed`), `findings`, `duration_ms`, `duration_bucket` (`<30s` / `30s-2m` / `2m-10m` / `>10m`), `tokens` | Does the unattended half work, what does it cost, and how often does it fail? |
| `workflow_finding_action` | Something happens to a finding in the Inbox | `action`, `severity`, `occurrences`; `fix` also carries `outcome` | Does the inbox turn into work, or into a graveyard? |

`workflow_finding_action.action` is one of:

- `open` — first read of an unread finding (arrow-keying back through
  already-read items does not count again)
- `fix` — "Fix in \<project\>". Fired **once the hand-off resolves**, not at the
  click, so one event carries the `outcome`: `delivered` (a new agent tab
  started with the prompt), `no_room` (the project is at its tab cap), or
  `failed` (the project would not open, or no terminal was ready within a
  minute)
- `archive` / `restore` / `delete`

The Rust-side events (`workflow_run_started`, `workflow_run_finished`, and the
`source: 'file'` create/delete) go through `track_backend_event`, because a
scheduled run fires with no window involved and a file written by an agent is
only ever noticed by the backend's listing; routing them through the frontend
would drop exactly the cases the feature exists for.

### Onboarding funnel

| Event | Properties |
|---|---|
| `setup_started` | `entry_path` (`wizard`/`fast_path`/`agent_led`), `entry_step` |
| `setup_step_entered` | `step_id`, `step_index` |
| `setup_step_completed` | `step_id`, `step_index`, `duration_ms`, `is_final` |
| `setup_step_skipped` | `step_id`, `step_index`, `reason: 'already_complete'` |
| `setup_action_clicked` | `item_id`, `action` (`install`/`connect`), `step_id` (wizard step, or `agent_led_pick`) |
| `setup_action_failed` | `item_id`, `exit_code`, `error_excerpt` (extracted from terminal output, capped 200) |
| `onboarding_completed` | `agents`, `entry_path` (`wizard`/`fast_path`/`agent_led`/`agent_led_fast_path`) |
| `default_agent_selected` | `agent_id`, `agent_count` |
| `onboarding_mode_switched` | `to` (`classic`/`agent`) — the escape-hatch health metric: a spike in `to: classic` means agent-led onboarding is failing people |
| `agent_card_selected` | `key` (`claude`/`codex`/`cursor`/`opencode`/`other`), `already_ready` |
| `onboarding_host_selected` | `host` (`vercel`/`cloudflare`/`skipped`) — becomes the workspace default host |
| `agent_guided_setup_started` | `agent_id` (`other` for bring-your-own), `missing_items`, `host`, `demo` (true under mock mode) |
| `agent_guided_setup_restarted` | `agent_id` — the agent session ended before setup finished and the user relaunched it |

### Updates, support, help

| Event | Properties |
|---|---|
| `update_started` / `update_downloaded` / `update_deferred` | `version` — the restart click is not an event; the next `app_launched` carries the new version |
| `version_rewind_completed` | `target_version` — a failed rewind is an `error_occurred` with `action: 'version_rewind'` |
| `help_opened` | — |
| `support_article_viewed` | `article_slug` |
| `support_slack_cta_clicked` | — (left for the community Slack) |
| `support_ticket_created` | `ticket_type`, `shared_project_info` |
| `support_ticket_replied` | — |

### Errors

| Event | Properties |
|---|---|
| `error_occurred` | `action`, `error_message` (capped 500), `error_type` — fired by `trackError()` from catch blocks. The `action` is the operation that failed (`git_push`, `plugin_install`, `pr_create`, …) |

`error_occurred` is analytics, not bug reporting. The admin-agent pipeline that
files GitHub issues (including from error toasts) is documented in
[error-reporting.md](error-reporting.md).

## Suggested PostHog dashboards

1. **North-star** — DAU/MAU/WAU (`app_launched`), projects per user
   (`project_opened`), agent sessions (`terminal_tab_added`), publish success
   (`branch_published`, `pr_created`), palette usage (`palette_command_run`).
2. **Onboarding funnel** — `app_launched → setup_started → setup_step_completed
   (per step) → onboarding_completed → first project_opened`. Break down by
   `entry_path`.
3. **Publish funnel** — `branch_created → branch_published → pr_created →
   pr_merged`. Conversion at each step.
4. **Feature adoption** — % of users with at least one of: `palette_command_run`,
   `inspect_panel_opened`, `visual_edit_started`, `logs_sent_to_agent`,
   `screenshot_captured`, `plugin_installed`, `skill_installed`,
   `mcp_server_added`, `workflow_created`, `asset_managed`.
5. **Workflows** — `workflow_created` by `source`; `workflow_run_finished` by
   `source` and `status`; `workflow_finding_action` `fix` by `outcome` vs
   `archive`/`delete`.
6. **Retention** — cohort by `first_app_version` (set_once), retained by
   `project_opened`.
7. **Errors** — `error_occurred` grouped by `action`; `install_dependencies_failed`;
   `preview_connect_stopped`; `workflow_run_finished` with `status: failed`.
   Watch for spikes across release boundaries (cohort by `latest_app_version`).

## Adding a new event

1. Ask what dashboard breaks without it. Clicks, toggles and navigation are not
   events; a feature being used, with its outcome, is.
2. Pick a name from the existing taxonomy: `domain_action` (snake_case, past
   tense). Prefer a property on an existing event over a new name when the
   new thing is a variant of an existing one (`visual_edit_saved.kind`,
   `asset_managed.action`, `setting_changed.setting`).
3. Call `trackEvent(name, props)` from the relevant component or hook. Shape
   only: counts, kinds, booleans, durations — never user content.
4. If the action is a screen change, use `trackPageview('Display Name')`.
5. Add a row to the table above so the next reader doesn't have to grep.

## Privacy

- **Project paths are never sent** — only the 8-char `project_id` hash. The
  folder name is sent as `project_name`.
- **Branch names are never sent.** Branch and PR events are shape-only.
- **No free text.** Search queries, finding text, prompts, file paths, route
  patterns and element text are never sent. The exceptions are error
  diagnostics: `error_message` (capped 500), `setup_action_failed.error_excerpt`
  (capped 200) and `install_dependencies_failed.error_detail` (home-dir
  scrubbed, capped 300).
- Person properties on `$set_once` (first_seen, first_version) never overwrite —
  even on re-identify.
- **Users can disable analytics via Settings → Usage analytics & error reports.**
  The Rust backend short-circuits all sends when the toggle is off; the setting
  persists across launches. The same toggle also disables automatic bug reports
  to the admin agent (see `docs/error-reporting.md`) — opted-out users share no
  data of any kind.
