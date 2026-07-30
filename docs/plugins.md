# Building Ship Studio Plugins

Ship Studio plugins are small ES modules that render React components into
well-defined slots of the app (workspace toolbar, preview, terminal dropdown,
dashboard sidebar) and talk to the app through a sandboxed context: toasts,
project info, plugin-scoped storage, shell commands in the project directory,
and an allow-listed set of Tauri commands.

A plugin is just a git repo (or local folder) with two required files:

```
my-plugin/
├── plugin.json      # manifest (repo root)
└── dist/index.js    # prebuilt ES module bundle
```

No build happens at install time — `dist/index.js` must be committed prebuilt.

The fastest way to see a working plugin is the in-repo example at
[`test-plugins/hello-world/`](../test-plugins/hello-world/): a hand-written
manifest + bundle with no build step at all.

## The manifest: `plugin.json`

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "description": "A test plugin that validates the Ship Studio plugin pipeline.",
  "slots": ["toolbar"],
  "author": "Ship Studio",
  "repository": "",
  "setup": [],
  "min_app_version": "0.1.0",
  "icon": "",
  "api_version": 1
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | ✅ | Unique id; becomes the on-disk directory name. No `/`, `\`, `..`, or leading `.` |
| `name` | ✅ | Display name shown in the Plugin Manager |
| `version` | ✅ | Your plugin's semver, shown as `v{version}` |
| `description` | ✅ | One-line description |
| `slots` | | Slot names this plugin renders into (see [Slots](#slots)) |
| `author` | | Shown next to the version |
| `repository` | | Informational |
| `min_app_version` | | Strict semver (`"0.18.0"`, not `"v0.18"`). Install/link fails if the app is older; empty = no gate |
| `api_version` | | Plugin API version. Current: `1` (`0` = legacy). Unsupported versions install but are skipped at load with an explanatory error |
| `required_commands` | | Tauri commands your plugin may call through `invoke.call()` (see [Invoke proxy](#invoke-allow-listed-tauri-commands)). Install fails if you request one outside the allow-list |
| `setup` | | Reserved for future use — accepted but ignored (logs a warning) |
| `icon` | | Reserved — not currently rendered; the toolbar slot component doubles as the icon |

## The entry point: `dist/index.js`

The bundle is loaded as a Blob-URL ES module (10s import timeout) and must be
fully self-contained — no bare imports left at runtime. The module contract:

```js
export const name = 'My Plugin';            // optional, falls back to id
export const slots = {                      // slot name -> React component
  toolbar: MyToolbarButton,
};
export function onActivate() {}             // optional, after successful load
export function onDeactivate() {}           // optional, on unload
```

**Do not bundle React.** The app exposes its own copy on
`window.__SHIPSTUDIO_REACT__` / `window.__SHIPSTUDIO_REACT_DOM__`; mark
`react` and `react-dom` as externals that resolve to those globals. Bundling a
second React is the #1 cause of plugin crashes.

Example esbuild setup:

```bash
esbuild src/index.tsx --bundle --format=esm --outfile=dist/index.js \
  --external:react --external:react-dom \
  --banner:js="const React = window.__SHIPSTUDIO_REACT__;"
```

(With the SDK you rarely need `react-dom`; hooks and `React.createElement`
come through the same global.)

## Slots

`slots` keys are matched against `<PluginSlot name="…">` mount points in the
app. Available today:

| Slot | Where it renders |
|---|---|
| `toolbar` | Workspace header (hosting plugins: `vercel`, `cloudflare`, `netlify`) or the Plugins dropdown (everything else); also used as the plugin's icon in the manager grid |
| `publish` | Workspace header, left of the Publish button |
| `preview` | Preview pane chrome |
| `terminal` | The terminal toolbar dropdown |
| `sidebar` | Dashboard (projects view) sidebar |

Slot components receive **no props** — all data comes from the plugin context
(below). Each plugin renders inside its own error boundary: a crash shows an
error chip and disables the plugin for the session (never uninstalls it), so
a broken plugin can't take the workspace down.

## The SDK: `@shipstudio/plugin-sdk`

The SDK lives in this repo at [`packages/plugin-sdk/`](../packages/plugin-sdk/)
(source-only package, React 19 peer dep). It wraps the runtime context in typed
hooks and ships themed UI components so plugins match the app without any CSS.

```tsx
import {
  useProject, useShell, useToast, usePluginStorage,
  useAppActions, useTheme, useInvoke,
  Button, Input, Select, Modal, Spinner, Badge, Stack, Text,
} from '@shipstudio/plugin-sdk';

