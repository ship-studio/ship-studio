# Analytics Reference

Single source of truth for every PostHog event Ship Studio emits, what
properties it carries, and the question the event answers.

The pipeline: TypeScript [`src/lib/analytics.ts`](../src/lib/analytics.ts) →
Tauri `track_event` IPC → Rust [`src-tauri/src/commands/analytics.rs`](../src-tauri/src/commands/analytics.rs)
→ PostHog HTTP capture API. The API key never leaves the Rust backend.

## Standard properties (auto-attached)

`enrichProperties()` in `lib/analytics.ts` adds these to every event so no
callsite has to remember:

| Property | Source | Notes |
|---|---|---|
| `$session_id` | App session UUID, generated at module load | PostHog standard — groups all events from one launch |
| `$screen_name` | `setActiveScreen()` | Set by view transitions; explicit per-event values override |
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

### Lifecycle (`app_*`, `project_*`)

| Event | Fired when | Key properties | Question it answers |
|---|---|---|---|
| `app_launched` | App boot | — | DAU/MAU baseline |
| `app_window_focused` | Window gains focus | — | When users return to the app |
| `app_window_blurred` | Window loses focus | `focus_duration_ms` | How long users stay in-app per focus session |
| `app_idle_detected` | 5 min of no input | `threshold_ms` | True engaged time |
| `app_idle_resumed` | Activity after idle | — | Pair with idle for engagement deltas |
| `app_quit` | Quit confirmed (user_action) or OS close | `reason` | Quit reason; pair with session length |
| `project_opened` | Project enters workspace | inherited project context | Per-project engagement |
| `project_session_started` | Project becomes active | inherited project context | Session funnel start |
| `project_session_ended` | Switch / back / close / quit | `duration_seconds`, `reason` | Session length and how it ended |

### Screens (`$pageview`)

`trackPageview(name)` ships `$pageview` with `$current_url: app://ship-studio/<slug>` and `$pathname: /<slug>`. Screens currently emitted:

- `Dashboard`
- `Onboarding - <Step Title>` (per wizard step)
- `Workspace - Preview | Code | Branches | Pull Requests`

### Navigation

| Event | Properties | Notes |
|---|---|---|
| `workspace_tab_switched` | `from_tab`, `to_tab` | Click-tracked; pageview fires on the projected (gate-applied) tab via effect |
| `inspect_subtab_switched` | `from_tab`, `to_tab` | Console / Network / Elements |
| `inspect_panel_toggled` | `is_open` | The dev-logs / browser-tools panel |
| `sidebar_toggled` | `is_hidden` | Workspace sidebar collapse |
| `project_pinned` | `project_id`, `project_name`, `pin_count` | |
| `project_unpinned` | same | |
| `pins_reordered` | `pin_count` | Drop event only — not mid-drag |
| `project_picker_button_clicked` | — | Dedicated picker button only; Cmd+K opens are tracked separately |

### Cmd+K palette

| Event | Properties |
|---|---|
| `palette_opened` | `context`, `initial_tab` |
| `palette_closed` | `context`, `dismissed_with` (`command_run`/`manual`), `duration_ms` |
| `palette_command_run` | `command_id`, `category`, `position`, `total_results`, `query`, `query_length`, `had_query`, `tab`, `context` |
| `palette_tab_switched` | `from_tab`, `to_tab`, `cause` (`click`/`keyboard`), `context` |
| `search_performed` (with `search_type: 'palette'`) | Debounced 1s; cancelled on close |

### Workspace deep features

| Event | Properties |
|---|---|
| `screenshot_captured` | `mode` (`viewport`/`fullpage`), `success`, `fell_back` |
| `preview_refreshed` | `trigger: 'user'` |
| `preview_page_selected` | `route_pattern` (id segments → `:id`, capped 200), `depth` |
| `logs_sent_to_agent` | `source` (`full_buffer`/`selection`), `char_count`, `line_count`, `had_question` |
| `browser_tools_subtab_switched` | `from_tab`, `to_tab` |
| `browser_tools_cleared` | `tab` |
| `browser_tools_dom_refreshed` | — |
| `browser_tools_sent_to_agent` | `tab`, `entry_count` (null for elements), `had_data`, `char_count` |
| `code_file_opened` | `file_extension` |
| `code_tree_refreshed` | — |
| `code_snippet_sent_to_agent` | `file_extension`, `language`, `line_count`, `char_count`, `had_question` |
| `code_snippet_copied` | `file_extension`, `line_count` |
| `search_performed` (`code_files`) | Debounced |

### Branches & PRs

| Event | Properties |
|---|---|
| `branch_created` | `from_branch` |
| `branch_switched` | — |
| `branch_deleted` | — |
| `branch_published` | `is_main`, `branch`, `time_since_last_publish_seconds` |
| `pr_created` | `base_branch`, `used_ai`, `title_length`, `description_length` |
| `pr_merged` | `head_ref`, `base_ref` |
| `pr_closed` | — |
| `pr_checked_out` | `head_ref` |
| `post_merge_cleanup` | `deleted_branch` |
| `submit_review_opened` | `branch` |
| `ai_pr_description_generated` | optional `committed_first` |

