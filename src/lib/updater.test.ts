import { describe, it, expect } from 'vitest';
import { isPlatformMissingFromManifest } from './updater';

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
