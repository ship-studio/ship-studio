/**
 * The preview's address, as the pages dropdown lets you type it.
 *
 * The iframe is always served from the preview proxy, so an address here is
 * only ever a location on that origin: `/path?query#hash`. A pasted full URL
 * is accepted only when it points at localhost — anything else is another
 * site, and silently loading its path against the dev server would show a
 * page the user did not ask for.
 */

export interface PreviewLocation {
  pathname: string;
  /** `?query#hash` — empty when there is neither. */
  suffix: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Split `/path?q#h` into its pathname and everything after it. */
export function splitLocation(location: string): PreviewLocation {
  const at = location.search(/[?#]/);
  if (at === -1) return { pathname: location || '/', suffix: '' };
  return { pathname: location.slice(0, at) || '/', suffix: location.slice(at) };
}

/**
 * Turn what the user typed into a location to load, or null when it isn't an
 * address (plain text stays a page search).
 *
 * - `/blog/hello?draft=1` → as typed
 * - `?draft=1` or `#pricing` → applied to the current page
 * - `http://localhost:3000/a?b` → `/a?b`
 */
export function parsePreviewAddress(input: string, currentPathname: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  if (raw.startsWith('/')) {
    // `//host/...` is protocol-relative — another origin, not a path.
    if (raw.startsWith('//')) return null;
    return raw;
  }
  if (raw.startsWith('?') || raw.startsWith('#')) {
    return `${currentPathname || '/'}${raw}`;
  }
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!LOCAL_HOSTS.has(url.hostname)) return null;
    return `${url.pathname || '/'}${url.search}${url.hash}`;
  }
  return null;
}
