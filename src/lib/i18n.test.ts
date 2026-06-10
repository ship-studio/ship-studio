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
  buildAppRouterSetupPrompt,
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
