/**
 * Cross-platform path-string helpers for display.
 *
 * The app is developed on macOS, so much of the UI extracts a file/project name
 * with `path.split('/').pop()`. On Windows, filesystem paths come back with
 * backslash separators (`C:\Users\me\ShipStudio\my-app`), so splitting on `/`
 * returns the *entire* path — the sidebar, command palette, breadcrumbs, and
 * asset trail then show a full absolute path where a short name belongs.
 *
 * These helpers split on BOTH separators (`/` and `\`), so they're correct for
 * Windows filesystem paths, macOS/Unix paths, git-reported paths, and URL routes
 * alike. On macOS the behaviour is identical to the old `/`-only split (Unix
 * paths don't contain backslash separators), so adopting them can't regress Mac.
 *
 * @module lib/paths
 */

/** Matches either path separator, so both Windows and POSIX paths parse. */
const SEP = /[\\/]/;

/**
 * The final path segment (basename), with any trailing separators ignored.
 * Falls back to the original string when there's nothing to trim.
 *
 * @example
 * basename('C:\\Users\\me\\app')   // 'app'   (Windows)
 * basename('/Users/me/app')        // 'app'   (macOS)
 * basename('src/App.tsx')          // 'App.tsx'
 */
export function basename(path: string): string {
  // Drop trailing separators so `foo/bar/` yields `bar`, not ''.
  const trimmed = path.replace(/[\\/]+$/, '');
  const segments = trimmed.split(SEP);
  const last = segments[segments.length - 1];
  return last === '' ? path : last;
}

/**
 * Split a path into its segments on either separator, dropping empty segments
 * (leading separators, doubled separators). Useful for breadcrumbs and depth.
 *
 * @example
 * pathSegments('C:\\a\\b\\c')  // ['C:', 'a', 'b', 'c']
 * pathSegments('/a/b/c')       // ['a', 'b', 'c']
 */
export function pathSegments(path: string): string[] {
  return path.split(SEP).filter(Boolean);
}