### Conflicts

| Event | Properties |
|---|---|
| `conflict_resolved` | per-file count |
| `merge_completed` | — |
| `merge_aborted` | — |

### Modals

Centralized in [`src/contexts/ModalContext.tsx`](../src/contexts/ModalContext.tsx) — every `open(id)` and `close(id)` fires automatically. `commandPalette` is excluded (Phase 3 tracks it richer).

The modal id is baked into the event name (`modal_<id>_opened` / `modal_<id>_closed`) so PostHog's default events list is self-describing. `modal_id` is also in the payload for cross-modal filters.

| Event pattern | Properties | Examples |
|---|---|---|
| `modal_<id>_opened` | `modal_id` | `modal_envEditor_opened`, `modal_skills_opened`, `modal_pluginManager_opened` |
| `modal_<id>_closed` | `modal_id`, `duration_ms`, optional `reason` (`'provider_unmount'` on app teardown) | `modal_envEditor_closed`, etc. |

To get an aggregate "any modal opened" count in PostHog, use a regex match on event name (`modal_.*_opened`) or a property filter on `modal_id`.

### Plugins / Skills / MCP

| Event | Properties |
|---|---|
| `plugin_installed` / `plugin_uninstalled` / `plugin_updated` | `plugin_id` |
| `plugin_toggled` | `plugin_id`, enabled state |
| `plugin_dev_linked` / `plugin_dev_unlinked` | `plugin_id` |
| `skill_installed` / `skill_removed` | skill ID |
| `skills_searched` | search query |
| `mcp_server_added` / `mcp_server_removed` | `scope` |

### Onboarding funnel

| Event | Properties |
|---|---|
| `setup_started` | `entry_path` (`wizard`/`fast_path`), `entry_step` |
| `setup_step_entered` | `step_id`, `step_index` |
| `setup_step_completed` | `step_id`, `step_index`, `duration_ms`, `is_final` |
| `setup_step_skipped` | `step_id`, `step_index`, `reason: 'already_complete'` |
| `setup_step_navigated_back` | `from_step`, `to_step` |
| `setup_action_clicked` | `item_id`, `action` (`install`/`connect`), `step_id` |
| `onboarding_completed` | `agents`, `entry_path` |
| `default_agent_selected` | `agent_id`, `agent_count` |

### Errors & misc

| Event | Properties |
|---|---|
| `error_occurred` | `action`, `error_message` (capped 500), `error_type` |
| `update_started` / `update_downloaded` / `update_restarted` / `update_deferred` | version info |
| `version_rewind_started` / `version_rewind_completed` | — |
| `support_*` | various — see `src/components/support/` |
| `analytics_enabled` / `analytics_opted_in` | — |

## Suggested PostHog dashboards

Create these in the PostHog UI and link them here when set up:

1. **North-star** — DAU/MAU/WAU, projects per user, agent messages per session, publish success rate, Cmd+K usage.
2. **Onboarding funnel** — `app_launched → setup_started → setup_step_completed (per step) → onboarding_completed → first project_opened`. Break down by `entry_path`.
3. **Publish funnel** — `branch_created → branch_published → pr_created → pr_merged`. Conversion at each step.
4. **Feature adoption** — % of users who used Cmd+K, Inspect panel, Focus mode, Server Logs → Agent, plugins, skills, MCP, screenshots.
5. **Retention** — cohort by `first_app_version` (set_once), retained by `project_session_started`.
6. **Error frequency** — `error_occurred` grouped by `action`. Watch for spikes across release boundaries (cohort by `latest_app_version`).
7. **Engagement** — `app_window_focused` durations, `app_idle_detected` rate, `project_session_ended` `duration_seconds` distribution.

## Adding a new event

1. Pick a name from the existing taxonomy: `domain_action` (snake_case).
2. Call `trackEvent(name, props)` from the relevant component or hook.
3. If the action is a screen change, prefer `trackPageview('Display Name')` instead — it sets the active screen *and* fires `$pageview`.
4. If the action is a search, use `trackSearch(searchType, query)` — debounced 1s, free of empty-query spam.
5. Add a row to the table above so the next reader doesn't have to grep.

## Privacy

- Project paths are never sent — only the 8-char `project_id` hash.
- Branch names are never sent (they routinely contain customer/codename data); the `is_main` boolean carries the meaningful signal.
- `error_message` is capped at 500 chars.
- Search queries are capped at 100 chars by `trackSearch`; the original length lands in `query_length`.
- Person properties on `$set_once` (first_seen, first_version) never overwrite — even on re-identify.
- Users can disable analytics via Settings; the Rust backend short-circuits all sends when disabled.
