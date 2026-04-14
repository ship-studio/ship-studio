# Contributing to Ship Studio

Thanks for your interest in contributing to Ship Studio! This guide will help you get started.

## Development Setup

### Prerequisites

- **Node.js** (v18+) and **pnpm**
- **Rust** (latest stable) - install via [rustup.rs](https://rustup.rs/)
- **Xcode Command Line Tools** (macOS): `xcode-select --install`

### Getting Started

```bash
# Clone the repo
git clone https://github.com/ship-studio/ship-studio.git
cd ship-studio

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

This starts both the Vite dev server (frontend) and Tauri app (backend).

## Project Architecture

```
src/                        # React frontend (TypeScript)
├── components/             # UI components (~55 files)
│   └── setup/              # Onboarding wizard components
├── lib/                    # Tauri command wrappers (~30 modules)
├── hooks/                  # Custom React hooks
├── styles/                 # CSS files
└── App.tsx                 # Main app component & state

src-tauri/                  # Rust backend
├── src/
│   ├── lib.rs              # App setup & command registration
│   ├── state.rs            # Shared application state
│   ├── types.rs            # Type definitions
│   ├── utils.rs            # Path validation, helpers
│   ├── cache.rs            # TTL-based git caching
│   └── commands/           # Modular command handlers
│       ├── git/            # Git operations (branches, status, stash, sync)
│       ├── projects/       # Project CRUD (detection, metadata, templates)
│       ├── setup/          # Onboarding (auth, install, status checks)
│       ├── plugins/        # Plugin lifecycle & storage
│       ├── ide/            # IDE launch & screenshot capture
│       ├── github.rs       # GitHub CLI integration
│       ├── pty.rs          # Pseudo-terminal management
│       ├── publishing.rs   # Vercel deployment workflow
│       ├── conflicts.rs    # Merge conflict resolution
│       ├── ai.rs           # AI-powered PR generation
│       ├── assets.rs       # /public folder file management
│       ├── env.rs          # Environment variable management
│       └── ...             # ~25 modules total
├── Cargo.toml              # Rust dependencies
└── tauri.conf.json         # Tauri configuration
```

### Key Technologies

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite |
| Backend | Rust, Tauri 2 |
| Terminal | xterm.js + tauri-pty |
| Styling | CSS Variables (dark theme) |

## Code Style

### TypeScript

- Use functional components with hooks
- Add JSDoc comments to exported functions and interfaces
- Use TypeScript strict mode (already configured)
- Prefer `const` over `let`

```typescript
/**
 * Brief description of what this does.
 * @param projectPath - Absolute path to the project
 * @returns Description of return value
 */
export async function myFunction(projectPath: string): Promise<Result> {
  // Implementation
}
```

### Rust

- Use `///` doc comments on public functions
- Follow Rust naming conventions (snake_case for functions, PascalCase for types)
- Validate all paths using `validate_project_path()` for security

```rust
/// Brief description of what this command does.
///
/// # Arguments
/// * `project_path` - Absolute path to the project directory
#[tauri::command]
async fn my_command(project_path: String) -> Result<String, String> {
    let path = validate_project_path(&project_path)?;
    // Implementation
}
```

### CSS

- Use CSS variables defined in `src/styles/base.css`
- Follow BEM-like naming: `.component-name`, `.component-name-element`
- Keep styles scoped to components

## Making Changes

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `refactor/description` - Code improvements
- `docs/description` - Documentation updates

### Commit Messages

Use clear, descriptive commit messages:

```
Add screenshot capture for project thumbnails

- Implement headless Chrome screenshot capture
- Add fallback for missing browsers
- Store thumbnails in .shipstudio/thumbnail.png
```

### Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with clear commits
3. Test locally with `pnpm tauri dev`
4. Build successfully with `pnpm tauri build`
5. Submit PR with description of changes

## Common Development Tasks

### Adding a New Tauri Command

1. Add the command function in the appropriate module under `src-tauri/src/commands/`. For example, to add a git-related command, edit `src-tauri/src/commands/git/mod.rs` (or create a new submodule). For a new domain, create a new file in `src-tauri/src/commands/`:
```rust
#[tauri::command]
pub async fn my_new_command(arg: String) -> Result<String, String> {
    // Implementation
}
```

2. Export the command from `src-tauri/src/commands/mod.rs` and register it in the handler in `src-tauri/src/lib.rs`:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    commands::my_module::my_new_command,
])
```

3. Create a TypeScript wrapper in `src/lib/`:
```typescript
export async function myNewCommand(arg: string): Promise<string> {
  return invoke<string>("my_new_command", { arg });
}
```

### Adding a New Component

1. Create the component file in `src/components/`
2. Add JSDoc module comment at the top
3. Export from the file
4. Add styles to `src/styles/` (component-specific or in existing files)

### Adding New Styles

CSS variables are defined in `src/styles/base.css`:

```css
:root {
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --text-primary: #cccccc;
  --accent: #ffffff;
  /* ... */
}
```

Use these variables in your styles for consistency.

## Testing

### Automated Tests

**Frontend Tests (Vitest + React Testing Library):**
```bash
npm test              # Run all tests
npm run test:ui       # Run with interactive UI
npm run test:coverage # Run with coverage report
```

Tests are in `src/**/*.test.{ts,tsx}`. We use the official `@tauri-apps/api/mocks` module for mocking Tauri IPC calls.

**Backend Tests (Rust):**
```bash
cd src-tauri && cargo test
```

Unit tests are colocated in source files using `#[cfg(test)]` modules.

