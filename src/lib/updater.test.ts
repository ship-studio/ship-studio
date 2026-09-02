import { describe, it, expect, vi, beforeEach } from 'vitest';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';
import {
  checkForUpdate,
  compareVersions,
  isNewerVersion,
  isPlatformMissingFromManifest,
} from './updater';

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(),
}));

/** Injected by vitest.config.ts from package.json, exactly as in the app. */
declare const __APP_VERSION__: string;

function fakeUpdate(version: string): Update {
  return { version, body: 'notes', date: undefined } as unknown as Update;
}

describe('isPlatformMissingFromManifest', () => {
  it('recognizes the updater plugin platform-not-found error (issue #512)', () => {
    expect(
      isPlatformMissingFromManifest(
        'the platform `windows-x86_64` was not found on the response `platforms` object'
      )
    ).toBe(true);
    expect(
      isPlatformMissingFromManifest(
        'the platform `darwin-aarch64` was not found on the response `platforms` object'
      )
    ).toBe(true);
  });

  it('does not swallow genuine failures', () => {
    expect(isPlatformMissingFromManifest('error sending request for url')).toBe(false);
    expect(isPlatformMissingFromManifest('Could not fetch a valid release JSON')).toBe(false);
    expect(isPlatformMissingFromManifest('signature verification failed')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders release versions numerically, not lexically', () => {
    expect(compareVersions('0.18.7', '0.18.7')).toBe(0);
    expect(compareVersions('0.18.7', '0.18.10')).toBe(-1);
    expect(compareVersions('0.19.0', '0.18.7')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });

  it('tolerates a leading v, build metadata and short versions', () => {
    expect(compareVersions('v0.18.7', '0.18.7')).toBe(0);
    expect(compareVersions('0.18.7+build.9', '0.18.7')).toBe(0);
    expect(compareVersions('0.19', '0.19.0')).toBe(0);
  });

  it('ranks a prerelease below its release', () => {
    expect(compareVersions('0.19.0-beta.1', '0.19.0')).toBe(-1);
    expect(compareVersions('0.19.0-beta.2', '0.19.0-beta.10')).toBe(-1);
  });

  it('returns null rather than guessing at unparseable input', () => {
    expect(compareVersions('nightly', '0.18.7')).toBeNull();
    expect(compareVersions('0.18.7', '')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('is false for equal and older versions', () => {
    expect(isNewerVersion('0.18.7', '0.18.7')).toBe(false);
    expect(isNewerVersion('0.18.6', '0.18.7')).toBe(false);
    expect(isNewerVersion('v0.18.7', '0.18.7')).toBe(false);
  });

  it('is true for a strictly newer version', () => {
    expect(isNewerVersion('0.18.8', '0.18.7')).toBe(true);
    expect(isNewerVersion('0.19.0', '0.18.7')).toBe(true);
  });

  it('shows an uncomparable version rather than swallowing a real update', () => {
    expect(isNewerVersion('nightly', '0.18.7')).toBe(true);
  });
});

describe('checkForUpdate version guard', () => {
  beforeEach(() => {
    vi.mocked(check).mockReset();
    vi.mocked(getVersion).mockReset();
  });

  it('ignores an offered version equal to the running app', async () => {
    vi.mocked(getVersion).mockResolvedValue('99.0.0');
    vi.mocked(check).mockResolvedValue(fakeUpdate('99.0.0'));

    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('ignores an offered version older than the running app', async () => {
    vi.mocked(getVersion).mockResolvedValue('99.1.0');
    vi.mocked(check).mockResolvedValue(fakeUpdate('99.0.0'));

    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('ignores the current release when a stale dev binary reports an older version', async () => {
    // `tauri dev` keeps running the last-compiled binary, so getVersion() can
    // lag behind the bumped package.json — the phantom "update available to
    // the version you are already on".
    vi.mocked(getVersion).mockResolvedValue('0.0.1');
    vi.mocked(check).mockResolvedValue(fakeUpdate(__APP_VERSION__));

    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('still surfaces a genuinely newer version', async () => {
    vi.mocked(getVersion).mockResolvedValue('99.0.0');
    vi.mocked(check).mockResolvedValue(fakeUpdate('99.1.0'));

    const result = await checkForUpdate();
    expect(result?.info.version).toBe('99.1.0');
  });

  it('surfaces the update when the running version cannot be read', async () => {
    vi.mocked(getVersion).mockRejectedValue(new Error('no tauri host'));
    vi.mocked(check).mockResolvedValue(fakeUpdate('99.9.9'));

    const result = await checkForUpdate();
    expect(result?.info.version).toBe('99.9.9');
  });
});
