/**
 * Tests for the i18n lib's pure helpers: locale display names and the
 * prompts handed to the embedded AI agent.
 */

import { describe, it, expect } from 'vitest';
import {
  LOCALE_CATALOG,
  localeDisplayName,
  buildTranslatePrompt,
  buildAiSetupPrompt,
  type I18nStatus,
} from './i18n';

function status(overrides: Partial<I18nStatus> = {}): I18nStatus {
  return {
    framework: 'nextjs-pages',
    supported: true,
    unsupportedReason: null,
    configured: true,
    locales: ['en', 'fr', 'de'],
    defaultLocale: 'en',
    configFile: 'next.config.js',
    parseWarning: null,
    ...overrides,
  };
}

// ============ localeDisplayName ============

describe('localeDisplayName', () => {
  it('uses the catalog for known codes', () => {
    expect(localeDisplayName('en')).toBe('English');
    expect(localeDisplayName('pt-BR')).toBe('Portuguese (Brazil)');
  });

  it('falls back to Intl.DisplayNames for codes outside the catalog', () => {
    expect(localeDisplayName('ca')).toBe('Catalan');
  });

  it('returns the raw code when nothing resolves', () => {
    expect(localeDisplayName('zz-INVALID!')).toBe('zz-INVALID!');
  });

  it('catalog has no duplicate codes', () => {
    const codes = LOCALE_CATALOG.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

// ============ buildTranslatePrompt ============

describe('buildTranslatePrompt', () => {
  it('targets only non-default locales', () => {
    const prompt = buildTranslatePrompt(status());
    expect(prompt).toContain('fr (French)');
    expect(prompt).toContain('de (German)');
    expect(prompt).not.toContain('en (English)');
  });

  it('describes the Pages Router dictionary approach for Next.js', () => {
    const prompt = buildTranslatePrompt(status());
    expect(prompt).toContain('Pages Router');
    expect(prompt).toContain('next.config.js');
    expect(prompt).toContain('useRouter().locale');
  });

  it('describes the locale-folder structure for Astro', () => {
    const prompt = buildTranslatePrompt(
      status({ framework: 'astro', configFile: 'astro.config.mjs', locales: ['en', 'ja'] })
    );
    expect(prompt).toContain('astro.config.mjs');
    expect(prompt).toContain('src/pages/<locale>/');
    expect(prompt).toContain('ja (Japanese)');
  });

  it('asks before adding dependencies', () => {
    expect(buildTranslatePrompt(status())).toContain('before adding any new dependencies');
    expect(buildTranslatePrompt(status({ framework: 'astro' }))).toContain(
      'before adding any new dependencies'
    );
  });
});

// ============ buildAiSetupPrompt ============

describe('buildAiSetupPrompt', () => {
  it('suggests an App Router approach for nextjs-app', () => {
    const prompt = buildAiSetupPrompt(
      status({ framework: 'nextjs-app', supported: false, configured: false })
    );
    expect(prompt).toContain('App Router');
    expect(prompt).toContain('next-intl');
  });

  it('asks for a manual config edit otherwise', () => {
    const prompt = buildAiSetupPrompt(status());
    expect(prompt).toContain('defaultLocale');
    expect(prompt).toContain("couldn't edit the config automatically");
  });

  it('always defers installs to the user', () => {
    expect(buildAiSetupPrompt(status({ framework: 'nextjs-app' }))).toContain('confirmation');
    expect(buildAiSetupPrompt(status())).toContain('confirmation');
  });
});
