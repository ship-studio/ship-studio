# Release Notes

<!--
Maintainers: update this file before every release.
The latest entry is rendered inside the in-app update dialog, so write user-
facing language — what changed, in plain English — not commit subjects.
-->

## What's New in v0.12.0

- **Cursor CLI agent** - Cursor joins Claude Code, Codex, and Opencode as a built-in AI agent. Install it during setup, sign in, run `cursor-agent` in your workspace terminal, and set it as your default agent.
- **Visual editor now works with Vite** - Point-and-click style editing works on Vite + React + Tailwind projects, not just Next.js, Astro, and Shopify.
- **Restart an agent terminal** - If your coding agent exits, restart it right in place instead of opening a new tab.
- **First-run terminal hint** - A fresh agent terminal shows a short hint about what to do, until you start typing.
- **Smoother onboarding** - Clearer setup wizard copy and more accurate tool detection. On Windows, Node.js now installs reliably during setup.
- **Fixes** - A macOS 12 launch crash, GitHub showing as disconnected when a second account had an invalid token, and the Cmd+K "port" search now points to Project settings.


## What's New in v0.11.2

- **Create a branch with unsaved work** - Creating a branch while you have uncommitted changes no longer errors out. You now get a choice: commit them on your current branch first, or stash them aside — then the new branch is created and switched to.
- **Clearer Git errors** - Errors in the Branches tab now show the real message instead of "[object Object]".


## What's New in v0.11.1

- **GitHub connect fix** - Fixed a loop where connecting GitHub would authenticate in the browser (GitHub showed connected) but the button stayed grey and kept re-prompting. Hit Windows users especially, plus some Macs. Your default workspace now finds your existing GitHub login wherever it actually lives.


## What's New in v0.11.0

- **Visual editing for plain CSS projects** - Point-and-click style editing now works on vanilla HTML/CSS and plain Astro sites, not just Tailwind. Select any element and edit its real CSS rule; the change applies to every element that shares the class.
- **Edit by class, state, and breakpoint** - Choose which of an element's classes you're styling, target states like :hover, and edit responsive @media layers, all from the panel.
- **Visual or code** - Flip any rule between the structured controls and a real code editor with syntax highlighting, then save straight back to your stylesheet.
- **New plain HTML/CSS starter** - Spin up a no-framework project in one click.
- **Faster and safer** - Element selection is snappier on large projects, and editing no longer crashes on pages that contain emoji or accented text.


## What's New in v0.10.0

- **Workspaces** - Keep separate Claude, GitHub, and Codex logins for different clients or orgs, fully isolated. Each workspace has its own credentials, so an agent working in one project never sees another's auth. Your existing setup becomes the "Default" workspace, untouched. Assign any project to a workspace — its terminals, git, PRs, and AI all use that workspace's logins automatically — and move projects between workspaces right from the dashboard.
- **Credential vault** - Store a per-workspace Vercel token, Anthropic base URL, and git identity securely in the macOS Keychain. Secret values never leave the backend.
- **Choose your projects folder** - Point Ship Studio at any folder (like an existing ~/Dev directory) instead of ~/ShipStudio, globally or per workspace, and optionally move your existing projects across.
- **Windows fixes** - The Code tab no longer shows a garbled file list, and "Install Claude Code" now installs from the terminal instead of opening a browser. Setup terminals also remind you that a typed password stays hidden even though nothing appears.


## What's New in v0.9.0

- **Custom classes** - A Webflow-style, Tailwind-native class system in the visual editor: create a reusable class from an element's styles, apply or remove classes, and edit a class once to update every element using it.


## What's New in v0.8.2

- **Preview reliability** - Live preview now opens reliably on slow-compiling dev servers (Next.js 16 / Turbopack) instead of getting stuck on "Stopped waiting". **Edit panel scroll** - The pinned visual editor panel now scrolls when its content is tall.


## What's New in v0.8.1

- **Start faster** - An empty dashboard now offers a one-click "Create your first project" instead of a blank screen
- **Organized template gallery** - The create-project picker groups starters into Websites & web apps, Mobile apps, and Other, with a star marking the recommended pick
- **Tidier workspace header** - The branch and your open tabs share a single row, and labels collapse gracefully on narrow windows
- **See your agent working** - A subtle spinning dot on the sidebar project and its tabs shows when an agent is thinking, without watching the terminal
- **Static-site preview** - Plain HTML/JS projects with a package.json can opt into instant static preview, with a one-click "Fix with AI" hand-off if it fails to load
- **Smarter publishing** - Commit messages are auto-written from your actual changes instead of a generic placeholder
- **Stash-aware branch switching** - The toast now tells you when your stashed changes were restored on switch
- **Reliability** - Network commands (git, gh, agents) time out instead of hanging the UI, dev-server port conflicts auto-clear, and PR errors show real messages instead of "[object Object]"


## What's New in v0.8.0

