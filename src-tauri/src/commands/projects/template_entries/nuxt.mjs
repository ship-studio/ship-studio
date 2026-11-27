import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const [root, file, pattern] = process.argv.slice(1);
const emit = (payload) =>
  process.stdout.write(`\n__SHIPSTUDIO_TEMPLATE_ENTRIES__${JSON.stringify(payload)}`);
const safeSegment = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value !== '.' &&
  value !== '..' &&
  !/[\\?#\u0000-\u001f]/.test(value);
let nuxt;
try {
  const require = createRequire(path.join(root, 'package.json'));
  const packagePath = require.resolve('nuxt/package.json');
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const importEntry = manifest.exports?.['.']?.import || manifest.module || manifest.main;
  if (!importEntry) throw new Error('Nuxt does not declare an ESM entry point.');
  const nuxtEntry = path.resolve(path.dirname(packagePath), importEntry);
  const { loadNuxt } = await import(pathToFileURL(nuxtEntry).href);
  const generatedRoutes = [];
  const nitroConfigs = [];
  nuxt = await loadNuxt({ cwd: root, dev: true, ready: false });
  nuxt.hook('nitro:config', (config) => {
    // Nuxt config may append routes in a later async hook, so retain the
    // mutable config and read it after Nuxt has finished initialization.
    nitroConfigs.push(config);
  });
  nuxt.hook('prerender:routes', (routes) => {
    const values = routes?.routes ?? routes;
    if (values && Symbol.iterator in Object(values)) generatedRoutes.push(...values);
  });
  await nuxt.ready();
  const nitroConfig = nuxt.options.nitro || {};
  const pagesRoot = path.resolve(nuxt.options.srcDir || root, 'pages');
  const relativePage = path.relative(pagesRoot, path.resolve(file));
  if (relativePage.startsWith('..') || path.isAbsolute(relativePage)) {
    throw new Error('This Nuxt page is outside the configured srcDir pages directory.');
  }
  const base = String(nuxt.options.app?.baseURL || nitroConfig.baseURL || '/');
  const basePath = base === '/' ? '' : `/${base.split('/').filter(Boolean).join('/')}`;
  // Rust derives this from the canonical source path, preserving Nuxt catch-all syntax.
  const routePattern = pattern;
  const routeParts = [...routePattern.matchAll(/:([A-Za-z0-9_]+)(\(\*\))?/g)].map((m) => ({
    name: m[1],
    catchall: !!m[2],
  }));
  if (!routeParts.length) throw new Error('This Nuxt page does not have dynamic route parameters.');

  // Nitro's configured prerender list is authoritative; it includes routes
  // supplied by Nuxt config/modules without crawling or building the site.
  const configured = new Set([
    ...(nitroConfig.prerender?.routes || []),
    ...nitroConfigs.flatMap((config) => config.prerender?.routes || []),
    ...generatedRoutes,
  ]);
  const entries = [];
  const seen = new Set();
  for (const candidate of configured) {
    if (
      typeof candidate !== 'string' ||
      !candidate.startsWith('/') ||
      candidate.includes('?') ||
      candidate.includes('#')
    )
      continue;
    const normalizedCandidate =
      basePath && candidate !== basePath && !candidate.startsWith(`${basePath}/`)
        ? `${basePath}${candidate}`
        : candidate;
    const withoutBase =
      basePath &&
      (normalizedCandidate === basePath || normalizedCandidate.startsWith(`${basePath}/`))
        ? normalizedCandidate.slice(basePath.length) || '/'
        : normalizedCandidate;
    const template = routePattern.split('/');
    const concrete = withoutBase.split('/');
    let valid = true;
    const labels = [];
    for (let i = 0; valid && i < template.length; i++) {
      const match = /^:([A-Za-z0-9_]+)(\(\*\))?$/.exec(template[i]);
      if (match) {
        if (!match[2] && i >= concrete.length) {
          valid = false;
          break;
        }
        if (match[2] && i !== template.length - 1) {
          valid = false;
          break;
        }
        let segments;
        try {
          segments = match[2]
            ? concrete.slice(i).map((segment) => decodeURIComponent(segment))
            : [decodeURIComponent(concrete[i] || '')];
        } catch {
          valid = false;
          break;
        }
        if (segments.some((value) => !safeSegment(value))) valid = false;
        else labels.push(segments.join('/'));
        if (match[2]) {
          i = template.length;
          break;
        }
      } else if (template[i] !== concrete[i]) valid = false;
    }
    if (concrete.length !== template.length && !routePattern.endsWith('(*)')) valid = false;
    if (!valid || seen.has(normalizedCandidate)) continue;
    seen.add(normalizedCandidate);
    entries.push({ route: normalizedCandidate, label: labels.at(-1) || normalizedCandidate });
    if (entries.length >= 500) break;
  }
  emit({ entries });
} catch (error) {
  emit({ entries: [], error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 2;
} finally {
  await nuxt?.close().catch(() => {});
}
