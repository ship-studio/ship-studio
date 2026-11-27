import path from 'node:path';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const MARKER = '\n__SHIPSTUDIO_TEMPLATE_ENTRIES__';
const MAX_ENTRIES = 500;
const [rootArg, fileArg, displayRouteArg] = process.argv.slice(1);
const root = path.resolve(rootArg || process.cwd());
const file = path.resolve(fileArg || '');
const displayRoute = displayRouteArg || '';

function emit(entries = [], error) {
  const payload = { entries, ...(error ? { error } : {}) };
  process.stdout.write(`${MARKER}${JSON.stringify(payload)}\n`);
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/require Node\.js 22\.15/.test(message))
    return 'Next.js dynamic entries require Node.js 22.15 or newer. Update Node.js and try again.';
  // Avoid surfacing stack traces, file paths, env values, or framework internals.
  if (/timeout|timed out/i.test(message)) return 'Dynamic entry discovery took too long.';
  if (/not found|cannot find|module/i.test(message))
    return 'Next.js could not load this route. Check its imports and project dependencies.';
  if (/export|static params|paths/i.test(message))
    return 'This route did not return concrete dynamic entries.';
  return 'Next.js could not resolve this route’s dynamic entries.';
}

function routeParameters(route) {
  return [...route.matchAll(/\[\[\.\.\.([^\]]+)\]\]|\[\.\.\.([^\]]+)\]|\[([^\]]+)\]/g)].map(
    (match) => ({
      name: match[1] || match[2] || match[3],
      catchall: Boolean(match[1] || match[2]),
      optional: Boolean(match[1]),
    })
  );
}

function parseJsonc(source) {
  let output = '';
  let quote = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = false;
    } else if (char === '"') {
      quote = true;
      output += char;
    } else if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
    } else if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
    } else {
      output += char;
    }
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, '$1'));
}

