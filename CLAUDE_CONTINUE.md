# Handoff — multi-project multitasking (resume here)

Goal: Ship Studio should let the user open N projects at once, each with its own dev server and agent/terminal tabs running independently, Chrome-tab-style. Switching projects is a pure view flip; only the explicit close (X) button or app quit tears down a session.

The dev-server half (Slice 3) and session model (Slice 4 hook) are in place and mostly correct. What's blocking ship is a **sidebar layout bug that renders children side-by-side instead of stacking vertically**, and a **related horizontal scrollbar at the bottom of the sidebar**. Neither has a known root cause — CSS inspection in DevTools is the next step.

## Branch state

- Worktree: `/Users/juliangalluzzo/Desktop/Projects/shipstudio-multiple-running-agents`
- Branch: `multiple-running-agents`
- Dev server: `pnpm tauri dev` (port 1421, identifier `com.memberstack.shipstudio.dev2`)
- **Do not cherry-pick** `vite.config.ts`, `src-tauri/tauri.conf.json` — they're dev-only port/identifier overrides. Revert those three fields on merge to main.
- Parallel worktree at `/Users/juliangalluzzo/Desktop/Projects/shipstudio` on `agent-selection-updates` is orthogonal.

## What works

- **Per-project dev servers** (`src/hooks/useDevServer.ts`) — handles, ports, output buffers, throttles all keyed by path in a `Map<string, ProjectServerState>`. `stopServer(path?)`, `stopAllServers()`, `isServerRunning(path)` are exposed.
- **Per-project terminal state** (`src/hooks/useTerminalManagement.ts`) — tabs, active tab id, counter, `sessionEpoch` stored per path. Scalar API (`terminalTabs`, `activeTerminalTab`) reflects the current project. `allSessions: TerminalSessionView[]` exposes every active session for rendering. `terminalRefsMap` keys by `${path}::${tabId}`. Mutations (`addTerminalTab`, `closeTerminalTab`, etc.) target the current project by default. New: `closeAllTerminalsForProject(path)`, `ensureProjectSeeded(path)`.
- **Hot session model** (`src/hooks/useProjectLifecycle.ts`):
  - `handleSelectProject` no longer calls `stopServer`, `kill_window_pty`, or `setView('project-loading')`. It immediately `setView('workspace')` so `WorkspaceView` stays mounted across switches (unmounting it killed every Terminal child's PTY — the original bug).
  - `handleBackToProjects` is a pure view flip. No teardown.
  - `sessionRegistry.suspend` is no longer called on switch — every active session keeps status `'active'` because its processes are alive.
- **Explicit close** (`handleCloseProject` in `App.tsx`) is the only path (besides app quit) that reaps a project. It calls `stopServer(path)`, `closeAllTerminalsForProject(path)`, `unregisterProjectSession(path)`, `sessionRegistry.destroy(path)`, and routes home if that project was current.
- **Sidebar is Pinned + Active groups**. Active = `sessionRegistry.snapshotAll()` filtered to non-pinned paths. Pinned = `pinnedProjects.rows`. Inactive-project agents render with green dots (not muted) because their PTYs are alive in the background.
- **Multi-terminal render in `WorkspaceView`**: `allSessions.flatMap(...)` renders Terminal components for every active session; non-current project's wrappers get `style={{display: 'none'}}`. Only the current-project + active-tab gets `.active`.

## What's broken (resume here)

### 1. Sidebar children render side-by-side (image #17 in chat)

Despite repeated CSS fixes, `.workspace-sidebar-scroll` children sometimes render horizontally (pinned column on the left, active column on the right) instead of stacking vertically.

**Current CSS defense** (in `src/styles/features/workspace/sidebar.css`):
- `.workspace-sidebar-scroll { display: block !important; width: 100% !important; overflow-x: hidden !important; }`
- `.workspace-sidebar-scroll > * { display: block !important; width: 100% !important; max-width: 100% !important; float: none !important; clear: both !important; position: static !important; }`
- Belt-and-suspenders `.sidebar-project, .sidebar-project-body, .sidebar-project-body-inner, .sidebar-project-inactive, .sidebar-group-empty, .sidebar-section { display: block !important; ... }`
- Universal `.workspace-sidebar * { box-sizing: border-box; }`

With all these `!important` rules the layout *should* be block-stacked. The fact that it isn't suggests either:
- HMR is serving stale CSS — hard reload (Cmd+R) didn't help in testing. **Next step**: wipe the Vite cache (`rm -rf node_modules/.vite`) and restart.
- Something outside `.workspace-sidebar` is pushing content — e.g. a sibling render inside `.workspace-body` or `.projects-with-rail` that's not the expected sidebar/main pair. **Next step**: user needs to right-click the "No active projects…" text in DevTools, Inspect Element, and send the parent chain. That'll reveal whether the text is actually inside `.workspace-sidebar-scroll` or escaping into a different subtree.
- React is rendering `WorkspaceSidebar` twice somehow (e.g. both projects view and workspace view mounted briefly during a transition). **Next step**: add a `console.log('sidebar mount', projectPath)` in a `useEffect(() => {...}, [])` in `WorkspaceSidebar` and count mounts per click.

### 2. Horizontal scrollbar at bottom of sidebar (image #18)

Shows up as a thin gray bar just above the `+ Open project` footer. My box-sizing fix (universal `border-box`) didn't eliminate it. With `overflow-x: hidden` on `.workspace-sidebar-scroll`, no child should be able to force a scrollbar here — unless the scrollbar belongs to a different element. Possible culprits:
- `.workspace-sidebar-footer` — add `overflow: hidden` defensively.
- `.sidebar-project-body` when a long agent tab title is rendered without truncation.
- A Terminal inside a project-loading preview still rendering at the bottom somehow.

### 3. Terminal output fragmented / tiny (image #18)

When a project with a running terminal is switched in, xterm sometimes renders with minimal width — output shows as single letters on separate lines ("L", "Ti", "de", "ar"). This is almost certainly **xterm's dimension detection failing while its container is `display: none`**. When the hidden wrapper becomes visible on switch-back, xterm doesn't re-fit.

**Fix direction**: in `WorkspaceView`'s terminal render, swap `display: none` for `visibility: hidden` + `position: absolute` on non-current wrappers so xterm always measures a real container. Or: call `terminal.fitAddon.fit()` whenever a previously-hidden wrapper becomes visible (via a `ResizeObserver` on each wrapper, or imperatively in a `useEffect` keyed on `currentProjectPath`).

The reporter (Julian) explicitly does NOT want Slice 4 reverted — keep multi-project terminals mounted, just fix the rendering.

## Critical files touched

- `src/App.tsx` — `useTerminalManagement(currentProject?.path ?? null)`, `allSessions` in `terminalProps`, `handleCloseProject` calls `closeAllTerminalsForProject`, `beforeunload` calls `stopAllServers`.
- `src/hooks/useTerminalManagement.ts` — per-project Map, `allSessions`, `terminalRefsMap` string-keyed, idempotent `restoreTerminalTabs`.
- `src/hooks/useDevServer.ts` — per-path map, `stopAllServers`, `isServerRunning`, `getProjectType`.
- `src/hooks/useProjectLifecycle.ts` — always `setView('workspace')`, no teardown in `handleBackToProjects`, no `sessionRegistry.suspend`.
- `src/components/WorkspaceSidebar.tsx` — Pinned + Active groups, forced-open group containing current, per-row close button, keyed `current-body` / `inactive-body` wrappers.
- `src/components/WorkspaceView.tsx` — `allSessions.flatMap` terminal render, focus key is `${projectPath}::${activeTerminalTab}`.
- `src/styles/features/workspace/sidebar.css` — the aggressive `!important` layout rules.

## Test after fixing layout

1. Reload, confirm sidebar stacks vertically with Pinned group at top, Active below, no horizontal scrollbar.
2. Pin project A, open it. Claude Code spawns, type something visible.
3. Open project B from Home. Sidebar shows A (pinned, with green agent dot) + B (active). A's Claude terminal is still alive (xterm rendered but hidden, PTY running). `lsof -i :A_PORT` shows A's dev server running.
4. Click A in the sidebar. A's workspace reveals, your earlier typed text is still there. No reconnect.
5. Click X on A's sidebar row. A's dev server + Claude PTY both get reaped (`lsof` empties for A's port; `ps | grep claude` shows fewer).
6. B stays running throughout.

Once that works end-to-end, this feature ships.

## Known dead code (safe to clean later)

- The `view === 'project-loading'` branch in `App.tsx` is unreachable — no caller sets it. Left in place defensively.
- `switchTabAgent` removed from `WorkspaceView`'s destructure; still exported from the hook.
- `resetTerminals` exported from `useTerminalManagement` but no external caller uses it.
