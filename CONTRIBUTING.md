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
src/                    # React frontend (TypeScript)
├── components/         # UI components
├── lib/               # Tauri command wrappers
├── hooks/             # Custom React hooks
├── styles/            # CSS files
└── App.tsx            # Main app component & state

src-tauri/             # Rust backend
├── src/lib.rs         # All Tauri commands (~2800 lines)
├── Cargo.toml         # Rust dependencies
└── tauri.conf.json    # Tauri configuration
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

1. Add the command function in `src-tauri/src/lib.rs`:
```rust
#[tauri::command]
async fn my_new_command(arg: String) -> Result<String, String> {
    // Implementation
}
```

2. Register it in the handler at the bottom of `lib.rs`:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    my_new_command,
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

### Building for Production

```bash
pnpm tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

## Security Considerations

- **Path Validation**: Always use `validate_project_path()` for any file operations
- **No Arbitrary Code Execution**: Don't pass user input directly to shell commands
- **Secrets**: Never commit `.env` files or API keys

## Getting Help

- Check existing issues for similar problems
- Read the code comments and documentation
- Ask questions in your PR or issue

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