- **Shopify themes** - Build Online Store 2.0 themes: create from the new starter or import any theme repo, connect your store through a guided setup, and preview real Liquid rendered against your actual store with hot reload. Cmd+K commands build sections with AI and push your theme for review; visual edit mode works on .liquid sections
- **Replace images visually** - Select any image in edit mode and swap it from your assets folder; the new path is written straight into source
- **Interactive dev server logs** - Answer CLI prompts (logins, y/n confirms) by clicking the logs and typing; logs auto-follow new output and stay scrollable
- **Wrapped terminal links fixed** - URLs split across lines now highlight and open as one link
- **Import any repo** - GitHub repos without a package.json (Flutter, Rust, plain HTML) no longer fail at the dependency step
- **Security hardening** - Closed path-traversal, command-injection, and IPC trust gaps across backend commands
- **Fixes** - Project rename no longer breaks open-project guards or shows malformed errors


## What's New in v0.7.1

- **Element tree** - Fullscreen edit mode gains a Webflow-style navigator: every element on the page as a collapsible tree. Click to select (the edit panel picks it up instantly), hover to highlight, and selection stays in sync both ways. Toggle it from the toolbar
- **Fullscreen preview** - A new button next to refresh expands the preview to fill the window (Esc exits). Combine with edit mode for a full designer layout: elements | canvas | edit panel
- **Pin the visual editor** - A pin in the Edit panel docks it as a sidebar so it never covers your page. Works in fullscreen too, and the choice sticks across projects
- **Mobile app starters** - The create-project picker now offers Expo, React Native, and Flutter templates, each opening straight into a live device preview
- **Choose your assets folder** - The Assets panel can point anywhere in your project (like src/assets for Astro), per project, from a picker in the breadcrumb bar
- **Clickable terminal links** - URLs printed by dev servers, build logs, and agents now open in your browser
- **Polish** - Double-clicking the device mirror no longer selects the preview, matched toolbar icons, and a distinct full-width breakpoint icon


## What's New in v0.7.0

- **Mobile app previews** - Open a React Native, Expo, or Flutter project and the preview pane becomes a real, interactive device. Ship Studio boots an iOS Simulator or Android emulator, builds and launches your app onto it (build log streams in), and mirrors the screen live — tap, swipe, and type right in the workspace. macOS only for now.
- **Android, no setup required** - Android runs on a low-latency scrcpy stream with the server bundled. Projects targeting both platforms get an iOS | Android picker in the preview toolbar.
- **Set up with AI** - Missing Xcode or the Android SDK? A one-click hand-off sends your agent a detailed install prompt instead of dead-ending you with manual steps.
- **Multilingual sites** - Cmd+K → "Languages" to add languages to any Next.js or Astro site. Search every language, pick a default, and Ship Studio edits your i18n config surgically — it never guesses, and unusual configs fall back to a "Fix with AI" hand-off instead of being overwritten.
- **Translate with AI** - "Save & translate with AI" shows you the exact translation prompt to review, then copies or pastes it straight into your agent terminal. App Router projects get a guided next-intl setup the same way.
- **Preview in any language** - A globe switcher appears in the preview toolbar once you have 2+ languages, and switching pages keeps the language you are viewing. Removing a language warns about leftover translated files and offers an AI cleanup prompt.
- **"Open in Browser" is now "Open"** - Same button, shorter label.


## What's New in v0.6.8

- **Inline text editing in the visual editor** - Double-click any text on the page to rewrite it right there, Webflow-style. Select text to make it bold, italic, or a link, and press Enter for a line break. Works the same on Next.js and Astro, saves to your source, and is free (0 tokens).
- **Dynamic text → agent hand-off** - When text comes from your code or data and can't be edited inline, the panel gives you a one-click "Copy request for your agent" to paste into the terminal.
- **Clearer selection** - The element you're editing is outlined in blue; other same-source elements an edit will also change are outlined in orange.
- **Fix: dev server restart no longer crashes the app** - Restarting the dev server was killing Ship Studio's own preview (WebKit) process on some setups.
- **Dev server wait screen is no longer a black box** - Stop waiting instantly, read live dev-server logs inline, or hand the stuck server to your agent with "Fix with agent".
- **Fix: branch cleanup after merge** - Merged branches now delete correctly even when GitHub auto-deletes the head branch.


## What's New in v0.6.7

- **Visual editor works on Astro + Tailwind** - Edit pages built with custom CSS classes too; edits win the cascade and save to your .astro source. The editor only appears when Tailwind is actually set up in the project
- **Smoother Astro editing** - Saving no longer snaps the preview back to the top of the page
- **Clearer editor** - An intro explains what it does before you select anything (Next.js/Astro + Tailwind, free, 0 tokens, live + instant saves)
- **Support button opens Slack** - The toolbar Support button now opens the Ship Studio community Slack directly


## What's New in v0.6.6

