#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTokenGraph } from './check-css-tokens.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(projectRoot, 'src/styles/global/token-manifest.json');
const inventoryPath = path.join(projectRoot, 'src/styles/global/token-inventory.json');
const baselinePath = path.join(projectRoot, 'scripts/token-layer-baseline.json');
const indexPath = path.join(projectRoot, 'src/styles/index.css');
const tokenReference = /var\(\s*(--[a-zA-Z0-9-]+)/g;

const pluginStableExact = new Set([
  '--accent',
  '--action',
  '--border',
  '--error',
  '--font-code',
  '--success',
  '--warning',
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function relativePath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

function manifestFiles(manifest) {
  return manifest.layers.flatMap((layer) => layer.files);
}

function layerByFile(manifest) {
  return new Map(manifest.layers.flatMap((layer) => layer.files.map((file) => [file, layer.name])));
}

function tokenFilesAbsolute(manifest) {
  return new Set(manifestFiles(manifest).map((file) => path.resolve(projectRoot, file)));
}

function pluginStable(name) {
  return pluginStableExact.has(name) || name.startsWith('--bg-') || name.startsWith('--text-');
}

function ownerFor(name, layer, isPluginStable) {
  if (layer === 'core') return 'global/core';
  if (layer === 'semantic') return 'global/semantic';
  if (layer === 'compatibility') {
    return isPluginStable ? 'plugin-compatibility' : 'migration';
  }
  if (name.startsWith('--button-')) return 'Button';
  if (name.startsWith('--property-')) return 'PropertyField';
  if (name.startsWith('--editor-')) return 'VisualEditor';
  if (name.startsWith('--tree-')) return 'ElementTree';
  if (name.startsWith('--size-icon-') || name === '--icon-size-full') return 'IconGallery';
  if (name.startsWith('--size-sidebar-')) return 'WorkspaceSidebar';
  if (name.startsWith('--z-')) return 'GlobalOverlay';
  if (name.startsWith('--control-height-')) return 'Control';
  return 'global/component';
}

function statusFor(layer, isPluginStable) {
  if (layer === 'compatibility') return isPluginStable ? 'compatibility' : 'migration';
  return 'canonical';
}

function removalConditionFor(status) {
  if (status === 'migration') {
    return 'Remove after internal consumers migrate to the canonical semantic role.';
  }
  return undefined;
}

function externalReferences(references, tokenFiles) {
  return references.filter(
    (reference) => !tokenFiles.has(path.resolve(reference.filePath)) && !reference.inDefinition
  );
}

function referenceCounts(references, root = projectRoot) {
  const counts = new Map();
  for (const reference of references) {
    const key =
      path.relative(root, reference.filePath).split(path.sep).join('/') + '\u0000' + reference.name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function runtimeReferenceCounts() {
  const counts = new Map();
  const sourceRoot = path.join(projectRoot, 'src');

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;

      const source = fs.readFileSync(filePath, 'utf8');
      for (const match of source.matchAll(tokenReference)) {
        const key = relativePath(filePath) + '\u0000' + match[1];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  walk(sourceRoot);
  return counts;
}

function tokenMetadata(definition, layer) {
  const isPluginStable = pluginStable(definition.name);
  const status = statusFor(layer, isPluginStable);
  const metadata = {
    name: definition.name,
    definitionFile: relativePath(definition.filePath),
    layer,
    owner: ownerFor(definition.name, layer, isPluginStable),
    status,
    pluginStable: isPluginStable,
  };
  const removalCondition = removalConditionFor(status);
  if (removalCondition) metadata.removalCondition = removalCondition;
  return metadata;
}

function expectedImportPath(manifestFile) {
  const stylesRoot = path.join(projectRoot, 'src/styles');
  return (
    './' + path.relative(stylesRoot, path.join(projectRoot, manifestFile)).split(path.sep).join('/')
  );
}

function definitionReferences(definition) {
  return [...definition.value.matchAll(tokenReference)].map((match) => match[1]);
}

function validateLayerDirection(definitions, layersByFile, definitionsByName, root = projectRoot) {
  const allowedReferences = {
    core: new Set(['core']),
    semantic: new Set(['core', 'semantic']),
    components: new Set(['core', 'semantic', 'components']),
    compatibility: new Set(['core', 'semantic', 'components', 'compatibility']),
  };
  const diagnostics = [];

  for (const definition of definitions) {
    const layer = layersByFile.get(
      path.relative(root, definition.filePath).split(path.sep).join('/')
    );
    if (!layer) continue;

    for (const reference of definitionReferences(definition)) {
      const target = definitionsByName.get(reference);
      if (!target) continue;
      const targetLayer = layersByFile.get(
        path.relative(root, target.filePath).split(path.sep).join('/')
      );
      if (!targetLayer || allowedReferences[layer].has(targetLayer)) continue;
      diagnostics.push({
        code: 'layer-direction',
        filePath: definition.filePath,
        line: definition.line,
        message:
          definition.name +
          ' (' +
          layer +
          ') cannot reference ' +
          reference +
          ' (' +
          targetLayer +
          ')',
      });
    }
  }

  return diagnostics;
}

function validateTokenTaxonomy({
  manifest,
  indexSource,
  definitions,
  references,
  baselineEntries = [],
  root = projectRoot,
}) {
  const diagnostics = [];
  const files = manifestFiles(manifest);
  const layersByFile = layerByFile(manifest);
  const tokenFiles = new Set(files);
  const tokenDefinitions = definitions.filter((definition) =>
    tokenFiles.has(path.relative(root, definition.filePath).split(path.sep).join('/'))
  );
  const definitionsByName = new Map();
  const duplicateNames = new Map();

  for (const definition of tokenDefinitions) {
    const list = duplicateNames.get(definition.name) ?? [];
    list.push(definition);
    duplicateNames.set(definition.name, list);
    if (!definitionsByName.has(definition.name)) definitionsByName.set(definition.name, definition);
  }

  for (const [name, entries] of duplicateNames) {
    if (entries.length < 2) continue;
    diagnostics.push({
      code: 'duplicate-token',
      filePath: entries[1].filePath,
      line: entries[1].line,
      message:
        name +
        ' is defined in multiple token files: ' +
        entries.map((entry) => relativePath(entry.filePath)).join(', '),
    });
  }

  const expectedImports = files.map(expectedImportPath);
  const actualImports = [...indexSource.matchAll(/@import\s+['"]([^'"]+)['"]\s*;/g)]
    .map((match) => match[1])
    .filter((importPath) => expectedImports.includes(importPath));
  if (JSON.stringify(actualImports) !== JSON.stringify(expectedImports)) {
    diagnostics.push({
      code: 'token-order',
      filePath: indexPath,
      line: 1,
      message: 'token imports must match token-manifest.json order: ' + expectedImports.join(', '),
    });
  }

  diagnostics.push(
    ...validateLayerDirection(tokenDefinitions, layersByFile, definitionsByName, root)
  );

  const metadataByName = new Map(
    tokenDefinitions.map((definition) => [
      definition.name,
      tokenMetadata(
        definition,
        layersByFile.get(path.relative(root, definition.filePath).split(path.sep).join('/'))
      ),
    ])
  );
  const counts = referenceCounts(
    externalReferences(references, tokenFilesAbsolute(manifest)),
    root
  );
  const baseline = new Map(
    baselineEntries.map((entry) => [entry.path + '\u0000' + entry.token, entry.count])
  );

  for (const [key, count] of counts) {
    const separator = key.indexOf('\u0000');
    const file = key.slice(0, separator);
    const token = key.slice(separator + 1);
    const metadata = metadataByName.get(token);
    if (!metadata || (metadata.layer !== 'core' && metadata.status !== 'migration')) continue;
    const allowed = baseline.get(key) ?? 0;
    if (count <= allowed) continue;
    diagnostics.push({
      code: 'restricted-consumer',
      filePath: path.join(root, file),
      line: 1,
      message:
        file +
        ' consumes restricted ' +
        metadata.layer +
        ' token ' +
        token +
        ' ' +
        count +
        ' time(s); baseline allows ' +
        allowed +
        '. Add a semantic role or migrate the consumer.',
    });
  }

  return diagnostics;
}

function buildInventory({ manifest, definitions, references }) {
  const layersByFile = layerByFile(manifest);
  const tokenFiles = tokenFilesAbsolute(manifest);
  const tokenDefinitions = definitions
    .filter((definition) => manifestFiles(manifest).includes(relativePath(definition.filePath)))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
  const counts = referenceCounts(externalReferences(references, tokenFiles));
  const runtimeCounts = runtimeReferenceCounts();
  const inventory = tokenDefinitions.map((definition) => {
    const layer = layersByFile.get(relativePath(definition.filePath));
    const metadata = tokenMetadata(definition, layer);
    const tokenCounts = [...counts.entries()]
      .filter(([key]) => key.endsWith('\u0000' + definition.name))
      .reduce((total, [, count]) => total + count, 0);
    const runtimeCount = [...runtimeCounts.entries()]
      .filter(([key]) => key.endsWith('\u0000' + definition.name))
      .reduce((total, [, count]) => total + count, 0);
    return {
      ...metadata,
      consumerCount: tokenCounts + runtimeCount,
    };
  });

  return {
    schemaVersion: 1,
    manifest: 'src/styles/global/token-manifest.json',
    tokens: inventory,
  };
}

function buildBaseline({ manifest, definitions, references }) {
  const layersByFile = layerByFile(manifest);
  const definitionsByName = new Map(
    definitions
      .filter((definition) => manifestFiles(manifest).includes(relativePath(definition.filePath)))
      .map((definition) => [
        definition.name,
        tokenMetadata(definition, layersByFile.get(relativePath(definition.filePath))),
      ])
  );
  const counts = referenceCounts(externalReferences(references, tokenFilesAbsolute(manifest)));
  const entries = [];

  for (const [key, count] of counts) {
    const separator = key.indexOf('\u0000');
    const file = key.slice(0, separator);
    const token = key.slice(separator + 1);
    const metadata = definitionsByName.get(token);
    if (!metadata || (metadata.layer !== 'core' && metadata.status !== 'migration')) continue;
    entries.push({
      path: file,
      token,
      count,
      reason:
        metadata.layer === 'core'
          ? 'Transitional primitive consumer; replace with an owner-appropriate semantic or component role.'
          : 'Transitional migration-alias consumer; replace with the canonical semantic role.',
    });
  }

  return {
    schemaVersion: 1,
    policy:
      'Existing restricted consumers are baselined; new usage or growth fails the token-layer check.',
    entries: entries.sort((a, b) => a.path.localeCompare(b.path) || a.token.localeCompare(b.token)),
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function main() {
  const command = process.argv[2] === '--check' ? 'check' : 'write';
  const manifest = readJson(manifestPath);
  const indexSource = fs.readFileSync(indexPath, 'utf8');
  const graph = checkTokenGraph({
    cssRoot: path.join(projectRoot, 'src/styles'),
    sourceRoot: path.join(projectRoot, 'src'),
  });
  const baseline = fs.existsSync(baselinePath) ? readJson(baselinePath) : { entries: [] };
  const taxonomyDiagnostics = validateTokenTaxonomy({
    manifest,
    indexSource,
    definitions: graph.definitions,
    references: graph.references,
    baselineEntries: baseline.entries,
  });
  const inventory = buildInventory({
    manifest,
    definitions: graph.definitions,
    references: graph.references,
  });
  const generatedBaseline = buildBaseline({
    manifest,
    definitions: graph.definitions,
    references: graph.references,
  });

  if (command === 'write') {
    writeJson(baselinePath, generatedBaseline);
    writeJson(inventoryPath, inventory);
    console.log('Wrote token inventory and restricted-consumer baseline.');
    return;
  }

  const diagnostics = [...taxonomyDiagnostics];
  if (!fs.existsSync(inventoryPath)) {
    diagnostics.push({
      code: 'inventory-missing',
      filePath: inventoryPath,
      line: 1,
      message: 'Run pnpm tokens:inventory to create the checked-in inventory.',
    });
  } else if (JSON.stringify(readJson(inventoryPath)) !== JSON.stringify(inventory)) {
    diagnostics.push({
      code: 'inventory-stale',
      filePath: inventoryPath,
      line: 1,
      message: 'Token inventory is stale; run pnpm tokens:inventory.',
    });
  }

  if (!fs.existsSync(baselinePath)) {
    diagnostics.push({
      code: 'baseline-missing',
      filePath: baselinePath,
      line: 1,
      message: 'Restricted-consumer baseline is missing; run pnpm tokens:inventory.',
    });
  }

  for (const issue of diagnostics) {
    console.error(
      issue.code + ': ' + relativePath(issue.filePath) + ':' + issue.line + ' — ' + issue.message
    );
  }
  if (diagnostics.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { buildBaseline, buildInventory, validateTokenTaxonomy };
