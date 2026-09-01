/**
 * Import-specific failure classification for the GitHub import wizard.
 *
 * These are failure shapes that only the clone/install flow produces, and that
 * the shared `describeProcessError` either doesn't recognize or (for `invalid
 * path`) recognizes as the wrong thing. Each one is a repository or machine
 * condition with a real next step — `expected: true` keeps them out of
 * auto-filed bug reports, the same contract the shared classifier uses.
 *
 * @module components/import-project/importErrors
 */

import {
  asCommandError,
  describeProcessError,
  formatCommandError,
  type ProcessErrorInfo,
} from '../../lib/errors';

/**
 * Classify a caught clone/install error, falling back to the shared
 * {@link describeProcessError} for everything that isn't import-specific.
 *
 * Import branches run *first*: `error: invalid path` failures also carry the
 * generic "unable to checkout working tree" wrapper text that the shared
 * long-paths branch matches, so delegating first would hand the user the wrong
 * remedy (issue #706).
 */
export function describeImportError(err: unknown): ProcessErrorInfo {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : formatCommandError(asCommandError(err));
  const lower = msg.toLowerCase();

  // Illegal filename characters during checkout: git-for-windows refuses to
  // create files whose names contain " : < > | ? * with "error: invalid path
  // '<file>'", then aborts with the same "unable to checkout working tree" /
  // "Clone succeeded, but checkout failed." wrapper that a path-length failure
  // produces. Long-path support can't fix this one — Windows rejects the name
  // itself — so it needs its own message (issue #706, sibling of #701).
  if (lower.includes('error: invalid path')) {
    return {
      expected: true,
      message:
        "The repository was downloaded, but some of its files have names containing characters Windows doesn't allow (such as \" : < > | ? *), so git couldn't check them out. Those files have to be renamed in the repository itself — or clone it on macOS, Linux, or WSL, where the names are valid.",
    };
  }

  // pnpm/Yarn-only dependency protocols run through npm. `workspace:*` and
  // pnpm's `catalog:` are rejected outright with EUNSUPPORTEDPROTOCOL — no
  // retry helps, the project needs a different package manager (issues
  // #707/#708).
  if (
    lower.includes('eunsupportedprotocol') ||
    (lower.includes('unsupported url type') &&
      (lower.includes('workspace:') || lower.includes('catalog:')))
  ) {
    return {
      expected: true,
      message:
        "This project links its dependencies with pnpm's `workspace:`/`catalog:` protocol, which npm can't install. Install pnpm (`npm install -g pnpm`), then retry the install — or run `pnpm install` in the project folder yourself.",
    };
  }

  // The other half of the same root cause: repos that guard against the wrong
  // installer with a preinstall script inspecting `npm_config_user_agent`, and
  // exit 1 with "Use pnpm instead". A project requirement, not an app bug
  // (issue #707, second occurrence).
  if (lower.includes('npm_config_user_agent') || /use (?:pnpm|yarn|bun) instead/.test(lower)) {
    return {
      expected: true,
      message:
        'This project refuses to install with npm — its own setup script requires pnpm (or Yarn). Install that package manager, then retry the install, or run its `install` command in the project folder yourself.',
    };
  }

  // GitHub's GraphQL 404 for the repository query: `gh repo clone` exits with
  // the generic code 1, so only the wording identifies it. The repo was
  // renamed/deleted/transferred, or access was revoked, between listing it and
  // importing it — a user/environment condition (issue #733).
  if (lower.includes('could not resolve to a repository')) {
    return {
      expected: true,
      message:
        "GitHub couldn't find that repository. It may have been renamed, deleted, or transferred, or your access to it may have been removed. Go back, refresh the repository list, and check you picked the right account or organization.",
    };
  }

  return describeProcessError(err);
}
