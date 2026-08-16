/**
 * Tests for lib/static-server helpers — most importantly the `hasWebPreview`
 * rule (issue #691): which projects get the web iframe Preview pane.
 */

import { describe, it, expect } from 'vitest';
import { hasWebPreview, isMobileProjectType, type ProjectType } from './static-server';

describe('hasWebPreview', () => {
  it('always grants a preview to detected web frameworks and static sites', () => {
    const webTypes: ProjectType[] = [
      'nextjs',
      'sveltekit',
      'astro',
      'nuxt',
      'vite',
      'statichtml',
      'shopifytheme',
    ];
    for (const type of webTypes) {
      expect(hasWebPreview(type, null), type).toBe(true);
      // A custom command must not revoke a framework preview either.
      expect(hasWebPreview(type, 'npm run dev'), type).toBe(true);
    }
  });

  it('grants generic projects a preview only with a configured dev command', () => {
    // The #691 case: an Nx monorepo root (workspaces + nx.json, no framework
    // config) detects as `generic`; once the user configures a dev command the
    // dev server runs, so the Preview tab must appear.
    expect(hasWebPreview('generic', 'npx nx serve web')).toBe(true);

    // Plain script collections / Rust CLIs with a tooling-only package.json
    // must keep hiding the Preview.
    expect(hasWebPreview('generic', null)).toBe(false);
    expect(hasWebPreview('generic', '')).toBe(false);
    expect(hasWebPreview('generic', '   ')).toBe(false);
  });

  it('never grants unknown projects a web preview', () => {
    expect(hasWebPreview('unknown', null)).toBe(false);
    // `unknown` means no framework, no package.json, no HTML — a custom
    // command isn't even loaded for these, but be defensive.
    expect(hasWebPreview('unknown', 'npm run dev')).toBe(false);
  });

  it('never grants native mobile projects a web preview (device mirror instead)', () => {
    expect(hasWebPreview('reactnative', null)).toBe(false);
    expect(hasWebPreview('flutter', null)).toBe(false);
    expect(hasWebPreview('reactnative', 'expo start')).toBe(false);
  });
});

describe('isMobileProjectType', () => {
  it('is true for native mobile project types', () => {
    expect(isMobileProjectType('reactnative')).toBe(true);
    expect(isMobileProjectType('flutter')).toBe(true);
  });

  it('is false for web and unknown project types', () => {
    expect(isMobileProjectType('vite')).toBe(false);
    expect(isMobileProjectType('nextjs')).toBe(false);
    expect(isMobileProjectType('statichtml')).toBe(false);
    expect(isMobileProjectType('generic')).toBe(false);
    expect(isMobileProjectType('unknown')).toBe(false);
  });
});