function readTsconfig(configPath, seen = new Set()) {
  const absolute = path.resolve(configPath);
  if (seen.has(absolute)) return {};
  seen.add(absolute);
  const config = parseJsonc(readFileSync(absolute, 'utf8'));
  let parentPath = null;
  if (config.extends) {
    const extended = config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`;
    if (extended.startsWith('.') || path.isAbsolute(extended)) {
      parentPath = path.resolve(path.dirname(absolute), extended);
    } else {
      try {
        parentPath = require.resolve(extended, { paths: [path.dirname(absolute)] });
      } catch {}
    }
  }
  const parent = parentPath && existsSync(parentPath) ? readTsconfig(parentPath, seen) : {};
  const compilerOptions = config.compilerOptions || {};
  const baseUrl = path.resolve(
    path.dirname(absolute),
    compilerOptions.baseUrl || parent.compilerOptions?.baseUrl || '.'
  );
  const localPaths = Object.fromEntries(
    Object.entries(compilerOptions.paths || {}).map(([pattern, candidates]) => [
      pattern,
      (Array.isArray(candidates) ? candidates : [candidates]).map((candidate) =>
        path.resolve(baseUrl, candidate)
      ),
    ])
  );
  return {
    ...parent,
    ...config,
    compilerOptions: {
      ...(parent.compilerOptions || {}),
      ...compilerOptions,
      baseUrl,
      paths: { ...(parent.compilerOptions?.paths || {}), ...localPaths },
    },
  };
}

function withTimeout(operation, milliseconds = 22000) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function findRouterRoot(routeFile, routerName) {
  let directory = path.dirname(routeFile);
  while (true) {
    const relative = path.relative(root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    if (path.basename(directory) === routerName) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function activeRouterForFile(routeFile) {
  const candidates = [
    { router: 'app', directory: path.join(root, 'app') },
    { router: 'app', directory: path.join(root, 'src', 'app') },
    { router: 'pages', directory: path.join(root, 'pages') },
    { router: 'pages', directory: path.join(root, 'src', 'pages') },
  ]
    .filter(({ directory }) => existsSync(directory) && routeFile.startsWith(`${directory}${path.sep}`))
    .sort((a, b) => b.directory.length - a.directory.length);
  return candidates[0] || null;
}

function routePatternForFile(routeFile, routerName) {
  const routerRoot = findRouterRoot(routeFile, routerName);
  if (!routerRoot) return displayRoute.replace(/:[A-Za-z0-9_-]+/g, (key) => `[${key.slice(1)}]`);
  let relative = path.relative(routerRoot, routeFile).replace(/\\/g, '/');
  relative = relative.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
  if (routerName === 'pages') {
    relative = relative.replace(/(^|\/)index$/, '$1').replace(/^index$/, '');
    return `/${relative}`.replace(/\/$/, '') || '/';
  }
  relative = relative.replace(/(^|\/)page$/, '$1').replace(/^page$/, '');
  relative = relative
    .split('/')
    .filter((part) => part && !/^\([^/]+\)$/.test(part) && !part.startsWith('@'))
    .join('/');
  return `/${relative}`;
}

function concretize(routePattern, params, basePath, trailingSlash) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const names = routeParameters(routePattern);
  let route = routePattern;
  const labels = [];
  for (const part of names) {
    const token = part.optional
      ? `[[...${part.name}]]`
      : part.catchall
        ? `[...${part.name}]`
        : `[${part.name}]`;
    const value = params[part.name];
    if (value == null && part.optional) {
      route = route.replace(token, '');
      continue;
    }
    if (value == null) return null;
    const values = Array.isArray(value)
      ? value.map(String)
      : part.catchall
        ? String(value).split('/')
        : [String(value)];
    if (
      (!values.length && !part.optional) ||
      values.some(
        (segment) => !segment || segment === '.' || segment === '..' || /[\\/?#]/.test(segment)
      )
    )
      return null;
    route = route.replace(token, values.map(encodeURIComponent).join('/'));
    labels.push(values.join('/'));
  }
  if (/\[[^\]]+\]/.test(route)) return null;
  if (basePath && basePath !== '/')
    route = `${basePath.replace(/\/$/, '')}${route.startsWith('/') ? route : `/${route}`}`;
  if (trailingSlash && route !== '/' && !route.endsWith('/')) route += '/';
  return { route: route || '/', label: labels.join(' / ') || routePattern };
}

function normalizeStaticPath(route, routePattern, locale) {
  if (!route.startsWith('/') || route.startsWith('//') || /[?#\\]/.test(route)) return null;
  const parts = route.split('/');
  if (parts.some((part) => part === '.' || part === '..')) return null;
  const expected = routePattern.split('/').filter(Boolean);
  const actual = parts.filter(Boolean);
  const locales = nextConfig.i18n?.locales || [];
  if (locales.includes(actual[0]) && !locales.includes(expected[0])) actual.shift();
  let expectedIndex = 0;
  let actualIndex = 0;
  while (expectedIndex < expected.length) {
    const segment = expected[expectedIndex];
    const optionalCatchall = /^\[\[\.\.\.[^\]]+\]\]$/.test(segment);
    const catchall = /^\[\.\.\.[^\]]+\]$/.test(segment) || optionalCatchall;
    if (catchall) {
      const remaining = actual.length - actualIndex;
      if (remaining < 1 && !optionalCatchall) return null;
      actualIndex = actual.length;
    } else {
      if (actualIndex >= actual.length) return null;
      if (!/^\[[^\]]+\]$/.test(segment) && segment !== actual[actualIndex]) return null;
      actualIndex += 1;
    }
    expectedIndex += 1;
  }
  if (actualIndex !== actual.length) return null;
  if (locale && locales.includes(locale) && locale !== nextConfig.i18n?.defaultLocale) {
    route = `/${locale}${route}`;
  }
  const basePath = nextConfig.basePath || '';
  if (basePath && basePath !== '/' && !route.startsWith(`${basePath}/`) && route !== basePath)
    route = `${basePath}${route}`;
  if (nextConfig.trailingSlash && route !== '/' && !route.endsWith('/')) route += '/';
  const labelRoute =
    basePath && route.startsWith(`${basePath}/`) ? route.slice(basePath.length) : route;
  return { route, label: labelRoute.replace(/^\/+|\/+$/g, '') || '/' };
}

const require = createRequire(path.join(root, 'package.json'));
let nextConfig = {};
let aliasEntries = [];
let transpile;
let transpileExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function readAliases(config) {
  const compilerOptions = config?.compilerOptions || {};
  const base = path.resolve(root, compilerOptions.baseUrl || '.');
  return Object.entries(compilerOptions.paths || {}).map(([pattern, candidates]) => ({
    regex: new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'))
        .join('(.+)')}$`
    ),
    candidates: (Array.isArray(candidates) ? candidates : [candidates]).map((value) =>
      path.resolve(base, value)
    ),
  }));
}

