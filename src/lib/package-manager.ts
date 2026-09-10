/**
 * Package-manager-aware command builders for spawning project tooling.
 *
 * Harbr used to hardcode `npm run dev` / `npx <binary>` when starting a
 * dev server. Both are wrong outside npm projects: `npm run` parses the
 * manifest's npm-only fields (an `overrides` block npm itself rejects aborts
 * the launch with EOVERRIDE before the dev server ever starts) and ignores
 * bun/pnpm lockfiles, while `npx <binary>` assumes the dev script's first
 * token names an npm package — a script like `bash scripts/dev.sh` or
 * `make dev` dies with "could not determine executable to run", because npx
 * (unlike bunx and `pnpm exec`) never falls back to PATH.
 *
 * @module lib/package-manager
 */

/** The package managers Harbr can launch dev servers with. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** A resolved command: a binary plus the argv to spawn it with. */
export interface RunnerCommand {
  command: string;
  args: string[];
}

const KNOWN: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

/**
 * Validate a package-manager name coming from the backend (lockfile
 * detection) or any older caller, defaulting to npm — the manager that ships
 * with Node, so a spawn with it is always at least attemptable.
 *
 * @param raw - Detected manager name, or null/undefined when detection failed
 * @returns A known PackageManager, "npm" when the value isn't one
 */
export function normalizePackageManager(raw: string | null | undefined): PackageManager {
  return KNOWN.includes(raw as PackageManager) ? (raw as PackageManager) : 'npm';
}

/**
 * Build the command that runs a package.json script with forwarded arguments
 * (e.g. `--port 3000`).
 *
 * Only npm needs the `--` separator to stop eating forwarded flags itself;
 * pnpm, yarn, and bun forward everything after the script name, and yarn 1
 * hands a literal `--` to the script.
 *
 * @param pm - The project's package manager
 * @param script - The script name (e.g. "dev")
 * @param scriptArgs - Arguments to forward to the script
 * @returns Command to spawn
 */
export function runScriptCommand(
  pm: PackageManager,
  script: string,
  scriptArgs: string[]
): RunnerCommand {
  if (pm === 'npm') {
    return { command: 'npm', args: ['run', script, '--', ...scriptArgs] };
  }
  return { command: pm, args: ['run', script, ...scriptArgs] };
}

/**
 * Build the command that executes a dev script's binary the way the project's
 * package manager would — resolving project-local `node_modules/.bin` first,
 * then PATH.
 *
 * Per manager:
 * - npm → `npx` (resolves local .bin; npm projects can't hit the EOVERRIDE
 *   class of bugs this module exists for, since their manager IS npm)
 * - bun → `bunx` (local .bin, then PATH)
 * - pnpm → `pnpm exec` (local .bin, then PATH)
 * - yarn → `npx` (yarn has no PATH-falling exec equivalent; npx is
 *   tool-agnostic, ships with Node, and yarn projects don't carry the npm
 *   overrides that make npx risky — the least-wrong runner)
 *
 * @param pm - The project's package manager
 * @param bin - The dev script's first token (e.g. "vite", "bash")
 * @param binArgs - The dev script's remaining tokens
 * @returns Command to spawn
 */
export function execScriptCommand(
  pm: PackageManager,
  bin: string,
  binArgs: string[]
): RunnerCommand {
  switch (pm) {
    case 'bun':
      return { command: 'bunx', args: [bin, ...binArgs] };
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', bin, ...binArgs] };
    case 'yarn':
    case 'npm':
      return { command: 'npx', args: [bin, ...binArgs] };
  }
}