- **Responsive breakpoint editing** - Edit Tailwind classes per breakpoint in the visual editor; the preview canvas resizes to match and edits preview truthfully across widths
- **Many more controls + Custom CSS** - Collapsible sections covering size, layout, typography, borders, and effects, plus a custom box that turns any `property: value` into a real Tailwind arbitrary-property class
- **Astro support** - The visual editor now works on Astro + Tailwind sites, not just Next.js/React
- **Free-form values, floating Reset & shared-component scope** - Type exact lengths in any field, reset a value from a floating button at your cursor, and see where a shared component is used with click-through to the source
- **Auto-save toggle & hidden preview scrollbars**


## What's New in v0.6.5

- **Visual editor (Beta)** - Toggle "Edit (Beta)" in the preview to click any element and fine-tune its Tailwind classes visually — padding/margin (drag-to-scrub box model), gap, alignment, size, weight, radius, display, flex, border, and opacity — with instant live preview and one-click Save to source.
- **Color picker** - Edit text/background colors with a HEX/RGB/HSL/OKLCH picker and opacity slider; edits keep the element's existing color format (OKLCH stays OKLCH).


## What's New in v0.6.4

- **Monorepo support** — Ship Studio now detects pnpm/npm workspaces when you import a repo (or first open an existing project) and asks which app you want to work on. The dev server, preview, and `/public` asset tools all run inside that workspace, while git and PRs stay at the repo root. Choose "Use the whole repo" to skip the picker.
- **Merge right after submitting for review** — After you create a PR, the Submit for Review window stays open with an inline "Merge into main" action. If there are conflicts you can hand them to the agent ("Ask agent to fix") or resolve them yourself, and once it's merged you get a one-click branch-cleanup prompt.
- **One-click dependency install** — Open a project whose `node_modules` is missing and the preview pane shows an "Install with pnpm" prompt instead of a blank screen. Click it to stream the install in a terminal; the dev server starts automatically when it finishes.
- **Fixes** — Removing and re-adding a local folder now re-prompts the workspace picker, and fixed a bug where the dependency-install terminal could relaunch itself every couple of seconds.


## What's New in v0.6.3

- **Side-by-side agents** — in focus mode with two or more agents on a project, toggle "Split" in the terminal toolbar to view them side by side. Drag the handle between panes to resize. Click a pane to make it the active one.
- **Open in Browser** now opens your real dev server URL (e.g. `localhost:3000`) instead of Ship Studio's internal proxy port.
- **Auto-accept on resume** — resumed sessions now apply auto-accept mode correctly on startup; a race could previously cause it to silently turn off.
- **Sync dropdown polish** — no longer shows the stale "All changes synced — Done" view after dismissing it without clicking Done.
- **Agent Settings dropdown** stays on-screen in focus mode (previously cut off on the right).
- **Modal headers** — Skills, MCP, Help, and Project Settings modals no longer have their first row of content touching the header border.


## What's New in v0.6.2

- **Undo/Redo (⌘Z / ⌘⇧Z)** — every burst of edits gets snapshotted as a git stash so you can roll the working tree back, even on changes the agent never committed. Toast confirms "Undid 3 files: App.tsx, Preview.tsx +1 more". Buttons grey out at the edge of history. Native character-undo still wins inside text inputs.
- **Custom project thumbnails** — upload your own thumbnail via the project menu; auto-capture stops overwriting it.
- **Sidebar agent picker** — replaced the hover-to-open behaviour with an explicit caret button next to "Add new agent" so the agent name no longer shifts when the cursor drifts past.
- **Skip broken Claude binaries** — if a stale `claude` install is on the GUI PATH (e.g. an old `/opt/homebrew/bin/claude` from a legacy installer), Ship Studio now validates each candidate with `--version` and falls through to the next working install instead of surfacing the raw npm-wrapper error.


## What's New in v0.6.1

- **Health tab in the Inspect panel** — Code Health moved into the Inspect panel with a tab-native layout: status rows for Test / Lint / Types / Format and inline output for the selected check.
- **Open in Browser button** — Preview toolbar now has an "Open in Browser" button next to the breakpoint icons. Click to open the default browser, hover to pick a specific one (Safari, Chrome, Firefox, Arc, Brave, Edge).
- **Dev server row shows the port** — Sidebar "Dev server" row now shows `localhost:3001` inline instead of a separate "running" badge.
- **Security hardening** — CI now scans high-trust config files (eslint, vite, package.json, workflows) for obfuscated-payload signatures and runs with a read-only GITHUB_TOKEN scope by default.


## What's New in v0.6.0

