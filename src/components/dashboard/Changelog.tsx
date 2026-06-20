/**
 * Changelog component that displays recent releases on the dashboard.
 * Users can click any version to rewind/downgrade to it.
 *
 * ⚠️  RELEASE CHECKLIST: Update the CHANGELOG array below when releasing!
 *     Add new version at the TOP with user-facing changes.
 *     Keep ~15 most recent versions.
 */

import { useState, useEffect, useCallback } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
import { WarningIcon } from '../icons';
import { trackEvent, trackError } from '../../lib/analytics';
import { installVersion } from '../../lib/updater';
import { Button } from '../primitives/Button';

interface ChangelogEntry {
  version: string;
  items: string[];
}

// Changelog data - update this with each release!
// Keep ~15 most recent versions for the sidebar
const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.10.0', // v0.10.0
    items: [
      'Workspaces — keep separate Claude, GitHub, and Codex logins for different clients or orgs, fully isolated. Each workspace has its own credentials, so the agent working in one project never sees another client\'s auth. Your existing setup becomes the "Default" workspace and is left completely untouched',
      "Per-project workspaces — assign any project to a workspace and its terminals, git, pull requests, and AI all use that workspace's logins automatically. Move a project between workspaces right from the dashboard",
      'Credential vault — store per-workspace tokens (Vercel, Figma, OpenAI) and a git identity securely in the macOS Keychain; secret values never leave the backend',
    ],
  },
  {
    version: '0.9.0', // v0.9.0
    items: [
      'Custom classes — a Webflow-style class system in the visual editor, native to Tailwind. Select an element, name a class, and its styles become a reusable rule; edit that class once and every element using it updates. Built on Tailwind @apply, so it stays in your source',
      "Apply, remove, and create — a searchable class picker lets you apply an existing class to an element, detach one, or create a new class from the element's current styles, with full keyboard navigation",
      'Edits stay scoped — editing a class only touches the element you selected, even when several elements share the same Tailwind classes, and the class control is fully responsive across breakpoints',
      'Safer by default — creating a class from styles never writes the kind of utility that would break your Tailwind build (markers like group/peer are kept on the element instead)',
    ],
  },
  {
    version: '0.8.2', // v0.8.2
    items: [
      'Live preview opens reliably on slower dev servers — projects on Next.js 16 / Turbopack that take a while to compile the first page no longer get stuck on "Stopped waiting"; the preview now rides the initial compile and opens once it\'s ready',
      "The pinned visual editor panel now scrolls — when an element has lots of style controls, the panel's contents scroll instead of running off the bottom of the screen",
    ],
  },
  {
    version: '0.8.1', // v0.8.1
    items: [
      'Start faster — an empty dashboard now greets you with a one-click "Create your first project" instead of a blank screen',
      'Organized template gallery — the create-project picker groups starters into Websites & web apps, Mobile apps, and Other, with a star marking the recommended pick in each',
      'Tidier workspace header — the branch and your open tabs now share a single row, and labels collapse gracefully on narrow windows so nothing gets cut off',
      'See when your agent is working — a subtle spinning dot on the project (and its tabs) in the sidebar shows an agent is thinking, visible at a glance without watching the terminal',
      'Static-site preview — plain HTML/CSS/JS projects that happen to have a package.json can now opt into instant static preview, and if a static preview fails to load, a one-click "Fix with AI" hand-off helps your agent sort it',
      'Smarter publishing — commit messages are now auto-written from your actual changes instead of a generic placeholder',
      'Stash-aware branch switching — switching branches now tells you in the toast when your stashed changes were restored',
      'Reliability — network commands (git, gh, agents) now time out instead of hanging the UI, dev-server port conflicts are cleared automatically, and PR-creation errors show a real message instead of "[object Object]"',
    ],
  },
  {
    version: '0.8.0', // v0.8.0
    items: [
      'Shopify themes — Ship Studio now builds Online Store 2.0 themes. Create one from the new Shopify Theme starter (or import any theme repo), connect your store through a guided setup right in the preview pane, and the preview renders real Liquid against your actual store — products, collections, the lot — with hot reload on every save',
      'Agent-first theme workflow — Cmd+K commands to build a new section with AI and push your theme to the store for review, plus a “Set up with AI” hand-off that has your agent install and authenticate the Shopify CLI for you. Visual edit mode works on rendered theme pages and saves classes back to your .liquid sections',
      'Replace images visually — select any image in edit mode (even a classless one) and the panel shows the current asset with a Replace button: pick from your assets folder (thumbnails + inline upload) and the new path is written straight into your source',
      'Dev server logs are now interactive — when a CLI asks a question (a login, a y/n confirm), click the logs and type your answer right there. The logs auto-follow new output and stay scrollable',
      'Clickable terminal links now survive line wraps — a URL split across lines highlights and opens as one link, including in agent output with indented continuations',
      'Importing a GitHub repo without a package.json (Flutter, Rust, plain HTML) no longer fails at the dependency step',
      'Security hardening — closed path-traversal, command-injection, and IPC trust gaps across backend commands',
      'Fixes — renaming a project no longer leaves the old name in open-project guards or shows “[object Object]” errors',
    ],
  },
  {
    version: '0.7.1', // v0.7.1
    items: [
      'Element tree — fullscreen edit mode now shows a Webflow-style navigator on the left: every element on the page as a collapsible tree. Click a row to select it (the edit panel picks it up instantly), hover to highlight it on the canvas, and selections stay in sync both ways. Toggle it from the toolbar',
      'Fullscreen preview — a new button next to refresh expands the preview to fill the window. Press Esc to exit. Combine it with edit mode for a full designer layout: elements | canvas | edit panel',
      'Pin the visual editor — a pin in the Edit panel docks it as a sidebar so it never covers your page, and the preview makes room. Works in fullscreen too, and the choice sticks across projects',
      'Mobile app starters — the create-project picker now offers Expo, React Native, and Flutter templates. Each opens straight into a live device preview with a polished starter screen and agent-ready instructions',
      'Choose your assets folder — the Assets panel can now point anywhere in your project (like src/assets for Astro image pipelines), per project, from a new picker in the breadcrumb bar. Copy-path adapts automatically',
      'Links in terminals are now clickable — URLs printed by dev servers, build logs, and agents open in your browser',
      'Polish — double-clicking the device mirror no longer selects the whole preview, matched toolbar icons, and the full-width breakpoint got its own icon',
    ],
  },
  {
    version: '0.7.0', // v0.7.0
    items: [
      'Mobile app previews — open a React Native, Expo, or Flutter project and the preview pane becomes a real, interactive device. Ship Studio boots an iOS Simulator or Android emulator for you, builds and launches your app onto it (with the build log streaming in), and mirrors the screen live so you can tap, swipe, and type right in the workspace',
      'Android runs on a low-latency scrcpy stream with the server bundled — no extra install needed. Projects that target both platforms get an iOS | Android picker in the preview toolbar',
      'No Xcode or Android SDK yet? A “Set up with AI” hand-off sends your agent a detailed install prompt instead of dead-ending you with manual steps. (Mobile previews are macOS-only for now)',
      'Multilingual sites — Cmd+K → “Languages” to add languages to any Next.js or Astro site. Search every language (not a preset list), pick a default, and Ship Studio edits your i18n config surgically — it never guesses, and unusual configs fall back to a “Fix with AI” hand-off instead of being overwritten',
      'One-click “Save & translate with AI” — review the exact translation prompt, then copy it or paste it straight into your agent’s terminal. App Router projects get a guided next-intl setup the same way',
      'Preview in any language — a globe switcher appears in the preview toolbar once you have 2+ languages, and switching pages keeps the language you’re viewing. Removing a language warns about leftover translated files and offers an AI cleanup prompt',
      'The preview toolbar’s “Open in Browser” button is now just “Open”',
    ],
  },
  {
    version: '0.6.8', // v0.6.8
    items: [
      'Inline text editing in the visual editor — double-click any text on the page to rewrite it right there, Webflow-style. Select text to make it bold, italic, or a link (with an inline URL field), and press Enter for a line break. Works the same on Next.js and Astro, saves straight to your source, and is free (0 tokens)',
      "When text is rendered from your code or data and can't be edited inline, the panel hands it off with a one-click “Copy request for your agent” — paste it into the terminal and tell the agent the new wording",
      "Clearer selection — the element you're actively editing is outlined in blue, while the other same-source elements an edit will also change are outlined in orange, so you can tell them apart at a glance",
      "Restarting the dev server no longer crashes Ship Studio — on some setups it was killing the app's own preview process along with the dev server",
      'The “Starting dev server…” screen is no longer a black box — Stop waiting instantly instead of sitting through 60 retries, read the live dev-server logs inline to see why it’s stuck, and hand it to your agent with “Fix with agent” (which sends the port and recent logs to the terminal)',
      'Branch cleanup after a merge now works for repos that auto-delete head branches on GitHub — the merged branch no longer lingers in your branch list',
    ],
  },
  {
    version: '0.6.7', // v0.6.7
    items: [
      "Visual editor now works on Astro + Tailwind sites — including pages built with your own custom CSS classes. Edits reliably win the cascade (using Tailwind's important modifier where needed) and save back to your `.astro` source. The editor only appears when Tailwind is actually wired into the project, so it never adds classes that wouldn't compile",
      'Smoother Astro editing — saving an edit no longer snaps the preview back to the top of the page; it stays where you were working (Next.js already updates in place via Fast Refresh)',
      "Clearer editor — before you select anything, a short intro explains what it does (works with any Next.js or Astro project on Tailwind, free, uses 0 tokens, updates live and saves instantly). A subtle hint flags when an element's custom CSS means edits are written with `!important`",
      'The toolbar Support button now opens the Ship Studio community Slack directly',
    ],
  },
  {
    version: '0.6.6', // v0.6.6
    items: [
      'Responsive breakpoint editing in the visual editor — pick a breakpoint (Base, sm, md, lg, xl, 2xl, or whatever your project defines) and the preview canvas resizes to match; edits write `md:`-style classes that preview truthfully across widths. Resizing the canvas updates the active breakpoint too, and a plain-language note explains the mobile-first cascade',
      'Far more properties, in collapsible sections — the panel is now organized into Size & Spacing, Layout, Typography, Backgrounds & Borders, Effects, and Custom CSS, adding width/height/max-width, position, flex direction & wrap, overflow, z-index, line height, letter spacing, text transform/style/decoration, shadow, blur, cursor, and border color',
      "Custom CSS box — type any `property: value` and it's written as a real Tailwind arbitrary-property class (e.g. `[clip-path:circle(50%)]`), validated as you type. The editor always prefers a named Tailwind token and only falls back to an arbitrary value when off-scale",
      'Works on Astro + Tailwind — the visual editor now resolves and edits classes in `.astro` templates, not just Next.js/React',
      "Free-form values, a floating Reset, and shared-component awareness — type exact lengths like `10rem` or `50%` in any field; click a set value's name for a floating Reset at your cursor; editing a shared component shows where else it's used across your project with click-through to the code, and ambiguous elements can be edited everywhere at once or one at a time",
      "Optional debounced auto-save writes edits to source as you go, and the preview iframe's default scrollbars are hidden (without touching the site's own custom scrollbars)",
    ],
  },
  {
    version: '0.6.5', // v0.6.5
    items: [
      'Visual editor (Beta) — toggle "Edit (Beta)" in the preview toolbar, then click any element to fine-tune its Tailwind classes visually: padding and margin (a Webflow-style box model you can drag to scrub or click to type), gap, text alignment, font size and weight, radius, display, flex justify/align, border, and opacity. Changes preview instantly and write back to your real source className when you hit "Save to source"',
      "Color editing with a real picker — set text and background colors with a HEX / RGB / HSL / OKLCH picker and an opacity slider; edits keep the element's existing color format (OKLCH stays OKLCH). The picker reads the element's current color even when it comes from a theme variable, and the properties panel can be dragged anywhere",
    ],
  },
  {
    version: '0.6.4', // v0.6.4
    items: [
      'Monorepo support — Ship Studio detects pnpm/npm workspaces when you import a repo (or first open an existing project) and asks which app to work on; the dev server, preview, and /public tools run inside that workspace while git and PRs stay at the repo root. "Use the whole repo" skips the picker',
      'Merge right after submitting for review — the Submit for Review window stays open after PR creation with an inline "Merge into main" action, conflict handoff ("Ask agent to fix" or "Resolve myself"), and a one-click post-merge branch-cleanup prompt',
      'One-click dependency install — projects with a missing node_modules now show an "Install with pnpm" prompt in the preview pane; click to stream the install in a terminal and the dev server starts automatically when it finishes',
      'Fixes — removing and re-adding a local folder re-prompts the workspace picker; fixed an install terminal that could relaunch itself every couple of seconds',
    ],
  },
  {
    version: '0.6.3', // v0.6.3
    items: [
      'Side-by-side agents — in focus mode with two or more agents on a project, toggle "Split" in the terminal toolbar to view them side by side. Drag the handle between panes to resize. Click a pane to make it the active one',
      'Open in Browser fix — Preview toolbar\'s "Open in Browser" now opens your real dev server URL (e.g. `localhost:3000`) instead of Ship Studio\'s internal proxy port',
      'Auto-accept on resume — resumed sessions now apply auto-accept mode correctly on startup; a race could previously cause it to silently turn off',
      'Sync dropdown polish — no longer shows the stale "All changes synced — Done" view after dismissing it without clicking Done',
      'Agent Settings dropdown stays on-screen in focus mode — previously the menu could be cut off on the right',
      'Modal header padding — Skills, MCP, Help, and Project Settings modals no longer have their first row of content touching the header border',
    ],
  },
  {
    version: '0.6.2', // v0.6.2
    items: [
      'Undo/Redo (⌘Z / ⌘⇧Z) — every burst of edits gets snapshotted as a git stash so you can roll the working tree back, even on work the agent never committed. Toast confirms "Undid 3 files: App.tsx, Preview.tsx +1 more". Buttons grey out at the edge of history. Native character-undo still wins inside text inputs',
      'Custom project thumbnails — upload your own via the project menu; auto-capture stops overwriting it',
      'Sidebar agent picker — replaced hover-to-open with an explicit caret next to "Add new agent" so the agent name doesn\'t shift when the cursor drifts past',
      'Skip broken Claude binaries — if a stale `claude` install is on the GUI PATH (e.g. an old `/opt/homebrew/bin/claude` from a legacy installer), Ship Studio now validates each candidate with `--version` and falls through to the next working install instead of surfacing the raw npm-wrapper error',
    ],
  },
  {
    version: '0.6.1', // v0.6.1
    items: [
      'Health tab in the Inspect panel — Code Health moved into the Inspect panel with a tab-native layout: status rows for Test / Lint / Types / Format and inline output for the selected check',
      'Open in Browser button — preview toolbar now has an "Open in Browser" button next to the breakpoint icons. Click to open the default browser, hover to pick a specific one (Safari, Chrome, Firefox, Arc, Brave, Edge)',
      'Dev server row shows the port — sidebar "Dev server" row now shows `localhost:3001` inline instead of a separate "running" badge',
      'Security hardening — CI now scans high-trust config files (eslint, vite, package.json, workflows) for obfuscated-payload signatures and runs with a read-only GITHUB_TOKEN scope by default',
    ],
  },
  {
    version: '0.6.0', // v0.6.0
    items: [
      'Cmd+K command palette — switch projects, open modals, run actions; Cmd+1..9 jumps to pinned projects',
      'Inspect panel under the preview — Server Logs + Browser Tools (Console, Network, Elements), each with a "Send to agent" button',
      'Focus tab — collapses the preview pane to give the agent terminal the full workspace',
      'Send-to-agent everywhere — server logs, code snippets, console/network entries, DOM trees, viewport dimensions',
      'Resizable preview — drag the right or bottom edge; iframe centers and frames as a floating panel',
      'Compact mode rebuilt — purpose-built narrow layout under 750px with always-on-top pin',
      'Header overhaul — labeled Agent Settings + Plugins dropdowns; non-hosting plugins now open inline',
      'Sidebar refinements — add-new-agent footer, hover-opens agent picker, Dev server row opens Inspect, current project collapses',
      'Underlined workspace tabs — cleaner tab style across workspace and breakpoint controls',
      'Live W × H readout in preview toolbar — click to send dimensions to your agent',
      'Security fix — HTML escaped in DOM-to-agent serializer',
    ],
  },
  {
    version: '0.5.1', // v0.5.1
    items: [
      'Fix terminal rendering corruption on some macOS betas — new "Terminal GPU acceleration" toggle in Settings → Preferences lets you fall back to the canvas renderer if agent output looks garbled or fragmented',
    ],
  },
  {
    version: '0.5.0', // v0.5.0
    items: [
      'Multi-project multitasking — run multiple projects at once with live agents and dev servers in each',
      'Sidebar overhaul — pinned + active project groups, attention indicators, drag-to-reorder, searchable "+" picker',
      'External dev-server death detection — status flips immediately when Next.js crashes or the port is killed',
      'Opencode agent — third agent option alongside Claude Code and Codex, managed from the dashboard',
      'Dashboard redesign — matching cards for Coding Agents, Preferences, and Integrations; "What\'s New" is a modal',
      'Workspace toolbar split — sidebar toggle on top row, Restart / project settings on the lower row',
      'Plugin crash isolation — a misbehaving plugin can no longer take down the app; crashes auto-remove with a toast',
      'Backups on non-git projects — Safe Backup Restore works on folders without git history',
      'Sentry error monitoring for frontend and backend',
      'Stability fixes — no more dropped async results under StrictMode, --no-pager on git subprocess calls, better frontend error typing',
    ],
  },
  {
    version: '0.4.25', // v0.4.25
    items: [
      'Pinned-projects sidebar — pin projects for quick switching, drag to reorder',
      '"+" button in sidebar to pin and open any project from a searchable picker',
      'Fixed crash when clicking back to projects (dev server no longer killed)',
      'Sidebar layout uses proper flex structure — no more overlapping with titlebar or toolbars',
      'Titlebar stays visible in compact mode for consistent navigation',
      'Fixed Vercel "multiple users" error by ensuring git identity before commits',
    ],
  },
  {
    version: '0.4.24',
    items: [
      'Community template gallery — browse, search, and download starter templates',
      'Learn Mode — renamed from Education Mode, now covers all dashboard and workspace elements',
      'Screenshot shortcuts (⌘⇧S / ⌘⇧C) now work even when the preview has focus',
      'Learn Mode uses agent-agnostic language — works with Claude Code, Codex, or any terminal agent',
      'Toolbar button text no longer wraps at narrow window sizes',
    ],
  },
  {
    version: '0.4.23',
    items: [
      'New "Add Clients" button — introduces the Client Editor for inline content editing',
      'Panel toggle button now visible when preview is hidden on all project types',
    ],
  },
  {
    version: '0.4.22',
    items: [
      'New "Blank Project" template — start from scratch with just a terminal',
      'Non-web projects default to Code tab instead of empty Preview',
      'Hide panel button now available on all project types',
      'Compact mode: toolbar buttons align with macOS traffic lights',
      'Dashboard buttons no longer overlap traffic lights at narrow widths',
    ],
  },
  {
    version: '0.4.21',
    items: [
      'Fixed terminal freeze when switching between tabs',
      'Fixed double-typing bug where each keystroke appeared twice',
      'New tabs now autofocus immediately — no need to click',
      'Failed project imports now show the actual error instead of just an exit code',
      'Built-in support panel for help and bug reports',
    ],
  },
  {
    version: '0.4.20',
    items: [
      'Fixed terminal hanging and "no output" errors with multiple tabs',
      'GPU-accelerated terminal rendering via WebGL',
      'Hidden tabs no longer consume CPU — output is buffered until you switch to them',
      'New tabs only start Claude Code when you switch to them',
      'Back-to-projects cleanup is fast and no longer freezes',
      'Tab name updates immediately when switching agents',
    ],
  },
  {
    version: '0.4.19',
    items: [
      'Fixed terminal resize when switching tabs — no more narrow text wrapping',
      'Smaller, consistent toolbar buttons matching workspace tab proportions',
      'Screenshot shortcuts: ⌘⇧S for capture, ⌘⇧C for crop mode',
      'Removed broken full page screenshot option',
      'Window dragging restricted to title bar only',
    ],
  },
  {
    version: '0.4.18',
    items: [
      'New overlay title bar — cleaner look with traffic lights inline',
      'Toolbar split into left (utilities) and right (hosting/GitHub/Publish)',
      'Vercel plugin now appears on the right side of the toolbar',
      'Drag to move window from title bar or toolbar empty space',
      'Double-click title bar to maximize/restore',
      'Slack community banner can be dismissed (eye icon or Settings)',
      'Terminal auto-focuses when switching tabs via ⌘1-5, ⌘T, or ⌘W',
      'Fixed session resume — stale sessions now reliably restart',
    ],
  },
  {
    version: '0.4.17',
    items: [
      'External projects no longer hit "forbidden path" errors when starting dev server',
      'Cmd+W closes the active terminal tab instead of quitting the app',
      'Cmd+Q now shows a quit confirmation dialog',
      'Dashboard UI cleanup — settings and new folder moved out of header',
      'Failed session resume now auto-starts a fresh Claude Code session',
    ],
  },
  {
    version: '0.4.16',
    items: [
      'Terminal sessions now persist — reopen a project and your conversations resume',
      'New terminal tab dropdown with ⌘T shortcut and agent switching',
      'File search in the Code tab sidebar',
      'Keyboard shortcuts ⌘1-5 to switch terminal tabs',
      'Cleanup status shown when closing projects',
      'Fixed terminal resize issues when switching tabs',
    ],
  },
  {
    version: '0.4.15',
    items: ['Plugin errors no longer crash the entire app'],
  },
  {
    version: '0.4.14',
    items: ['Fixed rapid project switching causing app to hang', 'Faster port cleanup on macOS'],
  },
  {
    version: '0.4.13',
    items: [
      'Fixed 100% CPU spike when navigating back from workspace',
      'Replaced broad CSS transitions with specific properties for better performance',
    ],
  },
  {
    version: '0.4.12',
    items: [
      'Fixed scrollbar engine causing 100% CPU on the dashboard',
      'Fixed "What\'s New" sidebar layout on the projects page',
      'Smoother hover animations on project and folder cards',
    ],
  },
  {
    version: '0.4.11',
    items: [
      'Major performance improvements — reduced CPU and energy usage',
      'Branch changes from Claude Code now reflected instantly',
      'Screenshot capture pauses when window is in background',
      'Fixed resource leaks in terminals, timers, and file watchers',
    ],
  },
  {
    version: '0.4.10',
    items: [
      'Project Settings modal for dev server port and command',
      'Cleaner toolbar with icon-only restart and settings cog',
    ],
  },
  {
    version: '0.4.9',
    items: [
      'Confirmation modals for PR pull, merge, and close actions',
      'Reduced CPU usage with smarter polling and caching',
      'Preview polling pauses when window is hidden',
      'Faster branch list loading (batched git operations)',
      'Fixed AI generate button overlap during generation',
    ],
  },
  {
    version: '0.4.8',
    items: [
      'Pull & close actions for pull requests',
      '"You are here" indicator on checked-out PR',
      'Dev server auto-restarts after PR checkout',
      'Fixed scrollbar crash on component unmount',
      'Fixed toast bubbles stretching to widest sibling',
    ],
  },
  {
    version: '0.4.7',
    items: [
      'Custom dark scrollbars with OverlayScrollbars',
      'Redesigned plugin manager cards with icon previews',
      'Fixed skills search and installation errors',
    ],
  },
  {
    version: '0.4.6',
    items: [
      'Code browser with syntax highlighting and file tree',
      '"Copy to agent" sends selected code directly to the terminal',
    ],
  },
  {
    version: '0.4.5',
    items: [
      'Compact template dropdown with "Set as default" option',
      'Search filtering in Plugin Manager',
      'Custom dev commands for generic projects',
      'Vercel plugin pre-installed for new projects',
      'Plugins now react to GitHub repo changes without restart',
    ],
  },
  {
    version: '0.4.4',
    items: ['Fixed settings toggle color to use green', 'Improved terminal content layout'],
  },
  {
    version: '0.4.3',
    items: ['Moved bug report button to the workspace toolbar'],
  },
  {
    version: '0.4.2',
    items: ['Hide activity calendar from dashboard via Settings or inline button'],
  },
  {
    version: '0.4.1',
    items: [
      'MCP Server Manager for adding custom tool servers',
      'Terminal tabs highlight green when waiting for user input',
      'Instant search in installed skills tab',
      '"View PR" navigates to PRs tab instead of opening GitHub',
      'Sync success shows hint to create a PR on feature branches',
      'PR number shown next to title in PRs tab',
    ],
  },
  {
    version: '0.4.0',
    items: [
      'Plugin system - install extensions from the Plugin Library',
      'Multi-agent support - choose Claude Code or Codex',
      'New onboarding wizard with step-by-step setup',
      'Vercel & Sanity CMS moved to plugins',
      'Toolbar dropdown menu and terminal tab menu',
    ],
  },
  {
    version: '0.3.53',
    items: [
      'HTML/CSS/JS project support - no framework needed',
      'Live reload for static HTML projects',
      'New HTML/CSS/JS starter template',
    ],
  },
  {
    version: '0.3.52',
    items: ['Terminal loading indicator while Claude Code starts up'],
  },
  {
    version: '0.3.51',
    items: ['Import repos you collaborate on (not just owned)', 'Fix dev server restart crashes'],
  },
  {
    version: '0.3.50',
    items: [
      'Fix npm cache permission errors during setup',
      'Slack community banner on welcome screen',
    ],
  },
  {
    version: '0.3.49',
    items: [
      'Import local folders as projects',
      'Link existing Vercel projects',
      'Vercel project list shows all projects (pagination)',
    ],
  },
  {
    version: '0.3.48',
    items: [
      'Nuxt/Vue support - new Nuxt Basic template',
      'Page selector tracks in-iframe navigation',
      'Faster onboarding with batched installs',
      'Better onboarding error messages',
    ],
  },
  {
    version: '0.3.47',
    items: [
      'Dashboard changelog sidebar',
      'GitHub contribution calendar',
      'Better Vercel CLI error messages',
      'Improved dashboard header styling',
    ],
  },
  {
    version: '0.3.46',
    items: [
      'Safe Backup Restore - creates branch for PR review',
      'Clickable project path opens in Finder',
      'Astro page selector support',
    ],
  },
  {
    version: '0.3.45',
    items: ['Astro support - new Astro Basic template'],
  },
  {
    version: '0.3.44',
    items: ['Vercel site URLs dropdown on hover', 'Slack community CTA'],
  },
  {
    version: '0.3.43',
    items: ['Fixed Vercel CLI detection for nvm'],
  },
  {
    version: '0.3.42',
    items: ['Skills Manager - install Claude skills', 'Help & Commands modal'],
  },
  {
    version: '0.3.41',
    items: ['Education Mode - learn UI elements'],
  },
  {
    version: '0.3.37',
    items: ['Terminal Focus Indicator', 'Notification Sounds'],
  },
  {
    version: '0.3.36',
    items: ['Responsive breakpoints', 'Fixed viewport screenshots'],
  },
  {
    version: '0.3.33',
    items: ['Export project as template'],
  },
  {
    version: '0.3.32',
    items: ['Preview breakpoints - 5 responsive sizes'],
  },
  {
    version: '0.3.28',
    items: ['Resizable preview panel', 'Global search in folders'],
  },
  {
    version: '0.3.25',
    items: ['File diff viewer'],
  },
];

