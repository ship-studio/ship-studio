import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [rootArg, fileArg, displayRoute] = process.argv.slice(1);
const root = path.resolve(rootArg || '.');
const file = path.resolve(fileArg || '.');
let server;
let parseRouteId;

function routeIdFromFile(rootPath, sourceFile) {
  const routesRoot = path.resolve(rootPath, 'src', 'routes');
  const relative = path.relative(routesRoot, path.dirname(sourceFile));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('This SvelteKit page is outside the active src/routes directory.');
  }
  return relative === '.' ? '/' : `/${relative.split(path.sep).join('/')}`;
}

const output = (payload) => {
  process.stdout.write(`\n__SHIPSTUDIO_TEMPLATE_ENTRIES__${JSON.stringify(payload)}`);
};

function toRoute(routeId, values, base, trailingSlash, params) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  const parts = routeId
    .split('/')
    .filter(Boolean)
    .filter((part) => !/^\(.+\)$/.test(part) && !/^@/.test(part));
  const routeParts = [];
  for (const segment of parts) {
    const tokens = /\[\[(\.\.\.)?([\w-]+)(?:=[\w-]+)?\]\]|\[(\.\.\.)?([\w-]+)(?:=[\w-]+)?\]/g;
    let rendered = '';
    let offset = 0;
    for (const match of segment.matchAll(tokens)) {
      rendered += segment.slice(offset, match.index);
      const optional = match[0].startsWith('[[');
      const rest = Boolean(match[1] || match[3]);
      const name = match[2] || match[4];
      const value = values[name];
      if (value === undefined || value === null || value === '') {
        if (!optional && !rest) return null;
      } else {
        const pieces = Array.isArray(value)
          ? value.map(String)
          : rest
            ? String(value).split('/')
            : [String(value)];
        if (pieces.some((part) => !part || part === '.' || part === '..' || /[\\?#]/.test(part)))
          return null;
        rendered += pieces.map((part) => encodeURIComponent(part)).join('/');
      }
      offset = match.index + match[0].length;
    }
    rendered += segment.slice(offset);
    if (rendered) routeParts.push(rendered);
  }
  let route = '/' + routeParts.join('/');
  if (!parseRouteId(routeId).pattern.test(route)) return null;
  if (params.some((param) => !Object.hasOwn(values, param.name) && !param.optional && !param.rest))
    return null;
  const prefix = typeof base === 'string' && base !== '/' ? base.replace(/\/$/, '') : '';
  if (prefix && route !== prefix && !route.startsWith(`${prefix}/`)) route = `${prefix}${route}`;
  if (trailingSlash === 'always' && route !== '/' && !route.endsWith('/')) route += '/';
  if (trailingSlash === 'never' && route.length > 1) route = route.replace(/\/$/, '');
  return route || '/';
}

try {
  if (!rootArg || !fileArg || !displayRoute)
    throw new Error(
      'SvelteKit entry resolution requires a project root, source page, and display route.'
    );
  if (!fs.existsSync(path.join(root, 'package.json')))
    throw new Error('The SvelteKit project package.json could not be found.');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    throw new Error('The selected SvelteKit page file no longer exists.');
  const sourceRoutes = path.join(root, 'src', 'routes');
  if (
    !fs.existsSync(sourceRoutes) ||
    !path.resolve(file).startsWith(`${path.resolve(sourceRoutes)}${path.sep}`)
  ) {
    throw new Error('This SvelteKit page is outside the active src/routes directory.');
  }
  const require = createRequire(path.join(root, 'package.json'));
  const vitePath = require.resolve('vite');
  const vite = await import(pathToFileURL(vitePath).href);
  const kitRoot = path.dirname(require.resolve('@sveltejs/kit/package.json'));
  ({ parse_route_id: parseRouteId } = await import(
    pathToFileURL(path.join(kitRoot, 'src/utils/routing.js')).href
  ));
  const { extract_svelte_config: extractSvelteConfig } = await import(
    pathToFileURL(path.join(kitRoot, 'src/core/config/index.js')).href
  );
  server = await vite.createServer({
    // Let Vite discover vite.config.ts, .mts, .js, etc. and load the project's
    // real plugins, aliases, and SSR configuration.
    root,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  });

  const modules = [];
  for (const suffix of [
    '+page.server.ts',
    '+page.server.js',
    '+page.server.mjs',
    '+page.ts',
    '+page.js',
    '+page.mjs',
  ]) {
    const candidate = path.join(path.dirname(file), suffix);
    if (!fs.existsSync(candidate)) continue;
    try {
      const loaded = await server.ssrLoadModule(candidate);
      if (Object.prototype.hasOwnProperty.call(loaded, 'entries')) modules.push(loaded);
    } catch (error) {
      throw new Error(
        `Could not load ${suffix} for this SvelteKit route. Check the page module and its dependencies.`
      );
    }
  }

  const config = extractSvelteConfig(server.config);
  const routeId = routeIdFromFile(root, file);
  const parsedRoute = parseRouteId(routeId);
  const base = config.paths?.base || '';
  let trailingSlash = 'never';
  const entries = [];
  const seen = new Set();
  const add = (route, label) => {
    if (
      !route ||
      !route.startsWith('/') ||
      route.startsWith('//') ||
      /\[[^\]]+\]/.test(route) ||
      seen.has(route)
    )
      return;
    seen.add(route);
    entries.push({ route, label: String(label || route).slice(0, 120) });
  };

  for (const mod of modules) {
    if (['always', 'never', 'ignore'].includes(mod.trailingSlash))
      trailingSlash = mod.trailingSlash;
    let values = mod.entries;
    if (typeof values === 'function') {
      let timer;
      try {
        values = await Promise.race([
          Promise.resolve().then(() => values()),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('The SvelteKit entries function took too long to respond.')),
              15000
            );
          }),
        ]).finally(() => clearTimeout(timer));
      } catch {
        throw new Error(
          'The SvelteKit page entries function failed or timed out. Check the generator and its dependencies.'
        );
      }
    }
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === 'string' && parsedRoute.params.length !== 1) continue;
      const params = typeof value === 'string' ? { [parsedRoute.params[0].name]: value } : value;
      const route = toRoute(routeId, params, base, trailingSlash, parsedRoute.params);
      if (route)
        add(
          route,
          typeof value === 'string'
            ? value
            : Object.values(params).filter(Boolean).join('/') || route
        );
      if (entries.length >= 500) break;
    }
  }

  // Concrete prerender entries are useful for routes whose page does not export
  // entries. Include only paths matching this page's route pattern.
  for (const candidate of config.prerender?.entries || []) {
    if (typeof candidate !== 'string' || !candidate.startsWith('/') || candidate.startsWith('//'))
      continue;
    const noBase =
      base && (candidate === base || candidate.startsWith(`${base}/`))
        ? candidate.slice(base.length) || '/'
        : candidate;
    if (!parsedRoute.pattern.test(noBase)) continue;
    let route =
      base && candidate !== base && !candidate.startsWith(`${base}/`)
        ? `${base.replace(/\/$/, '')}${candidate}`
        : candidate;
    if (trailingSlash === 'always' && route !== '/' && !route.endsWith('/')) route += '/';
    if (trailingSlash === 'never' && route.length > 1) route = route.replace(/\/$/, '');
    add(route, noBase.split('/').filter(Boolean).at(-1) || route);
    if (entries.length >= 500) break;
  }

  output({ entries: entries.slice(0, 500) });
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const safeError =
    message.startsWith('SvelteKit ') ||
    message.startsWith('This SvelteKit ') ||
    message.startsWith('The selected SvelteKit ')
      ? message.slice(0, 240)
      : 'SvelteKit could not resolve this page’s entries. Check project configuration, page modules, and dependencies.';
  output({ entries: [], error: safeError });
  process.exitCode = 2;
} finally {
  if (server) await server.close().catch(() => {});
}