- **Cmd+K command palette** — Press ⌘K anywhere to switch projects, open modals, or run actions. Cmd+1..9 jumps to pinned projects. The workspace header is slimmer because IDE picker, env editor, backups, plugin manager, and Learn Mode toggle all live in the palette now.
- **Inspect panel** — New collapsible panel under the preview with **Server Logs** (dev server output) and **Browser Tools** (Console, Network, Elements from the live preview). Each tab has a "Send to agent" button so you can pipe runtime errors, network requests, or DOM trees straight into your coding agent.
- **Focus tab** — New workspace tab between Preview and Code that hides the preview pane and gives the agent terminal the full workspace — for when you're running your own browser alongside.
- **Send-to-agent everywhere** — Server logs, code snippets, console/network entries, DOM trees, and even the live viewport dimensions all have buttons or drag-to-select that pipe context into the active agent's prompt.
- **Resizable preview** — Drag the right or bottom edge of the preview to resize freely. The iframe centers and frames as a floating panel when both dimensions are custom. "Full" breakpoint resets back to fill.
- **Compact mode rebuild** — Narrow windows (under 750px) now use a purpose-built layout — terminal plus agent/project switcher and an always-on-top pin in the topbar — instead of squeezing the full workspace down. Open-in-browser dropdown moved to the sidebar Dev server row.
- **Header overhaul** — Agent Settings and Plugins each have a proper labeled dropdown. Plugins dropdown now actually opens non-hosting plugins (Webflow, Figma, etc.) instead of just dumping you into the Plugin Manager. Restart-dev-server moved into the sidebar.
- **Sidebar refinements** — Add-new-agent footer, hover-opens-picker on the agent "+" button, click the Dev server row to jump straight to Inspect → Server Logs, and you can finally collapse the current project with its chevron.
- **Underlined workspace tabs** — Preview / Code / Branches / PRs and the breakpoint controls switched from button-style backgrounds to a cleaner underline treatment.
- **Live W × H readout** — Preview toolbar shows the iframe's current pixel dimensions; click it to send the size to your agent.
- **Security fix** — HTML in page text and attributes is now escaped before being sent to the agent.


## What's New in v0.5.1

- **Fixed garbled terminal output on some macOS betas** — new "Terminal GPU acceleration" toggle in Settings → Preferences lets you fall back to the canvas renderer if agent output looks fragmented or corrupted


## What's New in v0.5.0

- **Multi-project multitasking** — Run multiple projects at once with live Claude Code / Codex / Opencode sessions and dev servers in each. Switching projects is instant — nothing tears down until you explicitly close it.
- **Sidebar overhaul** — Pinned and active project groups, attention indicators when a background terminal needs your input, searchable "+" picker to pin any project, drag-to-reorder, and proper scroll behavior.
- **External dev-server death detection** — Sidebar status flips immediately if Next.js crashes or the port is killed from elsewhere; no more stale "running" indicators.
- **Opencode agent** — Third coding agent option alongside Claude Code and Codex, managed from a new Coding Agents panel on the dashboard with install / sign-in / set-default controls.
- **Dashboard redesign** — Coding Agents, Preferences, and Integrations live in matching cards for a cleaner stack. "What's New" is a modal now, not an inline sidebar.
- **Workspace toolbar split** — Sidebar toggle stays up top; Restart dev server and project settings moved to the lower toolbar for tighter grouping.
- **Plugin crash isolation** — A misbehaving plugin can no longer take down the whole app. Plugins that crash are auto-removed with a toast so you can keep working.
- **Backups on non-git projects** — Safe backup restore now works on folders without git history.
- **Error monitoring** — Frontend and backend errors are now reported to Sentry so hangs and crashes get diagnosed faster.
- **Stability fixes** — No more dropped async results under React StrictMode, `--no-pager` on git subprocess calls (was hanging on large repos), and better error discrimination on the frontend.


## What's New in v0.4.25

- **Pinned-projects sidebar** — Pin projects for quick switching with drag-to-reorder, searchable picker, and proper flex layout


## What's New in v0.4.25

- **Pinned-projects sidebar** — Pin projects for quick switching with drag-to-reorder, searchable picker, and proper flex layout


## What's New in v0.4.24

- **Community template gallery** — browse, search, and download starter templates
- **Learn Mode** — renamed from Education Mode, now covers all dashboard and workspace elements
- **Screenshot shortcuts fixed** — ⌘⇧S and ⌘⇧C now work even when preview iframe has focus
- **Agent-agnostic language** — Learn Mode works with Claude Code, Codex, or any terminal agent
- **Toolbar buttons** no longer wrap text at narrow window sizes


## What's New in v0.4.23

- **Client Editor** — New "Add Clients" button in the toolbar introduces the inline Client Editor for your clients
- **Panel toggle** — Show/hide panel button now visible on all project types


## What's New in v0.4.22

- **Blank Project template** — start from scratch with just a terminal
- **Non-web projects** — default to Code tab, hide panel button always available
- **Compact mode** — toolbar buttons align with macOS traffic lights
- **Dashboard** — buttons no longer overlap traffic lights at narrow widths


## What's New in v0.4.21

- **Fixed terminal freeze** — Switching tabs no longer kills terminal input
- **Fixed double-typing** — Each keystroke now registers once, not twice
- **New tab autofocus** — Cmd+T creates a tab that's immediately ready for input
- **Better error messages** — Failed project imports show actual error output instead of cryptic exit codes
- **Support panel** — Built-in help and bug reporting


## What's New in v0.4.20