### Manual Testing Checklist

Before submitting a PR, verify:

- [ ] All automated tests pass (`npm test && cd src-tauri && cargo test`)
- [ ] App launches without errors
- [ ] Can create a new project
- [ ] Terminal works and responds to input
- [ ] Preview loads and shows the dev server
- [ ] GitHub integration works (if you have `gh` installed)
- [ ] No console errors in DevTools

### Testing Onboarding

Onboarding is the first thing every new user sees. See the detailed testing guide in `CLAUDE.md` under "Onboarding / Setup Wizard Testing". Quick reference:

```bash
# Force onboarding with REAL system checks (recommended for UI testing)
SHIPSTUDIO_FORCE_ONBOARDING=1 pnpm tauri dev

# Force onboarding with MOCK states (for testing specific incomplete scenarios)
SHIPSTUDIO_FORCE_SETUP=fresh pnpm tauri dev        # Nothing installed
SHIPSTUDIO_FORCE_SETUP=auth-only pnpm tauri dev     # Tools installed, no auth
SHIPSTUDIO_FORCE_SETUP=almost-done pnpm tauri dev   # Only gh_auth missing
```

For the real end-to-end test, use a clean macOS install or VM. See `CLAUDE.md` for the full fresh-machine checklist.

### Building for Production

```bash
pnpm tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

## Security Considerations

- **Path Validation**: Always use `validate_project_path()` for any file operations
- **No Arbitrary Code Execution**: Don't pass user input directly to shell commands
- **Secrets**: Never commit `.env` files or API keys

## Error Handling

### Frontend: Structured Logger

Use the structured logger (`src/lib/logger.ts`) instead of `console.error`. Logs are flushed to the Rust backend and persisted to disk at `~/Library/Logs/ShipStudio/`.

```typescript
import { logger } from '../lib/logger';

// For caught errors
logger.error('Failed to fetch branches', { error: err instanceof Error ? err.message : String(err) });

// For Error objects with stack traces
logger.logError(error, { context: 'additional info' });

// For warnings and debug info
logger.warn('Unexpected state', { details });
logger.debug('Polling tick', { interval });
```

### Rust Backend: Result Types

All Tauri commands return `Result<T, String>` with descriptive error messages. Use the `?` operator to propagate errors and include context about what operation failed.

```rust
#[tauri::command]
async fn my_command(path: String) -> Result<String, String> {
    let validated = validate_project_path(&path)?;
    do_work(&validated).map_err(|e| format!("Failed to process {}: {}", path, e))
}
```

### ErrorBoundary

`src/components/ErrorBoundary.tsx` catches React render errors, logs them via the structured logger, and shows a restart UI. Any unhandled render error in a component tree wrapped by `ErrorBoundary` will be captured automatically.

### When to Swallow Errors

Only swallow errors for non-critical fire-and-forget operations. Always add a comment explaining why:

```typescript
// Analytics failure shouldn't block the user
void trackEvent('project_opened').catch(() => {});

// Screenshot interval failure is non-critical
void captureScreenshot().catch((err) => {
  logger.debug('Screenshot capture failed', { error: String(err) });
});
```

For anything that affects user-visible state or data integrity, propagate the error to the UI.

## Debugging

### Log files

Ship Studio writes structured logs (via the `tracing` crate) to:

```
~/Library/Logs/ShipStudio/
```

Rotated daily. Tail the latest with `tail -f ~/Library/Logs/ShipStudio/ship-studio.log`.

### Rust backtraces

When the backend panics or returns a cryptic error, re-run the dev app with:

```bash
RUST_BACKTRACE=1 pnpm tauri dev
# or RUST_BACKTRACE=full for more detail
```

Pair with `RUST_LOG=debug` (or `RUST_LOG=ship_studio=debug`) to raise log verbosity without recompiling.

### Frontend DevTools

In the running app, open Chromium DevTools with **Cmd+Option+I**. The Console shows frontend logs emitted via [`src/lib/logger.ts`](src/lib/logger.ts) — that file is the single entry point for structured frontend logging (level, context, redaction). Prefer it over `console.log`.

### Onboarding / setup wizard

See `CLAUDE.md` → **Onboarding / Setup Wizard Testing** for `SHIPSTUDIO_FORCE_ONBOARDING` and `SHIPSTUDIO_FORCE_SETUP` env vars. Copy [`.env.example`](.env.example) to `.env` for a local reference.

## Getting Help

- Check existing issues for similar problems
- Read the code comments and documentation
- Ask questions in your PR or issue

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
