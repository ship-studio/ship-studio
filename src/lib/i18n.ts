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
  /**
   * True when the project isn't manageable yet but a guided AI setup flow
   * exists (Next.js App Router without next-intl).
   */
  agentSetupAvailable: boolean;
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
  agent_setup_available: boolean;
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
    agentSetupAvailable: raw.agent_setup_available,
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

/** Every ISO 639-1 language code; display names resolved via Intl. */
const ISO_639_1_CODES = [
  'aa',
  'ab',
  'ae',
  'af',
  'ak',
  'am',
  'an',
  'ar',
  'as',
  'av',
  'ay',
  'az',
  'ba',
  'be',
  'bg',
  'bi',
  'bm',
  'bn',
  'bo',
  'br',
  'bs',
  'ca',
  'ce',
  'ch',
  'co',
  'cr',
  'cs',
  'cu',
  'cv',
  'cy',
  'da',
  'de',
  'dv',
  'dz',
  'ee',
  'el',
  'en',
  'eo',
  'es',
  'et',
  'eu',
  'fa',
  'ff',
  'fi',
  'fj',
  'fo',
  'fr',
  'fy',
  'ga',
  'gd',
  'gl',
  'gn',
  'gu',
  'gv',
  'ha',
  'he',
  'hi',
  'ho',
  'hr',
  'ht',
  'hu',
  'hy',
  'hz',
  'ia',
  'id',
  'ie',
  'ig',
  'ii',
  'ik',
  'io',
  'is',
  'it',
  'iu',
  'ja',
  'jv',
  'ka',
  'kg',
  'ki',
  'kj',
  'kk',
  'kl',
  'km',
  'kn',
  'ko',
  'kr',
  'ks',
  'ku',
  'kv',
  'kw',
  'ky',
  'la',
  'lb',
  'lg',
  'li',
  'ln',
  'lo',
  'lt',
  'lu',
  'lv',
  'mg',
  'mh',
  'mi',
  'mk',
  'ml',
  'mn',
  'mr',
  'ms',
  'mt',
  'my',
  'na',
  'nb',
  'nd',
  'ne',
  'ng',
  'nl',
  'nn',
  'no',
  'nr',
  'nv',
  'ny',
  'oc',
  'oj',
  'om',
  'or',
  'os',
  'pa',
  'pi',
  'pl',
  'ps',
  'pt',
  'qu',
  'rm',
  'rn',
  'ro',
  'ru',
  'rw',
  'sa',
  'sc',
  'sd',
  'se',
  'sg',
  'si',
  'sk',
  'sl',
  'sm',
  'sn',
  'so',
  'sq',
  'sr',
  'ss',
  'st',
  'su',
  'sv',
  'sw',
  'ta',
  'te',
  'tg',
  'th',
  'ti',
  'tk',
  'tl',
  'tn',
  'to',
  'tr',
  'ts',
  'tt',
  'tw',
  'ty',
  'ug',
  'uk',
  'ur',
  'uz',
  've',
  'vi',
  'vo',
  'wa',
  'wo',
  'xh',
  'yi',
  'yo',
  'za',
  'zh',
  'zu',
];

export interface LocaleOption {
  code: string;
  name: string;
}

let allOptionsCache: LocaleOption[] | null = null;

/** Popular catalog first, then the rest of ISO 639-1 alphabetized by name. */
function allLocaleOptions(): LocaleOption[] {
  if (allOptionsCache) return allOptionsCache;
  const seen = new Set<string>(LOCALE_CATALOG.map((l) => l.code));
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    display = null;
  }
  const rest: LocaleOption[] = [];
  for (const code of ISO_639_1_CODES) {
    if (seen.has(code)) continue;
    let name: string | undefined;
    try {
      name = display?.of(code) ?? undefined;
    } catch {
      continue;
    }
    if (!name || name === code) continue;
    rest.push({ code, name });
  }
  rest.sort((a, b) => a.name.localeCompare(b.name));
  allOptionsCache = [...LOCALE_CATALOG, ...rest];
  return allOptionsCache;
}

/**
 * Search every known language — the full ISO 639-1 set plus popular regional
 * variants — by name or code. An empty query returns the popular catalog.
 * A query that is itself a valid locale code (e.g. `fr-CA`) is offered
 * directly, so any regional variant can be added.
 */