- **Fixed terminal stability** — No more hangs, freezes, or 'no output' errors with multiple tabs
- **GPU-accelerated terminal** — WebGL rendering for smoother output
- **Smarter tab management** — Hidden tabs don't consume CPU; new tabs start on demand
- **Faster project switching** — Back-to-projects cleanup no longer freezes


## What's New in v0.4.19

- **Fixed terminal resize** — No more narrow text wrapping when switching tabs
- **Smaller toolbar buttons** — Consistent sizing across all toolbar actions
- **Screenshot shortcuts** — ⌘⇧S for capture, ⌘⇧C for crop mode
- **Removed broken full page screenshot**


## What's New in v0.4.18

- **Overlay title bar** - Cleaner look with traffic lights inline, drag-to-move, and double-click to maximize
- **Toolbar redesign** - Split into left (utilities) and right (hosting/GitHub/Publish) sides
- **Dismissible Slack banner** - Hide via eye icon or Settings toggle
- **Terminal focus fix** - Auto-focuses when switching tabs via keyboard shortcuts
- **Session resume fix** - Stale sessions now reliably auto-restart


## What's New in v0.4.17

- **External project support** — Projects outside ~/ShipStudio no longer show forbidden path errors
- **Cmd+W closes tab** — Closes the active terminal tab instead of quitting the app
- **Cmd+Q confirmation** — Shows a quit confirmation dialog before exiting
- **Dashboard UI cleanup** — Settings and new folder moved to more logical locations
- **Session resume fix** — Failed session resume now auto-starts a fresh Claude Code session


## What's New in v0.4.16

- **Terminal session persistence** — Conversations resume when reopening projects
- **Terminal tab dropdown** — Compact dropdown with ⌘T shortcut and agent switching
- **File search** — Search files by name in the Code tab sidebar
- **Keyboard shortcuts** — ⌘1-5 to switch tabs
- **Stability** — Fixed PTY cleanup hangs, added startup logging, cleanup status indicator


## What's New in v0.4.16

- **Terminal session persistence** — Reopen a project and your Claude Code conversations automatically resume where you left off, with each tab restoring independently
- **Terminal tab dropdown** — Tabs redesigned as a compact dropdown selector with agent switching, close buttons, and attention indicators all in one place
- **File search in Code tab** — Filter the file tree by name with a search bar in the Code browser sidebar
- **Keyboard shortcuts** — ⌘T to open a new terminal tab, ⌘1-5 to switch between tabs
- **Cleanup status indicator** — See what's happening when closing a project instead of staring at a spinner
- **Terminal stability** — Fixed PTY cleanup hanging the UI, added startup timeout logging, and improved error handling for failed sessions
- **External project support** — Projects outside ~/ShipStudio no longer show forbidden path errors on reopen
- **Back button redesign** — Styled consistently with other toolbar buttons

## What's New in v0.4.15

- **Plugin crash isolation** - Plugin errors no longer crash the entire app


## What's New in v0.4.14

- **Fixed rapid project switching** - Clicking back then immediately opening another project no longer hangs
- **Faster port cleanup** - Port detection on macOS is now significantly faster with timeout protection

## What's New in v0.4.13

- **Fixed 100% CPU on back-navigation** - Resolved tauri-pty infinite read loop that caused permanent CPU spike when navigating from workspace back to projects
- **CSS transition performance** - Replaced broad `transition: all` with specific properties across 28 stylesheets

## What's New in v0.4.12

- **Dashboard performance fix** — Fixed scrollbar engine causing 100% CPU usage on the projects page
- **Layout fix** — Fixed What's New sidebar being pushed below project cards
- **Smoother animations** — Hover effects on project and folder cards are now buttery smooth

## What's New in v0.4.11

- **Performance** - Major reduction in CPU and energy usage via React memoization, background git fetch, and polling optimizations
- **Instant feedback** - Branch changes from Claude Code now reflected in UI within seconds
- **Resource leaks** - Fixed leaked timers, event listeners, and file watcher threads in long-running sessions
- **UI** - Prevent Create Repo button text wrapping


## What's New in v0.4.10

- **Project Settings modal** - New settings modal accessible via the cog icon in the toolbar for configuring dev server port and command
- **Cleaner toolbar** - Restart button is now icon-only with a settings cog button added to the toolbar


## What's New in v0.4.9

- **PR confirmation modals** - Pull, merge, and close actions now show confirmation dialogs explaining what will happen
- **Performance improvements** - Reduced CPU usage with smarter polling, cached PATH resolution, and batched git operations
- **Background pausing** - Preview health checks and page list polling pause when the window is hidden
- **Faster branch list** - Branch ahead/behind counts now load in a single operation instead of one per branch
- **Fixed AI generate button** - "Generating..." state no longer shows the previous button behind it
- **Removed ~460 lines of dead code** - Cleaned up unused functions and imports


## What's New in v0.4.8

