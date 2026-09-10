import { describe, expect, it } from 'vitest';
import { classifyThumbnailLoadFailure } from './projectThumbnailErrors';

/**
 * Issue #887: a `getProjectThumbnail` failure that the backend already
 * classified as `Expected` (e.g. a macOS Full Disk Access / EPERM denial
 * from `classify_fs_error`) must log as a warning, not an error — logger.error
 * auto-files a bug report and this is a normal, user-fixable environment
 * state, not a malfunction.
 */
describe('classifyThumbnailLoadFailure', () => {
  it('treats a project-folder-gone message as a warning', () => {
    expect(
      classifyThumbnailLoadFailure({
        type: 'Other',
        message:
          "The folder 'happy-lipo' no longer exists — it may have been moved, renamed, or deleted outside Harbr",
      })
    ).toEqual({ level: 'warn' });
  });

  it('treats any other backend-Expected failure as a warning', () => {
    expect(
      classifyThumbnailLoadFailure({
        type: 'Other',
        message:
          "Harbr isn't allowed to read this project's thumbnail (…/thumbnail.png). Grant access in System Settings → Privacy & Security → Files & Folders (or Full Disk Access), then try again.",
        expected: true,
      })
    ).toEqual({ level: 'warn' });
  });

  it('treats an unrecognized failure as an error', () => {
    expect(
      classifyThumbnailLoadFailure({
        type: 'Other',
        message: 'Something genuinely broke',
      })
    ).toEqual({ level: 'error' });
  });
});
