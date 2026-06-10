/**
 * Multilingual (i18n) support functions.
 *
 * Wraps the Rust i18n commands that detect and manage built-in i18n routing
 * for Next.js (Pages Router) and Astro projects, plus pure helpers for locale
 * display names and the AI translation prompt.
 *
 * @module lib/i18n
 */

import { invoke } from '@tauri-apps/api/core';

/** Mirrors `I18nFramework` in src-tauri/src/commands/i18n.rs */
export type I18nFramework = 'nextjs-pages' | 'nextjs-app' | 'astro' | 'unsupported';

export interface I18nStatus {
  framework: I18nFramework;
  /** Whether Ship Studio can manage i18n for this project. */
  supported: boolean;
  /** Human-readable reason when `supported` is false. */
  unsupportedReason: string | null;
  /** Whether an `i18n` block exists in the framework config. */
  configured: boolean;
  locales: string[];
  defaultLocale: string | null;
  /** Config file name relative to the workspace root, when one exists. */
  configFile: string | null;
  /** Set when an i18n block exists but couldn't be fully parsed. */
  parseWarning: string | null;
}

interface RawI18nStatus {
  framework: I18nFramework;
  supported: boolean;
  unsupported_reason: string | null;
  configured: boolean;
  locales: string[];
  default_locale: string | null;
  config_file: string | null;
  parse_warning: string | null;
}

function mapStatus(raw: RawI18nStatus): I18nStatus {
  return {
    framework: raw.framework,
    supported: raw.supported,
    unsupportedReason: raw.unsupported_reason,
    configured: raw.configured,
    locales: raw.locales,
    defaultLocale: raw.default_locale,
    configFile: raw.config_file,
    parseWarning: raw.parse_warning,
  };
}

/** Get the i18n state of a project (framework support, configured locales). */
export async function getI18nStatus(projectPath: string): Promise<I18nStatus> {
  return mapStatus(await invoke<RawI18nStatus>('get_i18n_status', { projectPath }));
}

/**
 * Create or update the i18n configuration. Rejects with a `Validation`
 * CommandError (and changes nothing) when the existing config can't be
 * edited safely — callers should offer the AI fallback in that case.
 */
export async function setI18nConfig(
  projectPath: string,
  locales: string[],
  defaultLocale: string
): Promise<I18nStatus> {
  return mapStatus(
    await invoke<RawI18nStatus>('set_i18n_config', { projectPath, locales, defaultLocale })
  );
}

/**
 * Common locales offered in the language picker. Codes follow UTS-35
 * (`language` or `language-REGION`); anything else can be typed manually.
 */
export const LOCALE_CATALOG: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ru', name: 'Russian' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'nb', name: 'Norwegian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'cs', name: 'Czech' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'id', name: 'Indonesian' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
];

/**
 * Human-readable name for a locale code. Falls back to `Intl.DisplayNames`
 * for codes outside the catalog, and to the raw code when even that fails.
 */
export function localeDisplayName(code: string): string {
  const fromCatalog = LOCALE_CATALOG.find((l) => l.code === code);
  if (fromCatalog) return fromCatalog.name;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    if (name && name !== code) return name;
  } catch {
    // Invalid/unknown code — fall through to the raw code.
  }
  return code;
}

/**
 * Build the prompt handed to the embedded AI agent to translate the site
 * into the configured non-default locales. Pure so it can be unit-tested.
 */
export function buildTranslatePrompt(status: I18nStatus): string {
  const defaultLocale = status.defaultLocale ?? status.locales[0] ?? 'en';
  const targets = status.locales.filter((l) => l !== defaultLocale);
  const targetList = targets.map((l) => `${l} (${localeDisplayName(l)})`).join(', ');

  if (status.framework === 'astro') {
    return (
      `This Astro project has built-in i18n routing configured in ${status.configFile ?? 'astro.config.mjs'} ` +
      `with locales [${status.locales.join(', ')}] and defaultLocale "${defaultLocale}".\n\n` +
      `Please translate the site into: ${targetList}.\n\n` +
      `For each target locale, create the matching pages under src/pages/<locale>/ ` +
      `(e.g. src/pages/fr/about.astro for src/pages/about.astro). Keep layouts, components, ` +
      `imports, frontmatter logic, and styling identical — translate only the human-visible text ` +
      `(headings, paragraphs, button labels, alt text, meta titles/descriptions). ` +
      `Don't translate brand names, code samples, or URLs. ` +
      `Where shared components contain hardcoded text, extract it into per-locale strings rather than duplicating components. ` +
      `Ask me before adding any new dependencies.`
    );
  }

  return (
    `This Next.js project uses the Pages Router with built-in i18n routing configured in ${status.configFile ?? 'next.config.js'} ` +
    `with locales [${status.locales.join(', ')}] and defaultLocale "${defaultLocale}".\n\n` +
    `Please translate the site into: ${targetList}.\n\n` +
    `Next.js built-in i18n handles routing only, so set up content translation the simple way: ` +
    `if the project already uses an i18n library, follow its conventions; otherwise create per-locale ` +
    `dictionaries (e.g. locales/<locale>.json) and read the active locale from the router ` +
    `(useRouter().locale) or getStaticProps context to pick the right strings. ` +
    `Translate all human-visible text (headings, paragraphs, button labels, alt text, meta titles/descriptions) ` +
    `but not brand names, code samples, or URLs. ` +
    `Ask me before adding any new dependencies.`
  );
}

/**
 * Fallback prompt when Ship Studio can't manage the config itself —
 * App Router projects, wrapped configs, or unparseable i18n blocks.
 */
export function buildAiSetupPrompt(status: I18nStatus): string {
  if (status.framework === 'nextjs-app') {
    return (
      `This Next.js project uses the App Router, which has no built-in i18n routing. ` +
      `Please set up internationalization for it: recommend a well-supported approach ` +
      `(e.g. next-intl with a [locale] route segment and middleware), explain the trade-offs briefly, ` +
      `and wait for my confirmation before installing anything or restructuring routes.`
    );
  }
  return (
    `Please set up internationalized routing for this project by adding an i18n section ` +
    `(locales array + defaultLocale) to the framework config file. ` +
    `Ship Studio couldn't edit the config automatically, so review its current structure first ` +
    `and make the change in the appropriate place. Wait for my confirmation before installing anything.`
  );
}