type RewindStage = 'confirm' | 'downloading' | 'installing' | 'done' | 'error';

interface ChangelogProps {
  className?: string;
}

export function Changelog({ className = '' }: ChangelogProps) {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [rewindVersion, setRewindVersion] = useState<string | null>(null);
  const [rewindStage, setRewindStage] = useState<RewindStage>('confirm');
  const [rewindError, setRewindError] = useState<string | null>(null);

  useEffect(() => {
    void getVersion().then(setCurrentVersion);
  }, []);

  // Listen for progress events from the backend
  useEffect(() => {
    const unlisten = listen<{ stage: string }>('rewind-progress', (event) => {
      const stage = event.payload.stage;
      if (stage === 'downloading' || stage === 'installing' || stage === 'done') {
        setRewindStage(stage);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const handleRewind = useCallback(async () => {
    if (!rewindVersion) return;
    void trackEvent('version_rewind_started', {
      target_version: rewindVersion,
      $screen_name: 'Dashboard',
    });
    setRewindStage('downloading');
    setRewindError(null);

    try {
      await installVersion(rewindVersion);
      void trackEvent('version_rewind_completed', {
        target_version: rewindVersion,
        $screen_name: 'Dashboard',
      });
      setRewindStage('done');
    } catch (err: unknown) {
      trackError('version_rewind', err, 'Dashboard');
      setRewindStage('error');
      setRewindError(err instanceof Error ? err.message : String(err));
    }
  }, [rewindVersion]);

  const handleRestart = useCallback(async () => {
    try {
      await relaunch();
    } catch (err) {
      trackError('app_restart', err, 'Dashboard');
      setRewindError('Failed to restart. Please restart manually.');
    }
  }, []);

  const closeModal = () => {
    setRewindVersion(null);
    setRewindStage('confirm');
    setRewindError(null);
  };

  const isWorking = rewindStage === 'downloading' || rewindStage === 'installing';

  return (
    <div className={`changelog ${className}`} data-education-id="changelog-sidebar">
      <div className="changelog-header">
        <h3>What's New</h3>
        <span className="changelog-subtitle">Recent updates</span>
      </div>
      <div className="changelog-list">
        {CHANGELOG.map((entry) => {
          const isCurrent = currentVersion === entry.version;
          return (
            <div key={entry.version} className="changelog-entry">
              <div className="changelog-entry-header">
                {isCurrent ? (
                  <span className="changelog-version">
                    v{entry.version}
                    <span className="changelog-current-badge">current</span>
                  </span>
                ) : (
                  <button
                    className="changelog-version changelog-version-link"
                    onClick={() => setRewindVersion(entry.version)}
                  >
                    v{entry.version}
                  </button>
                )}
              </div>
              <ul className="changelog-items">
                {entry.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Rewind confirmation modal */}
      {rewindVersion && (
        <div className="rewind-modal" onClick={() => !isWorking && closeModal()}>
          <div className="rewind-content" onClick={(e) => e.stopPropagation()}>
            <div className="rewind-header">
              <WarningIcon size={18} />
              <h3>
                {rewindStage === 'confirm' && `Install v${rewindVersion}?`}
                {rewindStage === 'downloading' && 'Downloading...'}
                {rewindStage === 'installing' && 'Installing...'}
                {rewindStage === 'done' && 'Ready to restart'}
                {rewindStage === 'error' && 'Installation failed'}
              </h3>
            </div>
            <div className="rewind-body">
              {rewindStage === 'confirm' && (
                <p>
                  This will replace your current version
                  {currentVersion && <> (v{currentVersion})</>} with{' '}
                  <strong>v{rewindVersion}</strong>. The app will restart afterward.
                </p>
              )}
              {rewindStage === 'downloading' && (
                <>
                  <p>Downloading v{rewindVersion}...</p>
                  <div className="rewind-progress">
                    <div className="rewind-progress-bar rewind-progress-indeterminate" />
                  </div>
                </>
              )}
              {rewindStage === 'installing' && (
                <>
                  <p>Installing v{rewindVersion}...</p>
                  <div className="rewind-progress">
                    <div className="rewind-progress-bar rewind-progress-indeterminate" />
                  </div>
                </>
              )}
              {rewindStage === 'done' && (
                <p>v{rewindVersion} has been installed. Restart to use it.</p>
              )}
              {rewindStage === 'error' && <p className="rewind-error-text">{rewindError}</p>}
            </div>
            <div className="rewind-actions">
              {rewindStage === 'confirm' && (
                <>
                  <Button variant="secondary" onClick={closeModal}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => void handleRewind()}>
                    Install
                  </Button>
                </>
              )}
              {isWorking && (
                <Button variant="secondary" disabled>
                  Please wait...
                </Button>
              )}
              {rewindStage === 'done' && (
                <Button variant="primary" onClick={() => void handleRestart()}>
                  Restart Now
                </Button>
              )}
              {rewindStage === 'error' && (
                <>
                  <Button variant="secondary" onClick={closeModal}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => void handleRewind()}>
                    Retry
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
