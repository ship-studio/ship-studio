/**
 * Tests for the plugin library fetch (retry/backoff) and the expected-failure
 * classifier both the Plugin Manager and usePlugins use to decide between
 * logger.warn/info-toast and logger.error/error-toast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type PluginsModule = typeof import('./plugins');

/** Fresh module instance per test — `fetchPluginRegistry` memoizes globally. */
async function loadPlugins(): Promise<PluginsModule> {
  vi.resetModules();
  return import('./plugins');
}

function jsonResponse(plugins: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve({ plugins }),
  } as unknown as Response;
}

function errorResponse(status: number, retryAfter?: string): Response {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => (name === 'Retry-After' ? (retryAfter ?? null) : null) },
    json: () => Promise.reject(new Error('no body')),
  } as unknown as Response;
}

describe('fetchPluginRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries a 429 and returns the registry on a later attempt (issue #713)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(jsonResponse([{ id: 'vercel' }]));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchPluginRegistry } = await loadPlugins();
    const promise = fetchPluginRegistry();
    await vi.runAllTimersAsync();

    expect(await promise).toEqual([{ id: 'vercel' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After instead of its own backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, '2'))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchPluginRegistry } = await loadPlugins();
    const promise = fetchPluginRegistry();

    // The default backoff is 500ms; Retry-After: 2 must hold it longer.
    await vi.advanceTimersByTimeAsync(600);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1500);
    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt budget and rethrows the status error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchPluginRegistry } = await loadPlugins();
    const promise = fetchPluginRegistry();
    const assertion = expect(promise).rejects.toThrow('Failed to fetch plugin registry: 429');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404 — that is a real answer, not a blip', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(404));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchPluginRegistry } = await loadPlugins();
    await expect(fetchPluginRegistry()).rejects.toThrow('Failed to fetch plugin registry: 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a network-level failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse([{ id: 'figma' }]));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchPluginRegistry } = await loadPlugins();
    const promise = fetchPluginRegistry();
    await vi.runAllTimersAsync();

    expect(await promise).toEqual([{ id: 'figma' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('isRegistryUnreachableError', () => {
  it('separates reachability failures from a malformed registry body', async () => {
    const { isRegistryUnreachableError } = await loadPlugins();
    expect(isRegistryUnreachableError(new Error('Failed to fetch plugin registry: 429'))).toBe(
      true
    );
    expect(isRegistryUnreachableError(new TypeError('Failed to fetch'))).toBe(true);
    // A broken registry JSON is Harbr's own problem — keep reporting it.
    expect(isRegistryUnreachableError(new SyntaxError('Unexpected end of JSON input'))).toBe(false);
  });
});

describe('isExpectedPluginFailure', () => {
  it('recognizes the backend by-design install refusals (issues #734/#833)', async () => {
    const { isExpectedPluginFailure } = await loadPlugins();
    for (const message of [
      'Invalid plugin: No plugin.json found in /tmp/x',
      "Plugin manifest must have 'id' and 'name' fields",
      'Plugin ID contains invalid characters',
      "This plugin can't be installed: its repository has no built bundle (dist/index.js). …",
      "Plugin 'Figma' requires Harbr v9.0.0 or later (current: v0.18.6). Please update Harbr.",
      "Plugin 'x' requests commands that are not available to plugins: rm_rf",
      "A non-dev plugin 'vercel' is already installed. Uninstall it first.",
    ]) {
      expect(isExpectedPluginFailure({ type: 'Other', message })).toBe(true);
    }
  });

  it('recognizes unclonable/unreachable repository failures (issues #803/#732)', async () => {
    const { isExpectedPluginFailure } = await loadPlugins();
    for (const message of [
      "Couldn't find a git repository at that URL. Double-check the plugin's repository link …",
      "This plugin's repository requires sign-in, and Harbr can't authenticate to it …",
      "Couldn't reach the plugin's repository — check your internet connection and try again.",
      'That link points at a page inside a repository, not the repository itself. …',
      'Plugin repository URL must be an https://, ssh://, git:// or git@ remote',
    ]) {
      expect(isExpectedPluginFailure({ type: 'Other', message })).toBe(true);
    }
  });

  it('recognizes filesystem/project environment states (issues #762/#831/#770)', async () => {
    const { isExpectedPluginFailure } = await loadPlugins();
    for (const message of [
      "Harbr isn't allowed to read this project's plugin registry (/x). Grant access in System Settings → Privacy & Security → Files & Folders (or Full Disk Access), then try again.",
      "The folder '/x' no longer exists — it may have been moved, renamed, or deleted outside Harbr",
      'Plugin bundle not found: /x/.shipstudio/plugins/vercel/dist/index.js',
    ]) {
      expect(isExpectedPluginFailure({ type: 'Other', message })).toBe(true);
    }
  });

  it('leaves genuine defects reportable', async () => {
    const { isExpectedPluginFailure } = await loadPlugins();
    expect(
      isExpectedPluginFailure({ type: 'Other', message: 'Failed to parse registry: eof' })
    ).toBe(false);
    expect(
      isExpectedPluginFailure({ type: 'Io', message: 'Failed to read plugin bundle: EIO' })
    ).toBe(false);
    expect(isExpectedPluginFailure(new Error('Git clone failed: object file is empty'))).toBe(
      false
    );
  });
});

describe('bundled hosting plugins are superseded (issues #386, #804)', () => {
  // Native hosting (src/components/hosting) replaced the vercel/cloudflare/
  // netlify plugins. usePlugins filters anything with a supersededReason
  // out *before* loading/activating it (never calls its onActivate, never
  // starts its background timers), so these three can no longer reach the
  // "files missing → deactivation toast" path (#386) or call a stale
  // required_command like the old Cloudflare plugin's DNS-credential lookup
  // (#804) — both bugs lived entirely inside code that now never runs. This
  // pins the invariant that keeps that true: every bundled hosting plugin
  // id MUST have a superseded reason, or it would load again.
  it('every HOSTING_PLUGIN_IDS entry has a supersededReason', async () => {
    const { HOSTING_PLUGIN_IDS, supersededReason } = await loadPlugins();
    for (const id of HOSTING_PLUGIN_IDS) {
      expect(supersededReason(id), `expected "${id}" to be superseded`).not.toBeNull();
    }
  });
});