export function searchLocales(query: string, exclude: string[] = [], limit = 24): LocaleOption[] {
  const excludeSet = new Set(exclude);
  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  if (!q) return LOCALE_CATALOG.filter((l) => !excludeSet.has(l.code)).slice(0, limit);

  const starts: LocaleOption[] = [];
  const contains: LocaleOption[] = [];
  for (const opt of allLocaleOptions()) {
    if (excludeSet.has(opt.code)) continue;
    const name = opt.name.toLowerCase();
    const code = opt.code.toLowerCase();
    if (name.startsWith(q) || code === q || code.startsWith(q)) {
      starts.push(opt);
    } else if (name.includes(q)) {
      contains.push(opt);
    }
  }
  const results = [...starts, ...contains];

  // Exact-code queries (regional variants like `fr-CA`) become addable even
  // when uncataloged, canonicalized to standard casing.
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(trimmed)) {
    try {
      const [canonical] = Intl.getCanonicalLocales(trimmed);
      const name = localeDisplayName(canonical);
      if (
        canonical &&
        name !== canonical &&
        !excludeSet.has(canonical) &&
        !results.some((r) => r.code === canonical)
      ) {
        results.unshift({ code: canonical, name });
      }
    } catch {
      // Not a valid locale — name/code matches above are all we have.
    }
  }
  return results.slice(0, limit);
}

/**
 * The locale a preview path is showing: its first segment when that's a
 * configured locale, otherwise the default locale.
 */
export function pathLocale(
  path: string,
  locales: string[],
  defaultLocale: string | null
): string | null {
  const first = path.replace(/^\/+/, '').split('/')[0];
  return locales.includes(first) ? first : defaultLocale;
}

/**
 * Rewrite a preview path to another locale: strips any existing locale
 * prefix, then prefixes the target unless it's the default (unprefixed
 * paths are the canonical form; i18n middleware redirects as needed).
 */
export function switchPathLocale(
  path: string,
  target: string,
  locales: string[],
  defaultLocale: string | null
): string {
  const segments = path.replace(/^\/+/, '').split('/').filter(Boolean);
  const rest = segments.length > 0 && locales.includes(segments[0]) ? segments.slice(1) : segments;
  const base = rest.length > 0 ? `/${rest.join('/')}` : '/';
  if (defaultLocale !== null && target === defaultLocale) return base;
  return base === '/' ? `/${target}` : `/${target}${base}`;
}

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

  if (status.framework === 'nextjs-app') {
    return (
      `This Next.js App Router project uses next-intl, configured in ${status.configFile ?? 'src/i18n/routing.ts'} ` +
      `with locales [${status.locales.join(', ')}] and defaultLocale "${defaultLocale}".\n\n` +
      `Please translate the site into: ${targetList}.\n\n` +
      `The content lives in per-locale JSON dictionaries (messages/<locale>.json, or wherever ` +
      `src/i18n/request.ts loads them from). For each target locale, translate every value in the ` +
      `dictionary from the ${defaultLocale} version. Keep the JSON structure and all keys identical, ` +
      `and preserve ICU syntax exactly ({placeholders}, plural/select forms, rich-text tags). ` +
      `Don't translate brand names, code samples, or URLs. ` +
      `If any user-facing text is still hardcoded in components instead of the dictionaries, extract it ` +
      `into all locales' dictionaries first (useTranslations/getTranslations), then translate. ` +
      `Ask me before adding any new dependencies.`
    );
  }

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
 * Fallback prompt when a save fails because the existing config can't be
 * edited safely (wrapped configs, unparseable i18n blocks / routing files).
 */
export function buildAiSetupPrompt(status: I18nStatus): string {
  const file =
    status.configFile ??
    (status.framework === 'astro' ? 'astro.config.mjs' : 'the framework config file');
  return (
    `Please set up internationalized routing for this project by adding or fixing the i18n ` +
    `configuration (a literal locales array + defaultLocale string) in ${file}. ` +
    `Ship Studio couldn't edit the config automatically, so review its current structure first ` +
    `and make the change in the appropriate place. Wait for my confirmation before installing anything.`
  );
}

/**
 * Optional cleanup after removing languages: Ship Studio only edits the
 * config (never deletes files), so translated content lingers — and Astro
 * keeps serving locale folders that still exist. This prompt asks the agent
 * to remove the leftovers.
 */
