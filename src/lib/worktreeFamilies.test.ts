/**
 * Tests for the git-truth family-root cache (src/lib/worktreeFamilies.ts):
 * the regression it guards against is a worktree of an EXTERNAL project —
 * the repo lives outside ~/ShipStudio, so no path surgery on the managed
 * `.worktrees/<name>/<branch>` layout can ever reconstruct the parent, and
 * every worktree session used to render as its own phantom sidebar row.
 */

import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  familyRootOf,
  ensureFamilyRoot,
  subscribeFamilyRoots,
  familyRootsVersion,
  resetFamilyRootsForTest,
} from './worktreeFamilies';

const ROOT = '/Users/me/ShipStudio';
const WT = `${ROOT}/.worktrees/wrong-name/more-faqs`;
const EXTERNAL_MAIN = '/Users/me/Desktop/Projects/marketing-site';

function mockFamily() {
  mockIPC((cmd) => {
    expect(cmd).toBe('list_worktrees');
    return [
      {
        path: EXTERNAL_MAIN,
        head: '1234567',
        branch: 'main',
        is_main: true,
        is_current: false,
        locked: null,
        prunable: null,
        last_commit_date: null,
      },
      {
        path: WT,
        head: 'abcdef0',
        branch: 'more-faqs',
        is_main: false,
        is_current: true,
        locked: null,
        prunable: null,
        last_commit_date: null,
      },
    ];
  });
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe('worktreeFamilies', () => {
  beforeEach(() => resetFamilyRootsForTest());
  afterEach(() => clearMocks());

  it('returns non-worktree paths as their own root without any lookup', () => {
    expect(familyRootOf(`${ROOT}/my-app`)).toBe(`${ROOT}/my-app`);
    expect(familyRootOf(EXTERNAL_MAIN)).toBe(EXTERNAL_MAIN);
  });

  it('falls back to the path-derived guess before resolution lands', () => {
    expect(familyRootOf(WT)).toBe(`${ROOT}/wrong-name`);
  });

  it('resolves a managed worktree to its real main worktree via git truth', async () => {
    mockFamily();
    ensureFamilyRoot(WT);
    await flush();
    // The external parent is unreachable by string surgery — only the
    // list_worktrees answer can produce it.
    expect(familyRootOf(WT)).toBe(EXTERNAL_MAIN);
    // The whole family is cached from one lookup, main included.
    expect(familyRootOf(EXTERNAL_MAIN)).toBe(EXTERNAL_MAIN);
  });

  it('notifies subscribers and bumps the version when a resolution lands', async () => {
    mockFamily();
    let notified = 0;
    const unsubscribe = subscribeFamilyRoots(() => {
      notified += 1;
    });
    const before = familyRootsVersion();
    ensureFamilyRoot(WT);
    await flush();
    expect(notified).toBe(1);
    expect(familyRootsVersion()).toBe(before + 1);
    unsubscribe();
  });

  it('does not re-query already-resolved or non-worktree paths', async () => {
    let calls = 0;
    mockIPC(() => {
      calls += 1;
      return [
        {
          path: EXTERNAL_MAIN,
          head: '1234567',
          branch: 'main',
          is_main: true,
          is_current: false,
          locked: null,
          prunable: null,
          last_commit_date: null,
        },
        {
          path: WT,
          head: 'abcdef0',
          branch: 'more-faqs',
          is_main: false,
          is_current: true,
          locked: null,
          prunable: null,
          last_commit_date: null,
        },
      ];
    });
    ensureFamilyRoot(`${ROOT}/regular-project`);
    expect(calls).toBe(0);
    ensureFamilyRoot(WT);
    await flush();
    ensureFamilyRoot(WT);
    await flush();
    expect(calls).toBe(1);
  });

  it('keeps the fallback when the lookup fails', async () => {
    mockIPC(() => {
      throw new Error('not a git repository');
    });
    ensureFamilyRoot(WT);
    await flush();
    expect(familyRootOf(WT)).toBe(`${ROOT}/wrong-name`);
  });
});
