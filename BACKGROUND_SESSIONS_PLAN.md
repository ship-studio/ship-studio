# Background Sessions & Project Rail — Implementation Plan

## Goal

Add a Slack-style left sidebar ("rail") of pinned projects. Each pinned
project keeps its Claude Code session, dev server, and terminal state
**alive in the background** so the user can jump between projects without
losing in-flight agent work.

When the user clicks a pinned project, the app **shows the existing live
session** — it never spawns a second one for the same project.

## Core Invariant

> **One project path → at most one live session, ever.**

This is the whole safety model. Every feature, command, and code path is
judged against this rule. The previous memory-leak incident (PTYs + dev
servers piling up from project-switch churn) was caused by *accidental*
persistence. This feature is *intentional* persistence, and the invariant
above is what keeps the two from collapsing into the same failure mode.

## Non-Goals

- Multi-window is out of scope for this feature. Users can already open
  multiple Ship Studio windows; the rail is a single-window feature.
- No changes to the Claude Code session-resume mechanism (`--resume <id>`).
  That remains the cold-start path; background sessions skip it entirely.
- No changes to the per-project terminal tab system. A project can still
  have up to 5 terminal tabs; the rail operates one level above that.

---

## Architecture

### The fork: where do PTY + xterm instances live?

**Decision: module-level `SessionRegistry`, outside React.**

Rejected alternative: keep N `<Terminal>` components mounted with CSS
visibility toggles. Would work for v1 but makes the invariant hard to
enforce — React reconciliation can remount components, and a remount
without the registry would spawn a second PTY for the same project.
Putting the registry outside React means components become thin views
that attach/detach DOM nodes; lifecycle lives in one place.

### Session ownership

```
src/lib/sessionRegistry.ts

Map<projectPath, ProjectSession>

ProjectSession {
  projectPath: string
  status: 'active' | 'suspended' | 'error'
  xtermsByTab: Map<tabId, XTerm>      // xterm instances, survive DOM detach
  ptyByTab: Map<tabId, IPty>           // tauri-pty handles
  hiddenBuffers: Map<tabId, string[]>  // buffered output while detached (existing pattern)
  devServer: DevServerHandle | null
  devServerPort: number | null
  previewUrl: string | null
  branchCache: BranchInfo | null
  githubStatusCache: GitHubStatus | null
  lastAgentStatus: 'thinking' | 'waiting' | 'idle'
  unreadCount: number
  lastFocusedAt: number
  createdAt: number
  memoryBytes: number                  // polled periodically
}
```

The registry exposes `get(path)`, `getOrCreate(path)`, `setActive(path)`,
`suspend(path)`, `resume(path)`, `destroy(path)`, plus a `subscribe(fn)`
for the rail UI.

`getOrCreate` is the enforcement point for the invariant: if a session
already exists for that path, it returns the existing one. No code path
can bypass it.

### Backend state

```
src-tauri/src/state.rs

struct ProjectSessionBackend {
    owning_window_label: String,
    project_path: String,
    reserved_port: Option<u16>,
    pty_ids: Vec<u32>,
    dev_server_pid: Option<u32>,
    status: SessionStatus,  // Active | Suspended
    last_activity_at: Instant,
}

// Keyed by project_path
static PROJECT_SESSIONS: LazyLock<Mutex<HashMap<String, ProjectSessionBackend>>>;
```

Existing `OPEN_PROJECT_WINDOWS` and `RESERVED_PORTS` become derived
views over `PROJECT_SESSIONS`. The existing PTY registry in
`pty/mod.rs` adds a `project_path` field alongside `window_label`.

---

## Status (2026-04-14)

**Shipped on this branch:** Phases 1, 2a–2c, and 3. The rail UI, pinning,
persistence, and drag-to-reorder all work. Switching between pinned
projects still cold-starts (same behavior as pre-rail); pins are
effectively a quick-switcher, not background sessions.

**Reverted:** Phase 2d (commit `deb80e9`, reverted in `2565693`).

### Why Phase 2d was reverted

Phase 2d tried to land "keep pinned session alive" by parking xterm +
PTY slots in the registry when the Terminal component unmounts, and
reattaching on remount. It did that part correctly. But three surrounding
singletons still tore the session down every switch, and the combined
pressure crashed the WebKit network process:

1. **Port collision.** Two projects both want port 3000.
   `handleSelectProject` calls `kill_port(reservedPort)` unconditionally
   at [useProjectLifecycle.ts:418-421](src/hooks/useProjectLifecycle.ts#L418-L421)
   on the newly-reserved port. Even with step 2's `kill_port` skipped
   for pinned projects, step 4 still nukes whatever's on the new port —
   which is the old project's dev server, still listening on 3000.
2. **Shared `devServerRef`.** [useProjectLifecycle.ts](src/hooks/useProjectLifecycle.ts)
   holds a single `RefObject<DevServerHandle | null>`. Opening the
   second project overwrites the ref, so even if the OS process
   survives briefly, there's no handle to reach it. "Keep it alive"
   was only ever true for the Claude PTY; dev server was always lost.
3. **Preview proxy tears down unconditionally.** [usePreviewConnection.ts:203-207](src/hooks/usePreviewConnection.ts#L203-L207)
   calls `stop_preview_proxy` in its effect cleanup whenever the hook
   unmounts. There's no pinned-state check, so the old project's
   preview proxy always dies.
4. **WebKit network process crash.** Resource accumulation from (1)+(2)+(3)
   plus the still-alive parked PTY caused the WebKit network process
   to crash, which full-page-reloads the app and wipes the
   (in-memory, module-level) registry — kicking the user back to the
   projects view with no visible sessions.

### What the rewrite needs

Phase 2d is not "one more commit." The three shared singletons all
need to move into `SessionRegistry` keyed by `projectPath` before the
"keep alive" promise can be honored:

- **Per-project dev server handles.** A `Map<projectPath, DevServerHandle>`
  in the registry, not a single ref in the lifecycle hook.
- **Per-project port reservations that persist across switches.** Each
  pinned project owns a port for its lifetime. `findAndReservePort`
  must check the registry first and reuse an existing reservation, not
  release-then-reacquire. `kill_port` must never run against a port
  that belongs to a still-pinned project.
- **Lifted `<Preview>` that renders N instances.** One per pinned
  project, with inactive ones at `display:none`. Preview proxies
  torn down only on unpin, not on switch.
- **Resource ceiling.** 5 sessions worked in our earlier manual test,
  but this branch showed WebKit's network process has a real limit.
  The hard cap in Phase 5 needs to be validated under the full
  "3 dev servers + 3 PTYs + 3 iframes" pressure, not just the claude
  PTY count.

Ship these four together or not at all. Shipping any subset recreates
the 2d failure mode.

---

## Phases

Work is ordered so each phase merges independently and doesn't break
current behavior. A user who never pins a project should see no
difference until Phase 4.

### Phase 1 — Backend state model

1. Introduce `ProjectSessionBackend` and `PROJECT_SESSIONS` in
   [src-tauri/src/state.rs](src-tauri/src/state.rs).
2. Add `project_path` to `PtyInfo` in
   [src-tauri/src/commands/pty/mod.rs](src-tauri/src/commands/pty/mod.rs).
3. Port-reservation key changes from `window_label` to
   `(window_label, project_path)`. Update `reserve_port`,
   `release_port_for_window`, `get_reserved_port` and all callers.
4. New commands in `src-tauri/src/commands/projects/`:
   - `pin_project(path)`
   - `unpin_project(path)`
   - `list_pinned_projects() -> Vec<PinnedProject>`
   - `reorder_pins(paths: Vec<String>)`
   - `suspend_session(path)` — kills PTY, stops dev server, keeps pin
   - `resume_session(path)` — no-op (frontend handles re-spawn)
   - `get_session_memory(path) -> { pty_bytes, dev_server_bytes }`
5. Persistence: `~/.shipstudio/pins.json` (global, not per-project).
   Contains `{ pinnedPaths: string[], lastSessions: Record<path, { tabSessionIds, lastAgent }> }`.
6. On app launch: sweep `PROJECT_SESSIONS` for stale PIDs from a previous
   crash (`is_process_running` check) and kill orphans before the rail
   loads any pinned sessions.
7. Unit tests for the invariant: repeated `pin_project` calls for the
   same path are idempotent; session count never exceeds `pinned
   projects` count.

**Does not ship user-visible behavior.** Pure foundation.

### Phase 2 — Frontend session registry

1. New module: `src/lib/sessionRegistry.ts`. Pure TS, no React imports.
2. Refactor `src/components/Terminal.tsx` so xterm + PTY ownership moves
   into the registry. Component becomes:
   - On mount: `registry.attachTerminal(projectPath, tabId, containerRef.current)`
   - On unmount: `registry.detachTerminal(projectPath, tabId)` — does NOT kill
   - Terminal DOM attach uses `xterm.open(container)` on an already-live xterm instance.
3. Adapter hook: `useProjectSession(projectPath)` — subscribes to registry
   changes for that path, returns status + memory + unread count.
4. Hidden-buffer mechanism (already at [Terminal.tsx:94-124](src/components/Terminal.tsx#L94-L124))
   moves into the registry, now scoped per `(projectPath, tabId)`.
5. Dev server lifecycle: [useDevServer.ts](src/hooks/useDevServer.ts)
   becomes a thin wrapper that looks up the project's handle in the
   registry instead of owning it directly.
6. Polling loops (branch info, GitHub status, screenshot interval) move
   into the registry as per-project subscriptions that keep running
   whether the project is foreground or background.

**Still no rail UI.** But the registry is now load-bearing and tested.

### Phase 3 — Rail UI (parallelizable with Phase 2)

1. `src/components/ProjectRail.tsx` — 56px fixed left rail.
2. Each pin: thumbnail (reuse existing screenshot system), status dot
   (green=idle, yellow=thinking, blue=waiting for input, red=error),
   unread badge, memory tooltip on hover.
3. Status piggybacks on existing detection at
   [Terminal.tsx:377-435](src/components/Terminal.tsx#L377-L435). Bubble
   `onStatusChange` up to the registry, which notifies the rail.
4. Unread counter: when a background project's status transitions to
   `waiting`, increment; clear on focus.
5. Drag-to-reorder (HTML5 drag-and-drop is fine; no new deps).
6. Right-click context menu: Rename · Suspend · Unpin · Reveal in Finder
   · Open in IDE.
7. Keyboard: `⌘1` … `⌘9` jump to pinned slot N. `⌘⇧[` / `⌘⇧]` cycle.
8. "Add pin" button at bottom of rail opens project picker (reuse
   existing `ImportProject` / `ProjectsView` components).

### Phase 4 — Swap logic

1. `handleSelectProject` in
   [useProjectLifecycle.ts](src/hooks/useProjectLifecycle.ts) splits
   into two paths:
   - **Existing session (pinned + alive):** `registry.setActive(path)`.
     Swap xterm DOM, swap preview iframe, swap panels. No kill, no
     restart, no port reshuffle. Fast (<100ms target).
   - **Cold start (not pinned or suspended):** current flow. Reserve
     port, spawn dev server, spawn PTY.
2. `handleBackToProjects` becomes `deactivateProject`: hide workspace,
   show grid. Does **not** kill anything.
3. New explicit "Close session" action (distinct from "Back to
   projects"). Only this kills PTY + dev server. Surfaced via rail
   right-click → Unpin, and via a close button on the active pinned item.
4. Audit every existing call to `kill_window_pty`, `kill_port`,
   `stopServer`. Each one either:
   - Keeps firing (app quit, window close, explicit unpin) — OK.
   - Stops firing (project switch, back-to-projects) — remove.
   - Gets conditionally gated (dev server crash recovery) — guard with
     `if (!registry.hasActiveSession(path))`.

### Phase 5 — Resource limits & recovery

1. **Hard cap: 5 active sessions.** Validated by running 5 concurrent
   sessions on a real laptop — no issues. 6th pin prompts modal:
   "Suspend the oldest pinned session to make room?" Suspended pins
   stay on the rail (grayed out); click to resume (cold start).
2. **No idle auto-suspend by default.** Claude Code sessions can legitimately
   run 8+ hours, and auto-killing a long-running agent task mid-work
   would be worse than a stale session sitting on some RAM. If memory
   pressure becomes a real issue in practice, revisit by adding an
   opt-in setting ("Auto-suspend after 8 hours of inactivity") — but
   ship with it off.
3. **Memory tooltip** on each rail pin: "Claude: 420MB · Dev: 180MB".
   Backend polls via `sysinfo` crate (already a dep? — verify;
   otherwise pipe `ps -o rss=` on unix, `tasklist` on win).
4. **Crash recovery.** Registry polls `is_process_running(pid)` every
   5s. If a PTY died unexpectedly, mark the session `error`, rail goes
   red. Click → respawn with `--resume <session_id>`.
5. **App quit / window close.** Persist pin list + per-pin session
   metadata to `pins.json`. Kill all active PTYs + dev servers cleanly
   on quit (existing cleanup_orphaned_processes handles this).
6. **On next launch:** restore pin list, all pins start in `suspended`
   state. User clicks a pin → cold start (spawns dev server, spawns
   Claude with `--resume`).

### Phase 6 — Testing & cleanup

1. Unit tests for `SessionRegistry`:
   - Repeated `getOrCreate` for same path returns same instance.
   - `destroy` + `getOrCreate` gives a new instance.
   - Soft-cap LRU eviction picks the least-recently-focused.
2. Integration tests (Playwright):
   - Pin project A, start a long-running Claude task, switch to B,
     do work, switch back to A, verify A's task output is intact.
   - Suspend A, resume A, verify terminal scrollback restored.
   - Force-quit during active sessions, relaunch, verify no stale PIDs.
3. Memory leak hunt: detached xterm instances with WebGL contexts.
   Each session's WebGL context must be disposed on suspend/unpin —
   browsers cap WebGL contexts around 16 per page.
4. Fresh-machine test per [CLAUDE.md](CLAUDE.md) gold-standard guidance.
5. Delete orphaned reset logic from `handleSelectProject` /
   `handleBackToProjects` — lots of code becomes dead after Phase 4.

---

## Risks

### WebGL context exhaustion
[Terminal.tsx:341-348](src/components/Terminal.tsx#L341-L348) uses the
WebGL addon. Browsers cap WebGL contexts around 16. 4 pinned projects
× 5 tabs = 20 contexts. **Mitigation:** dispose WebGL addon on detach
(`term.element` is gone anyway), recreate on attach. Or fall back to
canvas renderer for background projects.

### Dev server port fragmentation
4 projects × Next.js-on-3000 means 4 different ports in use. Existing
`find_available_port` handles this. **Risk:** user confusion about
which project is on which port. **Mitigation:** show port in rail
tooltip; surface prominently in workspace when a non-preferred port
is assigned.

### Navigation race conditions
[useProjectLifecycle.ts](src/hooks/useProjectLifecycle.ts) already has a
`navigationVersionRef` dance to handle races between project-switch and
cleanup. That dance gets spicier when project-switch no longer resets.
**Mitigation:** refactor the race handling into the registry
(`registry.setActive` is atomic) rather than bolting onto
`navigationVersionRef`.

### Preview iframe lifecycle (resolved)
[Preview.tsx:383](src/components/Preview.tsx#L383) currently does
`<iframe key={projectPath} ...>` which forces a full iframe teardown
every time projectPath changes — the opposite of what we want for
background sessions.

**Decision:** mount one `<Preview>` component per pinned session and
toggle visibility with `display: none`. Iframes preserve their state
(scroll, form inputs, inner app state) through `display: none`, so the
preview "resumes" exactly where the user left it. Remove the
`key={projectPath}` — each Preview instance is already scoped to its
own projectPath, so the key was only providing remount-on-switch, which
we no longer want.

**Watch for:** [usePreviewConnection](src/hooks/usePreviewConnection.ts)
polls dev server health. With 5 hidden previews each polling, that's
wasted work. Need to pause or throttle polling for hidden previews —
pass `isActive` down similar to how `Terminal.tsx` handles it, and
short-circuit the polling loop when hidden.

### Re-introducing the old leak
Every `kill_*` audit in Phase 4 is a chance to miss a path. **Mitigation:**
integration test that pins 2 projects, switches between them 50 times,
asserts PTY count stays at exactly 2 and dev server count stays at 2.
This test codifies the invariant.

---

## Success Criteria

- Switching between 2 pinned projects 50 times in a row produces
  exactly 2 Claude processes and 2 dev servers — never 3, never more.
- Running 5 pinned sessions concurrently stays stable over a full
  work session (validated target, matches real-world usage).
- Switching time under 150ms (xterm DOM swap + preview visibility swap).
- Claude task running in a background project continues to completion
  without user intervention.
- Memory per pinned session remains stable over 1 hour of idle.
- On crash/relaunch, rail restores with sessions in `suspended` state,
  no orphaned PIDs.
- Unread badge on rail increments when background Claude reaches a
  `waiting` state (needs user input or finished task).