function MyToolbarButton() {
  const project = useProject();       // { name, path, currentBranch, hasUncommittedChanges, devServerUrl? } | null
  const toast = useToast();           // (message, type?: 'success' | 'error') => void
  const shell = useShell();           // { exec(command, args, { timeout? }) }
  const storage = usePluginStorage(); // { read(), write(data) }
  const actions = useAppActions();    // showToast, refreshGitStatus, refreshBranches, focusTerminal, openUrl
  const invoke = useInvoke();         // { call(command, args?) } — gated by required_commands

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={async () => {
        const res = await shell.exec('npx', ['--version'], { timeout: 30 });
        toast(`npx ${res.stdout.trim()}`, 'success');
      }}
    >
      Check npx
    </Button>
  );
}

export const slots = { toolbar: MyToolbarButton };
```

### Runtime capabilities

- **`storage.read()` / `storage.write(data)`** — a plugin-scoped JSON blob at
  `{project}/.shipstudio/plugins/{id}/storage.json`. Whole-object semantics:
  read, merge, write. Writes are mutex-guarded per plugin.
- **`shell.exec(command, args, { timeout? })`** — runs a binary in the project
  directory with the app's extended PATH. Default timeout 120s. Returns
  `{ stdout, stderr, exit_code }`. A missing binary fails with a clear error
  naming your plugin and the command.
- **`actions`** — `showToast(msg, type?)`, `refreshGitStatus()`,
  `refreshBranches()`, `focusTerminal()`, `openUrl(url)`.
- **`theme`** — 14 color values as `var(--…)` strings (`bgPrimary`,
  `textPrimary`, `accent`, `action`, `error`, …) safe to use in inline styles;
  they track the app theme automatically.
- Every async capability toasts the error before re-throwing, so failures are
  never silent.

All backend calls use the current project's path — capabilities that touch the
project fail when no project is open (`useProject()` returns `null` on the
dashboard, so gate on it).

### `invoke`: allow-listed Tauri commands

`invoke.call(command, args?)` may only call commands you declared in
`required_commands`, which themselves must be within the app's plugin
allow-list:

```
check_git_has_changes, get_changed_files, get_file_diff, get_branch_status,
list_branches, get_current_branch, get_stash_info,
list_projects, list_pages, read_project_metadata,
get_branch_prefix_preference, get_auto_accept_mode,
commit_changes, create_branch, switch_branch, fetch_all_branches, git_pull,
check_ide_availability, open_in_ide, open_url_in_browser,
create_preview_webview, resize_preview_webview, destroy_preview_webview,
navigate_preview_webview,
read_plugin_storage, write_plugin_storage, read_plugin_manifest
```

Declaring anything outside this list fails the install; calling anything you
didn't declare rejects at runtime.

Like `shell` and `storage`, `invoke.call` automatically fills in the current
project's `projectPath`, so project-scoped commands work without passing it:

```ts
const branch = await invoke.call<string>('get_current_branch');
// equivalent to invoke.call('get_current_branch', { projectPath: project.path })
```

Pass `projectPath` explicitly in `args` only to target a *different* project —
an explicit value always wins over the injected one.

### Without the SDK

Raw-JS plugins (like hello-world) can use the window globals directly:
`window.__SHIPSTUDIO_REACT__` for React and
`window.__SHIPSTUDIO_PLUGINS__[pluginId]` for the context value.

## Styling

Prefer the SDK components — they're themed via inline styles and need no CSS.
If you render your own elements, these classes and variables are **plugin-stable
API** (defined in `src/styles/global/base.css`, see
[docs/design-system.md](design-system.md)):

- `toolbar-icon-btn` — icon button matching the workspace toolbar chrome
- `btn-primary`, `btn-secondary` — standard action buttons
- CSS variables: `--bg-primary/secondary/tertiary`, `--text-primary/secondary/muted`,
  `--border`, `--accent`, `--action`, `--success`, `--warning`, `--error`,
  `--font-mono`, `--radius`, …

## Developing a plugin locally

1. Create a folder with `plugin.json` and a built `dist/index.js`.
2. In Ship Studio: **Plugins → Link Dev Plugin** and pick the folder. Linking
   validates the manifest and requires `dist/index.js` to exist ("Did you run
   the build?").
3. Iterate: rebuild your bundle, then hit **Reload** on the plugin row — the
   bundle is re-read from your folder (dev plugins load live from the linked
   path, nothing is copied).
4. **Unlink** removes it from the project's registry without touching your
   files.

Dev plugins are per-project; the plugin registry and installed files live at
`{project}/.shipstudio/plugins/` (shared across git worktrees of the same
repo).

## Distributing a plugin

**Install from URL** (Plugins → Install from URL) accepts a git URL
(`https://`, `git://`, `ssh://`, or `git@…`) and does a `--depth 1` clone.
Requirements:

