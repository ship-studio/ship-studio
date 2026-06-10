/**
 * Tests for the i18n lib's pure helpers: locale display names and the
 * prompts handed to the embedded AI agent.
 */

import { describe, it, expect } from 'vitest';
import {
  LOCALE_CATALOG,
  localeDisplayName,
  searchLocales,
  pathLocale,
  switchPathLocale,
  buildTranslatePrompt,
  buildAiSetupPrompt,
  buildAppRouterSetupPrompt,
  buildRemovalCleanupPrompt,
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
    agentSetupAvailable: false,
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

// ============ searchLocales ============

describe('searchLocales', () => {
  it('returns the popular catalog for an empty query', () => {
    const results = searchLocales('', []);
    expect(results[0]).toEqual(LOCALE_CATALOG[0]);
  });

  it('excludes already-selected languages', () => {
    const results = searchLocales('', ['en']);
    expect(results.some((r) => r.code === 'en')).toBe(false);
  });

  it('finds languages beyond the popular catalog', () => {
    expect(searchLocales('catalan', []).some((r) => r.code === 'ca')).toBe(true);
    expect(searchLocales('zulu', []).some((r) => r.code === 'zu')).toBe(true);
    expect(searchLocales('icelandic', []).some((r) => r.code === 'is')).toBe(true);
  });

  it('matches by code too', () => {
    // "sw" matches both Swedish (name) and Swahili (code) — both surface.
    const results = searchLocales('sw', []);
    expect(results.some((r) => r.code === 'sw')).toBe(true);
    expect(results.some((r) => r.code === 'sv')).toBe(true);
  });

  it('offers exact regional codes, canonicalized', () => {
    const results = searchLocales('fr-ca', []);
    expect(results[0].code).toBe('fr-CA');
    expect(results[0].name.toLowerCase()).toContain('french');
  });

  it('returns nothing for gibberish', () => {
    expect(searchLocales('xyzzyplugh', [])).toEqual([]);
  });
});

// ============ pathLocale / switchPathLocale ============

describe('pathLocale', () => {
  const locales = ['en', 'fr', 'de'];

  it('reads the locale prefix from the path', () => {
    expect(pathLocale('/fr/about', locales, 'en')).toBe('fr');
    expect(pathLocale('/de', locales, 'en')).toBe('de');
  });

  it('falls back to the default for unprefixed paths', () => {
    expect(pathLocale('/about', locales, 'en')).toBe('en');
    expect(pathLocale('/', locales, 'en')).toBe('en');
  });
});

describe('switchPathLocale', () => {
  const locales = ['en', 'fr', 'de'];

  it('prefixes a non-default locale', () => {
    expect(switchPathLocale('/about', 'fr', locales, 'en')).toBe('/fr/about');
    expect(switchPathLocale('/', 'fr', locales, 'en')).toBe('/fr');
  });

  it('replaces an existing locale prefix', () => {
    expect(switchPathLocale('/fr/about', 'de', locales, 'en')).toBe('/de/about');
    expect(switchPathLocale('/fr', 'de', locales, 'en')).toBe('/de');
  });

  it('strips the prefix when switching to the default', () => {
    expect(switchPathLocale('/fr/about', 'en', locales, 'en')).toBe('/about');
    expect(switchPathLocale('/fr', 'en', locales, 'en')).toBe('/');
  });

  it('leaves unprefixed default paths alone', () => {
    expect(switchPathLocale('/about', 'en', locales, 'en')).toBe('/about');
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

  it('targets next-intl message dictionaries for the App Router', () => {
    const prompt = buildTranslatePrompt(
      status({
        framework: 'nextjs-app',
        configFile: 'src/i18n/routing.ts',
        locales: ['en', 'es'],
      })
    );
    expect(prompt).toContain('next-intl');
    expect(prompt).toContain('src/i18n/routing.ts');
    expect(prompt).toContain('messages/<locale>.json');
    expect(prompt).toContain('ICU');
    expect(prompt).toContain('es (Spanish)');
  });

  it('asks before adding dependencies', () => {
    expect(buildTranslatePrompt(status())).toContain('before adding any new dependencies');
    expect(buildTranslatePrompt(status({ framework: 'astro' }))).toContain(
      'before adding any new dependencies'
    );
    expect(buildTranslatePrompt(status({ framework: 'nextjs-app' }))).toContain(
      'before adding any new dependencies'
    );
  });
});

// ============ buildAiSetupPrompt ============

describe('buildAiSetupPrompt', () => {
  it('asks for a manual config edit naming the file', () => {
    const prompt = buildAiSetupPrompt(status());
    expect(prompt).toContain('defaultLocale');
    expect(prompt).toContain('next.config.js');
    expect(prompt).toContain("couldn't edit the config automatically");
  });

  it('defers installs to the user', () => {
    expect(buildAiSetupPrompt(status())).toContain('confirmation');
  });
});

// ============ buildRemovalCleanupPrompt ============

describe('buildRemovalCleanupPrompt', () => {
  it('names the removed and kept locales', () => {
    const prompt = buildRemovalCleanupPrompt(status({ locales: ['en', 'fr'] }), ['ru']);
    expect(prompt).toContain('ru (Russian)');
    expect(prompt).toContain('[en, fr]');
  });

  it('warns that Astro keeps serving locale folders', () => {
    const prompt = buildRemovalCleanupPrompt(status({ framework: 'astro' }), ['ru']);
    expect(prompt).toContain('src/pages/<locale>/');
    expect(prompt).toContain('keeps serving');
  });

  it('targets message dictionaries for the App Router', () => {
    const prompt = buildRemovalCleanupPrompt(status({ framework: 'nextjs-app' }), ['ru']);
    expect(prompt).toContain('messages/<locale>.json');
  });

  it('requires listing deletions first and a build check', () => {
    const prompt = buildRemovalCleanupPrompt(status(), ['ru']);
    expect(prompt).toContain('BEFORE deleting');
    expect(prompt).toContain('still builds');
  });
});

// ============ buildAppRouterSetupPrompt ============

describe('buildAppRouterSetupPrompt', () => {
  const prompt = buildAppRouterSetupPrompt(['en', 'fr', 'ja'], 'en');

  it('pins the chosen locales into routing.ts code', () => {
    expect(prompt).toContain("locales: ['en', 'fr', 'ja']");
    expect(prompt).toContain("defaultLocale: 'en'");
    expect(prompt).toContain('src/i18n/routing.ts');
  });

  it('covers the full next-intl anatomy', () => {
    expect(prompt).toContain('defineRouting');
    expect(prompt).toContain('getRequestConfig');
    expect(prompt).toContain('createNavigation');
    expect(prompt).toContain('createMiddleware');
    expect(prompt).toContain('createNextIntlPlugin');
    expect(prompt).toContain('NextIntlClientProvider');
    expect(prompt).toContain('generateStaticParams');
  });

  it('handles the Next.js 16 proxy.ts rename', () => {
    expect(prompt).toContain('proxy.ts');
    expect(prompt).toContain('middleware.ts');
  });

  it('creates a messages file per locale and ends with verification', () => {
    expect(prompt).toContain('en.json, fr.json, ja.json');
    expect(prompt).toContain('useTranslations');
    expect(prompt).toContain('Verify the project builds');
  });

  it('pre-authorizes the install so the agent does not stall', () => {
    expect(prompt).toContain('installing next-intl is approved');
  });
});
