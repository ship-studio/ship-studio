#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'src');
const stylesRoot = path.join(sourceRoot, 'styles');
const entryPath = path.join(stylesRoot, 'index.css');
const genericSelectorPattern = /(^|[^a-zA-Z0-9_-])\.hint\b/g;

function relativePath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

function walk(directory, predicate) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(filePath, predicate));
    } else if (predicate(filePath)) {
      files.push(filePath);
    }
  }
  return files;
}

function resolveLocalCss(importerPath, specifier) {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(importerPath), specifier);
  return path.extname(resolved) === '.css' ? resolved : `${resolved}.css`;
}

function readIndexImports() {
  const source = fs.readFileSync(entryPath, 'utf8');
  return [...source.matchAll(/@import\s+['"]([^'"]+\.css)['"]\s*;/g)].map((match) => ({
    importer: entryPath,
    specifier: match[1],
    filePath: resolveLocalCss(entryPath, match[1]),
  }));
}

function readModuleImports() {
  const imports = [];
  const moduleFiles = walk(sourceRoot, (filePath) => /\.(?:ts|tsx|js|jsx)$/.test(filePath));
  const importPattern = /\bimport\s+(?:(?:[^'";]*?)\s+from\s+)?['"]([^'"]+\.css)['"]/g;

  for (const importer of moduleFiles) {
    const source = fs.readFileSync(importer, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const filePath = resolveLocalCss(importer, match[1]);
      if (filePath) imports.push({ importer, specifier: match[1], filePath });
    }
  }

  return imports;
}

function collectOwnership() {
  const indexImports = readIndexImports();
  const moduleImports = readModuleImports();
  const ownership = new Map();

  for (const entry of indexImports) {
    if (!entry.filePath) continue;
    const row = ownership.get(entry.filePath) ?? { manifest: false, importers: new Set() };
    row.manifest = true;
    ownership.set(entry.filePath, row);
  }

  for (const entry of moduleImports) {
    const row = ownership.get(entry.filePath) ?? { manifest: false, importers: new Set() };
    row.importers.add(entry.importer);
    ownership.set(entry.filePath, row);
  }

  return { indexImports, moduleImports, ownership };
}

function displayOwner(filePath, row) {
  if (row.importers.size > 0) {
    return [...row.importers].map(relativePath).sort().join(', ');
  }
  return relativePath(entryPath);
}

function selectorPolicy(relative) {
  if (relative === 'src/styles/index.css') return 'Import manifest only';
  if (relative.startsWith('src/styles/global/tokens-')) return 'Token definitions only';
  if (relative === 'src/styles/global/fonts.css') return 'Font-face declarations';
  if (relative === 'src/styles/global/base.css') return 'Plugin-stable and shared global primitives';
  if (relative === 'src/styles/global/typography.css') return 'Shared typography helper selectors';
  if (relative.startsWith('src/styles/components/')) return 'Shared primitive/component selectors';
  if (relative.startsWith('src/styles/modes/')) return 'Mode-scoped selectors';
  return 'Feature/domain selectors; review global leakage';
}

function reportOwnership() {
  const { ownership } = collectOwnership();
  console.log('| Stylesheet | Import owner | Scope / domain | Selector policy | Order dependency |');
  console.log('| --- | --- | --- | --- | --- |');

  for (const filePath of [...ownership.keys()].sort()) {
    const row = ownership.get(filePath);
    const relative = relativePath(filePath);
    const parts = relative.split('/');
    const scope = parts[2] === 'global' ? 'global tokens/base' : parts[2] ?? 'styles';
    const domain = parts.slice(3).join('/').replace(/\.css$/, '') || scope;
    const order = row.manifest
      ? scope === 'global tokens/base'
        ? 'Manifest order is required'
        : 'Manifest order retained during staged migration'
        : 'Module import owner controls load point';
    console.log(
      `| \`${relative}\` | \`${displayOwner(filePath, row)}\` | ${scope} / ${domain} | ${selectorPolicy(relative)} | ${order} |`
    );
  }
}

function checkOwnership() {
  const diagnostics = [];
  const { indexImports, moduleImports, ownership } = collectOwnership();
  const cssFiles = walk(stylesRoot, (filePath) => path.extname(filePath) === '.css');

  for (const entry of [...indexImports, ...moduleImports]) {
    if (entry.filePath && !fs.existsSync(entry.filePath)) {
      diagnostics.push(
        `${relativePath(entry.importer)} imports missing stylesheet ${entry.specifier}`
      );
    }
  }

  for (const [filePath, row] of ownership) {
    if (!row.manifest || row.importers.size === 0) continue;
    diagnostics.push(
      `${relativePath(filePath)} has duplicate ownership: ${relativePath(entryPath)} and ${[
        ...row.importers,
      ]
        .map(relativePath)
        .sort()
        .join(', ')}`
    );
  }

  for (const filePath of cssFiles) {
    const source = fs
      .readFileSync(filePath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    if (!genericSelectorPattern.test(source)) continue;
    genericSelectorPattern.lastIndex = 0;
    diagnostics.push(
      `${relativePath(filePath)} uses the generic .hint selector; use a named semantic helper or a domain-scoped class`
    );
  }

  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) console.error(`css-ownership: ${diagnostic}`);
    return false;
  }

  console.log(`CSS ownership check passed (${cssFiles.length} stylesheets inventoried).`);
  return true;
}

if (process.argv.includes('--report')) {
  reportOwnership();
} else if (!checkOwnership()) {
  process.exitCode = 1;
}

export { checkOwnership, collectOwnership };
