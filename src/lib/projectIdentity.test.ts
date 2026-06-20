import { describe, it, expect } from 'vitest';
import { getProjectId } from './projectIdentity';

describe('getProjectId', () => {
  it('is deterministic for the same path', () => {
    expect(getProjectId('/Users/me/ShipStudio/acme')).toBe(
      getProjectId('/Users/me/ShipStudio/acme')
    );
  });

  it('always returns exactly 8 lowercase hex chars', () => {
    expect(getProjectId('/a/b/c')).toMatch(/^[0-9a-f]{8}$/);
    expect(getProjectId('/some/other/path')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces the FNV-1a offset basis for the empty string', () => {
    // No bytes mixed in -> hash stays at the 2166136261 offset basis (0x811c9dc5).
    expect(getProjectId('')).toBe('811c9dc5');
  });

  it('maps distinct paths to distinct ids', () => {
    expect(getProjectId('/project/a')).not.toBe(getProjectId('/project/b'));
  });
});