- **PR checkout & close** - Pull and close pull requests directly from the app
- **Checkout indicator** - See which PR branch you're currently on
- **Auto-restart dev server** - Dev server restarts after checking out a PR
- **Scrollbar crash fix** - Fixed removeChild crash from OverlayScrollbars DOM relocation
- **Toast layout fix** - Toast notifications no longer stretch to widest sibling


## What's New in v0.4.7

- **Custom scrollbars** - Dark themed OverlayScrollbars replace native scrollbars throughout the app
- **Plugin manager redesign** - Cards now show toolbar icon previews with cleaner layout
- **Skills fixes** - Fixed search result parsing (install counts no longer duplicated) and installation error handling


## What's New in v0.4.6

- **Code browser** - Browse project files with syntax highlighting and a collapsible file tree
- **Copy to agent** - Select lines in the code viewer and send them directly to the active terminal

## What's New in v0.4.5

- **Compact template selector** - Replaced template card grid with a dropdown, plus a "Set as default" option
- **Plugin Manager search** - Filter plugins by name in the Plugin Manager modal
- **Custom dev commands** - Configure custom dev server commands for generic projects
- **Vercel plugin pre-installed** - Built-in templates now come with the Vercel plugin ready to go
- **Plugin reactivity** - Plugins now detect GitHub repo changes without needing a restart


## What's New in v0.4.4

- **Settings toggle fix** - Toggle now uses green instead of white
- **Terminal layout** - Improved padding and border for terminal content

## What's New in v0.4.3

- **Bug report button** - Moved from floating overlay to workspace toolbar

## What's New in v0.4.2

- **Activity calendar toggle** - Hide the GitHub contribution calendar from the dashboard via Settings or the inline eye icon

## What's New in v0.4.1

- **MCP Server Manager** - Add and manage custom MCP tool servers
- **Terminal input indicator** - Tabs highlight green when waiting for user input
- **Instant search** - Search installed skills quickly
- **PR navigation** - View PR button navigates to PRs tab; sync success prompts to create PR on feature branches
- **PR numbers** - Show PR number next to title in PRs tab


## What's New in v0.4.0

- **Plugin system** - Install and manage extensions from the Plugin Library
- **Multi-agent support** - Choose between Claude Code and Codex as your AI agent
- **New onboarding wizard** - Step-by-step guided setup with auto-advance
- **Vercel & Sanity CMS** - Moved to plugins (install from Plugin Library)
- **Toolbar & terminal menus** - Cleaner workspace chrome with dropdown menus


## What's New in v0.3.53

- **HTML/CSS/JS support** - Create and preview plain HTML projects (no framework needed)
- **Live reload** - Preview auto-refreshes when files change in static HTML projects
- **HTML starter template** - New HTML/CSS/JS template option in project creation

## What's New in v0.3.52

- **Terminal loading indicator** - Terminal now shows a loading message while Claude Code starts up instead of a blank screen

## What's New in v0.3.51

- **Import collaborator repos** - Import repos you're a collaborator on, not just repos you own
- **Fix restart crashes** - Dev server restart no longer crashes the app


## What's New in v0.3.50

- **Fixed npm cache permissions** - Setup now detects and fixes npm cache permission errors
- **Slack community banner** - Added banner to welcome screen


## What's New in v0.3.49

- **Import local folders** - Open existing projects from anywhere on your computer via the new Import picker
- **Link existing Vercel projects** - Connect to an existing Vercel project instead of only creating new ones
- **Full Vercel project list** - Project selector now shows all your Vercel projects (previously limited to 20)


## What's New in v0.3.48

- **Nuxt/Vue support** - New Nuxt Basic template for project creation
- **Page selector tracks navigation** - Page selector now updates when navigating within the preview iframe (all frameworks)
- **Faster onboarding** - Batched Homebrew installs and better error messages


## What's New in v0.3.47

- **Dashboard changelog sidebar** - See What's New on the dashboard
- **GitHub contribution calendar** - Shows your GitHub activity
- **Better Vercel CLI error messages** - Clearer error codes and messages
- **Improved dashboard styling** - Consistent button spacing and borders


## What's New in v0.3.46

- **Safe Backup Restore** - Restoring a backup now creates a new branch for review via PR instead of pushing directly
- **UI Polish** - Standardized toolbar icons, fixed spinner wobble, colored domain badges
- **Education Mode** - Added backups button to education mode


## What's New in v0.3.45

- **Astro support** - Added Astro Basic template for creating new projects


## What's New in v0.3.44

- **Vercel site URLs dropdown** — Hover over the Vercel button to quickly access production and preview URLs
- **Slack community CTA** — Join our community to suggest features and shape the future of Ship Studio
- **Compact mode improvements** — Main branch warning banner now fits better in compact mode


## What's New in v0.3.43

- **Fixed Vercel CLI detection for nvm installations** - Vercel CLI was not being detected for users who installed it via nvm at paths like ~/.nvm/versions/node/v22.x.x/bin/vercel


## What's New in v0.3.42