function resolveAlias(specifier) {
  for (const alias of aliasEntries) {
    const match = specifier.match(alias.regex);
    if (!match) continue;
    for (const candidate of alias.candidates) {
      const resolved = candidate.replace('*', match[1] || '');
      for (const suffix of ['', ...transpileExtensions, '/index.ts', '/index.tsx', '/index.js']) {
        const target = `${resolved}${suffix}`;
        try {
          if (require.resolve(target)) return pathToFileURL(target).href;
        } catch {}
      }
    }
  }
  return null;
}

async function loadConfig() {
  const nextConfigModule = await import(
    pathToFileURL(require.resolve('next/dist/server/config')).href
  );
  const loadNextConfig =
    nextConfigModule.default?.default || nextConfigModule.default || nextConfigModule.loadConfig;
  if (typeof loadNextConfig !== 'function') throw new Error('Next config loader unavailable');
  nextConfig = await loadNextConfig('phase-development-server', root);
  try {
    const configPath = path.join(root, 'tsconfig.json');
    aliasEntries = readAliases(readTsconfig(configPath));
  } catch {}
}

async function installLoader() {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 15)) {
    throw new Error('Next.js dynamic entries require Node.js 22.15 or newer for the TypeScript loader.');
  }
  try {
    const typescript = await import(pathToFileURL(require.resolve('typescript')).href);
    transpile = (source, options) => ({
      code: typescript.transpileModule(source, {
        fileName: options.filename,
        compilerOptions: {
          module: typescript.ModuleKind.ESNext,
          target: typescript.ScriptTarget.ES2022,
          jsx: typescript.JsxEmit.ReactJSX,
          esModuleInterop: true,
        },
      }).outputText,
    });
  } catch {
    try {
      const swc = await import(pathToFileURL(require.resolve('next/dist/build/swc')).href);
      if (typeof swc.transformSync !== 'function') return false;
      transpile = (source, options) => swc.transformSync(source, options);
    } catch {
      return false;
    }
  }
  const { registerHooks } = await import('node:module');
  if (typeof registerHooks !== 'function') return false;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'server-only') return { url: 'data:text/javascript,', shortCircuit: true };
      const aliased = resolveAlias(specifier);
      if (aliased) return nextResolve(aliased, context);
      if (specifier.startsWith('.') && !path.extname(specifier)) {
        for (const extension of transpileExtensions) {
          try {
            return nextResolve(`${specifier}${extension}`, context);
          } catch {}
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const pathname = fileURLToPath(url);
      if (/\.(css|scss|sass|less)$/i.test(pathname)) {
        return { format: 'module', source: 'export default {};', shortCircuit: true };
      }
      const relative = path.relative(realpathSync(root), realpathSync(pathname));
      if (
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).includes('node_modules')
      ) {
        return nextLoad(url, context);
      }
      if (!transpileExtensions.some((extension) => pathname.endsWith(extension)))
        return nextLoad(url, context);
      const source = readFileSync(pathname, 'utf8');
      const result = transpile(source, {
        filename: pathname,
        jsc: {
          parser: {
            syntax: pathname.match(/\.tsx?$/) ? 'typescript' : 'ecmascript',
            tsx: pathname.endsWith('.tsx'),
            jsx: pathname.endsWith('.jsx'),
            decorators: true,
          },
          target: 'es2022',
          transform: { react: { runtime: 'automatic' } },
        },
        module: { type: 'es6' },
      });
      return { format: 'module', source: result.code, shortCircuit: true };
    },
  });
  return true;
}

async function importRoute(routeFile) {
  return import(`${pathToFileURL(routeFile).href}?shipstudio=${Date.now()}-${Math.random()}`);
}

function mayExportStaticParams(routeFile) {
  const source = readFileSync(routeFile, 'utf8');
  return /\bgenerateStaticParams\b|\bexport\s*\*\s*from\b/.test(source);
}

