# Release Notes

<!--
IMPORTANT FOR CLAUDE: This file MUST be updated before EVERY release.
These notes appear in the update dialog that users see when a new version is available.
Write clear, user-friendly notes about what changed in this version.
-->

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
- **Dev server timeout handling** - Prevents UI hangs when restarting dev server (thanks Tyler!)
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

- **Fixed bug X** - Tyler is testing the auto update

## What's New in v0.3.2

- **Test update** - Testing the auto-update flow

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