- **Skills Manager** - Install and manage Claude skills directly from Ship Studio. Click the lightning bolt icon to browse installed skills, search for new ones, and install/remove them with one click.
- **Help & Commands** - New help modal showing all Claude slash commands, your installed skills, keyboard shortcuts, and example prompts. Click the question mark icon in the terminal header.
- **Improved Terminal Header** - Server, Health, and Notification buttons are now icon-only for a cleaner look. Hover for tooltips.
- **Better Integration Status** - GitHub and Vercel CLI status checks now have timeout handling with graceful fallbacks
- **UI Polish** - Compact mode publish button improvements, card-based styling in Help modal, click-to-expand skills with +/- indicators

## What's New in v0.3.41

- **Education Mode** - Click the graduation cap button to learn what each UI element does. Hover over any part of the app to see beginner-friendly tooltips explaining its purpose.
- **Fix** - Update banner no longer overlaps dashboard content


## What's New in v0.3.40

- **Compact mode button repositioned** - Moved to left of Open in Browser for better discoverability, now visible when preview is hidden


## What's New in v0.3.39

- **Updated onboarding colors** - Changed to softer mint green to match brand

## What's New in v0.3.38

- **Fixed onboarding delay** - Claude Code install no longer shows 15-20 second delay with blank terminal

## What's New in v0.3.37

- **Terminal Focus Indicator** - Terminal now dims and goes grayscale when unfocused for clearer visual feedback
- **Notification Sounds** - Play sounds when Claude finishes and needs your input, with 5 presets or custom sound upload
- **Error Recovery** - App-wide error boundary with restart button for crash recovery
- **Responsive UI** - Fixed main branch banner and notification modal on narrow windows


## What's New in v0.3.36

- **Responsive breakpoints** - Breakpoint options now hide when they don't fit in the preview viewport
- **Cleaner UI** - Hide workspace tabs (Preview/Branches/PRs) when GitHub not connected
- **Fixed viewport screenshots** - Screenshots now capture actual visible content
- **Fixed dev server retry** - Retry button on error screen now works correctly


## What's New in v0.3.35

- **Image Preview** - Clicking on untracked image files in the Unsaved Changes dropdown now shows an image preview instead of an error

## What's New in v0.3.34

- **Improved page selector styling** - Selected page now uses a subtle highlight with accent bar instead of jarring white background

## What's New in v0.3.33

- **Export project as template** - Save any project as a reusable template zip file
- **Fixed update banner** - Release notes now display correctly for all releases

## What's New in v0.3.32

- **Added preview breakpoints** - Now includes 5 responsive breakpoints: Full (100%), Desktop (1440px), Laptop (1024px), Tablet (768px), and Mobile (375px)

## What's New in v0.3.31

- **Fixed Vercel domain display** - Projects with team scopes or personal accounts now properly show their live site URLs in the publish dropdown

## What's New in v0.3.30

- **Improved publish dropdown UI** - Wider dropdown with compact badges for better URL visibility

## What's New in v0.3.29

- **Template zip import** - Create projects from downloaded template zip files via drag-and-drop or file picker
- **Dev server timeout handling** - Prevents UI hangs when restarting dev server
- **Dashboard UI consistency** - Header buttons now match editor styling


## What's New in v0.3.28

- **Resizable preview** - Drag the handle to resize the preview panel and test responsive breakpoints
- **Compact health panel** - Health checks now live in the toolbar, click to expand details
- **Global search** - Search finds projects inside folders, not just root level
- **Cleaner workspace** - Reorganized toolbar layout, screenshot buttons centered in preview bar
- **Dashboard polish** - Shorter header elements, bolder buttons, Next.js pre-selected
- **Fixed screenshot memory leak** - Playwright browser processes now properly close

## What's New in v0.3.27

- **IntegrationBar Connect buttons** - Added Connect buttons to the integrations dropdown for GitHub and Vercel accounts

## What's New in v0.3.26

- **Optional GitHub/Vercel auth** - Users can now start projects without GitHub or Vercel accounts during onboarding. Features requiring these services show a 'Connect' overlay when accessed.

## What's New in v0.3.25

- **File diff viewer** - Click any file in the unsaved changes dropdown to see what changed

## What's New in v0.3.24

- **Fixed Discard All button** - Replaced window.confirm() with two-click confirmation pattern since native dialogs don't work in Tauri WebView

## What's New in v0.3.23

- **Paste .env** - Added bulk paste feature to Environment Variables modal for quickly importing multiple variables at once

## What's New in v0.3.22

- **Faster app launch** - Returning users now see projects instantly (~10ms) instead of waiting 2-5 seconds for setup checks

## What's New in v0.3.21

- **SvelteKit support** - Create new projects with the SvelteKit Basic template, auto-detection for existing SvelteKit projects, route scanning, and svelte-check integration


## What's New in v0.3.20

- **Main branch warning preference** - Added 'Don't show again' checkbox to dismiss the warning permanently for a project, with a toggle in the project menu to re-enable it