export function buildRemovalCleanupPrompt(status: I18nStatus, removed: string[]): string {
  const removedList = removed.map((l) => `${l} (${localeDisplayName(l)})`).join(', ');
  const kept = status.locales.join(', ');
  const frameworkFiles =
    status.framework === 'astro'
      ? `Delete the src/pages/<locale>/ folder for each removed locale — Astro keeps serving those pages as plain routes while the folders exist. Also delete any per-locale dictionaries for them.`
      : status.framework === 'nextjs-app'
        ? `Delete messages/<locale>.json for each removed locale (wherever the request config loads dictionaries from).`
        : `Delete the per-locale dictionary files for each removed locale (e.g. locales/<locale>.json), if the project has them.`;

  return (
    `I removed these languages from this project's i18n config: ${removedList}. ` +
    `The remaining locales are [${kept}].\n\n` +
    `Please clean up the leftover files for the removed languages so stale content isn't served or shipped. ` +
    `${frameworkFiles} ` +
    `Also update anything that still references the removed locales (language switchers, hreflang tags, generateStaticParams, sitemap entries). ` +
    `List every file you're going to delete BEFORE deleting it, only touch files for the removed locales, ` +
    `and verify the project still builds afterwards.`
  );
}

/**
 * The guided one-time App Router setup, executed by the embedded agent.
 * Pins the exact next-intl layout (file paths, literal locales array,
 * messages/<locale>.json) so the result lands in the shape Ship Studio's
 * backend knows how to detect and manage afterwards.
 */
export function buildAppRouterSetupPrompt(locales: string[], defaultLocale: string): string {
  const localeList = locales.map((l) => `${l} (${localeDisplayName(l)})`).join(', ');
  const localesArray = locales.map((l) => `'${l}'`).join(', ');

  return `Set up multilingual support (i18n) in this Next.js App Router project using next-intl.

Languages: ${localeList}. Default: ${defaultLocale}.

Complete ALL steps without stopping to ask — installing next-intl is approved. Important: Ship Studio reads and updates the files below, so keep the exact paths, the literal locales array in routing.ts, and the messages/<locale>.json layout.

1. Install next-intl using this project's package manager (check the lockfile).

2. Create the i18n config. Use src/i18n/ if the project has a src/ directory, otherwise i18n/ at the root, and adjust relative import paths to match.

src/i18n/routing.ts:
\`\`\`ts
import {defineRouting} from 'next-intl/routing';

export const routing = defineRouting({
  locales: [${localesArray}],
  defaultLocale: '${defaultLocale}'
});
\`\`\`

src/i18n/request.ts:
\`\`\`ts
import {getRequestConfig} from 'next-intl/server';
import {hasLocale} from 'next-intl';
import {routing} from './routing';

export default getRequestConfig(async ({requestLocale}) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return {
    locale,
    messages: (await import(\`../../messages/\${locale}.json\`)).default
  };
});
\`\`\`

src/i18n/navigation.ts:
\`\`\`ts
import {createNavigation} from 'next-intl/navigation';
import {routing} from './routing';

export const {Link, redirect, usePathname, useRouter, getPathname} =
  createNavigation(routing);
\`\`\`

3. Add the locale middleware. In Next.js 16+ this file is called proxy.ts; in earlier versions middleware.ts — check the installed Next version and name it accordingly (same directory level as the app/ directory's parent convention, i.e. src/ or root):
\`\`\`ts
import createMiddleware from 'next-intl/middleware';
import {routing} from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  matcher: '/((?!api|trpc|_next|_vercel|.*\\\\..*).*)'
};
\`\`\`

4. Wrap the Next.js config with the next-intl plugin (keep everything already in the config):
\`\`\`ts
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
\`\`\`

5. Move ALL page routes under a [locale] segment: app/page.tsx → app/[locale]/page.tsx, and so on for every route. Keep api routes, globals.css, favicon and other non-route files where they are. The locale layout (app/[locale]/layout.tsx) must validate the locale and wrap children in NextIntlClientProvider — merge this with whatever the existing root layout does (fonts, metadata, providers, analytics); don't drop anything:
\`\`\`tsx
import {NextIntlClientProvider, hasLocale} from 'next-intl';
import {notFound} from 'next/navigation';
import {setRequestLocale} from 'next-intl/server';
import {routing} from '@/i18n/routing';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({locale}));
}

export default async function LocaleLayout({children, params}) {
  const {locale} = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
\`\`\`

6. Create messages/<locale>.json at the project root for every language (${locales.map((l) => `${l}.json`).join(', ')}). Extract the user-facing strings from the pages into messages/${defaultLocale}.json, namespaced per component (e.g. {"HomePage": {"title": "..."}}), and replace the hardcoded strings with useTranslations('HomePage') in client/shared components or getTranslations in async server components. For the other locales, copy ${defaultLocale}.json as-is for now — translation happens in a separate step later.

7. Where internal navigation should be locale-aware, import Link/useRouter/usePathname/redirect from the new i18n/navigation file instead of next/link and next/navigation.

8. Verify the project builds (or at minimum typechecks and the dev server renders) and fix any errors. Then give me a short summary of what changed.`;
}