async function evaluatePagesRouter(routePattern) {
  const module = await importRoute(file);
  if (typeof module.getStaticPaths !== 'function') throw new Error('No getStaticPaths export');
  const result = await withTimeout(() =>
    module.getStaticPaths({
      locales: nextConfig.i18n?.locales,
      defaultLocale: nextConfig.i18n?.defaultLocale,
    })
  );
  const paths = Array.isArray(result) ? result : result?.paths;
  if (!Array.isArray(paths)) throw new Error('Invalid paths result');
  const entries = [];
  const seen = new Set();
  for (const item of paths.slice(0, MAX_ENTRIES)) {
    let entry;
    if (typeof item === 'string') {
      entry = normalizeStaticPath(item, routePattern);
    } else if (typeof item?.params === 'object') {
      entry = concretize(
        routePattern,
        item.params,
        nextConfig.basePath || '',
        nextConfig.trailingSlash === true
      );
      if (
        entry &&
        item.locale &&
        nextConfig.i18n?.locales?.includes(item.locale) &&
        item.locale !== nextConfig.i18n.defaultLocale
      ) {
        const basePath = nextConfig.basePath || '';
        const routeWithoutBasePath =
          basePath && entry.route.startsWith(basePath)
            ? entry.route.slice(basePath.length)
            : entry.route;
        entry.route = `${basePath}/${item.locale}${routeWithoutBasePath}`;
        if (nextConfig.trailingSlash && !entry.route.endsWith('/')) entry.route += '/';
      }
    }
    if (entry && !seen.has(entry.route)) {
      seen.add(entry.route);
      entries.push(entry);
    }
  }
  return entries;
}

async function evaluateAppRouter(routePattern) {
  const appRoot = findRouterRoot(file, 'app') || findRouterRoot(file, 'src');
  if (!appRoot) throw new Error('Could not find app router root');
  routePattern = routePatternForFile(file, 'app');

  // A route may be exported from page.tsx, while generateStaticParams can live
  // on any ancestor layout. Evaluate those layouts in segment order so each
  // child receives the parent params, as Next's App Router does.
  let parentTrees = [{}];
  const folders = [];
  let folder = path.dirname(file);
  while (folder === appRoot || folder.startsWith(`${appRoot}${path.sep}`)) {
    folders.push(folder);
    if (folder === appRoot) break;
    folder = path.dirname(folder);
  }
  folders.reverse();
  for (const folder of folders) {
    const layout = ['tsx', 'ts', 'jsx', 'js']
      .map((ext) => path.join(folder, `layout.${ext}`))
      .find((candidate) => candidate === file || require('node:fs').existsSync(candidate));
    if (!layout || !mayExportStaticParams(layout)) continue;
    const module = await importRoute(layout);
    if (typeof module.generateStaticParams !== 'function') continue;
    const nextTrees = [];
    for (const parentParams of parentTrees) {
      const result = await withTimeout(() => module.generateStaticParams({ params: parentParams }));
      if (!Array.isArray(result)) throw new Error('Invalid static params result');
      for (const row of result)
        if (row && typeof row === 'object') nextTrees.push({ ...parentParams, ...row });
      if (nextTrees.length >= MAX_ENTRIES) break;
    }
    parentTrees = nextTrees;
    if (!parentTrees.length) return [];
  }
  const routeModule = await importRoute(file);
  if (typeof routeModule.generateStaticParams === 'function') {
    const nextTrees = [];
    for (const parentParams of parentTrees) {
      const result = await withTimeout(() =>
        routeModule.generateStaticParams({ params: parentParams })
      );
      if (!Array.isArray(result)) throw new Error('Invalid static params result');
      for (const row of result)
        if (row && typeof row === 'object') nextTrees.push({ ...parentParams, ...row });
      if (nextTrees.length >= MAX_ENTRIES) break;
    }
    parentTrees = nextTrees;
  }
  const entries = [];
  const seen = new Set();
  for (const params of parentTrees.slice(0, MAX_ENTRIES)) {
    const entry = concretize(
      routePattern,
      params,
      nextConfig.basePath || '',
      nextConfig.trailingSlash === true
    );
    if (entry && !seen.has(entry.route)) {
      seen.add(entry.route);
      entries.push(entry);
    }
  }
  return entries;
}

try {
  if (!rootArg || !fileArg || !displayRoute) throw new Error('Missing route inputs');
  await loadConfig();
  if (!(await installLoader())) throw new Error('TypeScript loader unavailable');
  const activeRouter = activeRouterForFile(file);
  if (!activeRouter) throw new Error('Could not determine the active Next.js router root');
  const isPagesRouter = activeRouter.router === 'pages';
  const routePattern = routePatternForFile(file, isPagesRouter ? 'pages' : 'app');
  const entries = isPagesRouter
    ? await evaluatePagesRouter(routePattern)
    : await evaluateAppRouter(routePattern);
  emit(
    entries.slice(0, MAX_ENTRIES),
    entries.length
      ? undefined
      : 'Next.js returned no concrete entries. For on-demand routes, add concrete entries to .shipstudio/template-entries.json.'
  );
} catch (error) {
  emit([], safeError(error));
}