## What's New in v0.3.19

- **Faster project opening** - Deferred GitHub/Vercel status checks to background so workspace loads immediately

## What's New in v0.3.18

- **Folders** - Organize projects into folders on dashboard
- **Yolo Mode** - Auto-accept mode toggle for Claude per project
- **UI Polish** - Health toolbar height fixes, breadcrumb navigation improvements


## What's New in v0.3.17

- **Save button in Unsaved Changes dropdown** - Added a Save button that opens the Publish dropdown, making it clearer how to save uncommitted changes

## What's New in v0.3.16

- **Clear cache on server restart** - Restart Server now clears .next and other cache directories for a fresh build

## What's New in v0.3.15

- **Restart Dev Server** - Added a button to restart the dev server without leaving the project. Shows a loading overlay on the preview while restarting.

## What's New in v0.3.14

- **Improved preview stability** - Added tolerance for temporary dev server slowdowns during health checks to prevent false crash detection

## What's New in v0.3.13

- **Browser picker** - Hover over 'Open in Browser' to choose a specific browser (Chrome, Safari, Firefox, Arc, Brave, Edge)
- **Deep links** - Added shipstudio:// URL scheme support

## What's New in v0.3.12

- **sccache test** - Verifying Rust compilation cache

## What's New in v0.3.11

- **Added sccache** - Rust compilation caching for faster builds

## What's New in v0.3.10

- **Cache verification** - Testing CI cache restoration

## What's New in v0.3.9

- **Simplified CI caching** - Use setup-node built-in pnpm cache

## What's New in v0.3.8

- **Cache test 2** - Testing CI cache hit

## What's New in v0.3.7

- **Test release** - Verifying CI caching improvements

## What's New in v0.3.6

- **Faster CI releases** - Added pnpm and Rust dependency caching to reduce build times

## What's New in v0.3.5

- **Bug Report Button** - Floating, draggable button on all screens to report bugs via Loom video or description
- **Main Branch Warning** - Orange branch indicator and dismissible banner when editing main/master directly
- **Documentation** - Comprehensive CLAUDE.md update with all features, commands, and workflows


## What's New in v0.3.4

- **AI Pull Request Generation** - Generate PR titles and descriptions automatically using Claude CLI from the Submit for Review modal

## What's New in v0.3.3

- **Internal release** — auto-update pipeline testing.

## What's New in v0.3.2

- **Internal release** — auto-update pipeline testing.

## What's New in v0.3.1

- **Apple notarization** - App is now signed and notarized by Apple, eliminating "unverified developer" warnings on install
- **DMG downloads** - Release now includes DMG installers for both Apple Silicon and Intel Macs

## What's New in v0.3.0

- **Fixed terminal font rendering** - Terminal now correctly displays JetBrains Mono Nerd Font in production builds (was falling back to system font)

## What's New in v0.2.9

- **Hide/Show Preview panel** - Collapse the preview to focus on the terminal, with quick access buttons to restore it
- **Dev Server Logs tab** - View your Next.js dev server output in a dedicated Logs tab
- **Open in Browser button** - Quickly open your preview in a full browser window
- **Improved preview panel layout** - Tabs and actions are now grouped on the right for a cleaner look
- **Claude Desktop app support** - Now detects Claude Code installed via the Claude desktop app
- **Performance improvements** - Better memory management and cleanup of background processes

## What's New in v0.2.8

- **Fixed Claude Account detection** - Now correctly detects Claude authentication for newer Claude Code versions (fixed all code paths)

## What's New in v0.2.6

- **Update banner on setup screen** - Users stuck on the setup screen will now see update notifications

## What's New in v0.2.5

- **Fixed Claude Code detection** - Now correctly detects Claude Code installed via the new official installer (`~/.local/bin/claude`)

## What's New in v0.2.4

- **View unsaved changes on hover** - Hover over the branch indicator to see a list of all unsaved files with their change status (modified/added/deleted)
- **Quick discard option** - Discard all changes directly from the branch indicator dropdown

## What's New in v0.2.3

- **Import projects from GitHub** - Import existing repositories directly from your GitHub account or organizations
- **Ship Studio preview detection** - Sites can now detect when running in Ship Studio preview via `?shipstudio=1` query parameter (useful for disabling iframe detection)
- **Better Vercel detection for imported projects** - Imported projects with existing Vercel config are now correctly detected as connected
- **Fixed branch author display** - Branch cards no longer show misleading author info for newly created branches

## What's New in v0.2.1

- **Redesigned update banner** - Cleaner UI that matches the app theme, shows release notes, with "Update Now" and "Later" options
- **Better update error messages** - Shows detailed error info when updates fail

## What's New in v0.2.0

- **Shift+Enter for line breaks** - Use Shift+Enter to add new lines in the terminal without submitting
- **Fixed deployment status for teams** - Deployment status now works correctly for Vercel team projects

## What's New in v0.1.9

- Improved auto-updater reliability with public releases infrastructure