- `plugin.json` at the **repo root**
- committed `dist/index.js`
- the clone is used as-is: nothing is built, `.git` is stripped, the HEAD
  commit is recorded for update checks

**Updates**: the manager compares your repo's remote HEAD against the
installed commit (`git ls-remote`) and offers a re-clone.

**Plugin library**: the in-app library is driven by
[`ship-studio/plugin-registry`](https://github.com/ship-studio/plugin-registry)
(`registry.json` with `{ id, name, description, repo, author, category }`
entries). Open a PR there to list your plugin. The
[Vercel plugin](https://github.com/ship-studio/plugin-vercel) is a full
real-world reference.

## Walkthrough: hello-world

[`test-plugins/hello-world/`](../test-plugins/hello-world/) is the minimal
end-to-end example — a manifest (shown above) plus this bundle, written by
hand with no build step:

```js
const React = window.__SHIPSTUDIO_REACT__;

function HelloWorldButton() {
  const ctx = window.__SHIPSTUDIO_PLUGIN_CONTEXT__;
  return React.createElement(
    'button',
    {
      className: 'toolbar-icon-btn',
      title: 'Hello World Plugin',
      onClick: () => ctx.actions.showToast('Hello from plugin!', 'success'),
    },
    'HW'
  );
}

export const name = 'Hello World';
export const slots = { toolbar: HelloWorldButton };
export function onActivate() { console.log('[hello-world] activated'); }
export function onDeactivate() { console.log('[hello-world] deactivated'); }
```

Link it via **Plugins → Link Dev Plugin**, and a "HW" button appears in the
Plugins dropdown; clicking it fires a toast through the plugin context.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `No plugin.json found` on install | Manifest isn't at the repo root |
| `Plugin bundle not found at …/dist/index.js` | You didn't commit/build the bundle |
| `Requires plugin API v…` at load | `api_version` outside the app's supported set (`0`, `1`) |
| `Plugin '{name}' requires Ship Studio v…` | `min_app_version` newer than the running app |
| `…requests commands that are not available to plugins` | `required_commands` includes something outside the allow-list |
| Plugin crashes instantly / hooks error | You bundled your own React — externalize it |
| `"…" crashed — disabled for this session` chip | Your component threw; fix and re-enable from Plugins |
