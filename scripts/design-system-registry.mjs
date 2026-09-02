#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const primitivesRoot = path.join(projectRoot, 'src/components/primitives');
const registryPath = path.join(projectRoot, 'docs/design-system-registry.json');
const generatedPath = path.join(projectRoot, 'docs/design-system.generated.md');
const tokenManifestPath = path.join(projectRoot, 'src/styles/global/token-manifest.json');
const tokenInventoryPath = path.join(projectRoot, 'src/styles/global/token-inventory.json');

const requiredFields = [
  'name',
  'file',
  'exports',
  'purpose',
  'owner',
  'props',
  'states',
  'accessibility',
  'style',
  'example',
  'tests',
  'lifecycle',
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function relativePath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

function primitiveFiles() {
  return fs
    .readdirSync(primitivesRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')
    )
    .map((entry) => relativePath(path.join(primitivesRoot, entry.name)))
    .sort();
}

function exportedSymbols(filePath) {
  const source = fs.readFileSync(path.join(projectRoot, filePath), 'utf8');
  const exportPattern =
    /^export\s+(?:type|interface|function|const|class|enum)\s+([A-Za-z0-9_]+)/gm;
  return [...source.matchAll(exportPattern)].map((match) => match[1]).sort();
}

function unionMembers(source, typeName) {
  const match = source.match(new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`));
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateRegistry(registry, tokenManifest, tokenInventory) {
  const diagnostics = [];
  const actualFiles = primitiveFiles();
  const entries = registry.entries ?? [];
  const registryFiles = entries.map((entry) => entry.file).sort();

  if (!sameValues(actualFiles, registryFiles)) {
    const missing = actualFiles.filter((file) => !registryFiles.includes(file));
    const stale = registryFiles.filter((file) => !actualFiles.includes(file));
    if (missing.length)
      diagnostics.push(`Primitive files missing from registry: ${missing.join(', ')}`);
    if (stale.length) diagnostics.push(`Registry entries missing from source: ${stale.join(', ')}`);
  }

  const seenFiles = new Set();
  for (const entry of entries) {
    for (const field of requiredFields) {
      if (!(field in entry))
        diagnostics.push(`${entry.file ?? entry.name}: missing registry field ${field}`);
    }

    if (seenFiles.has(entry.file)) diagnostics.push(`Duplicate registry entry: ${entry.file}`);
    seenFiles.add(entry.file);

    if (!fs.existsSync(path.join(projectRoot, entry.file))) {
      diagnostics.push(`${entry.file}: primitive source file does not exist`);
      continue;
    }

    const actualExports = exportedSymbols(entry.file);
    const registeredExports = [...(entry.exports ?? [])].sort();
    if (!sameValues(actualExports, registeredExports)) {
      diagnostics.push(
        `${entry.file}: exported symbols differ (source: ${actualExports.join(', ')}; registry: ${registeredExports.join(', ')})`
      );
    }

    if (!fs.existsSync(path.join(projectRoot, entry.style))) {
      diagnostics.push(`${entry.file}: styling owner does not exist: ${entry.style}`);
    }

    for (const testPath of entry.tests ?? []) {
      if (!fs.existsSync(path.join(projectRoot, testPath))) {
        diagnostics.push(`${entry.file}: test path does not exist: ${testPath}`);
      }
    }

    const examplePath = entry.example.split('#')[0];
    if (!fs.existsSync(path.join(projectRoot, examplePath))) {
      diagnostics.push(`${entry.file}: example path does not exist: ${entry.example}`);
    }
  }

  const buttonEntry = entries.find(
    (entry) => entry.file === 'src/components/primitives/Button.tsx'
  );
  const buttonSource = fs.readFileSync(
    path.join(projectRoot, 'src/components/primitives/Button.tsx'),
    'utf8'
  );
  const buttonVariants = unionMembers(buttonSource, 'ButtonVariant');
  const buttonSizes = unionMembers(buttonSource, 'ButtonSize');
  if (!buttonEntry) {
    diagnostics.push('Button.tsx is missing from the design-system registry');
  } else {
    if (!sameValues(buttonVariants, buttonEntry.variants ?? [])) {
      diagnostics.push(
        `Button variants drifted (source: ${buttonVariants.join(', ')}; registry: ${(buttonEntry.variants ?? []).join(', ')})`
      );
    }
    if (!sameValues(buttonSizes, buttonEntry.sizes ?? [])) {
      diagnostics.push(
        `Button sizes drifted (source: ${buttonSizes.join(', ')}; registry: ${(buttonEntry.sizes ?? []).join(', ')})`
      );
    }
  }

  const manifestFiles = tokenManifest.layers.flatMap((layer) => layer.files);
  for (const manifestFile of manifestFiles) {
    if (!fs.existsSync(path.join(projectRoot, manifestFile))) {
      diagnostics.push(`Token manifest file does not exist: ${manifestFile}`);
    }
  }
  if (tokenInventory.manifest !== 'src/styles/global/token-manifest.json') {
    diagnostics.push('Token inventory is not generated from the canonical token manifest');
  }

  return diagnostics;
}

function inline(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value ?? '—';
}

function generatedMarkdown(registry, tokenManifest, tokenInventory) {
  const rows = registry.entries
    .map((entry) => {
      const tests = entry.tests.length ? entry.tests.join('<br>') : '—';
      return `| ${entry.name}<br><code>${entry.file}</code> | ${entry.exports.map((name) => `\`${name}\``).join(', ')} | ${entry.purpose} | ${entry.owner} | ${inline(entry.props)}<br><strong>Variants:</strong> ${inline(entry.variants)}${entry.sizes ? `<br><strong>Sizes:</strong> ${inline(entry.sizes)}` : ''} | ${inline(entry.states)} | ${entry.accessibility} | \`${entry.style}\` | \`${entry.example}\` | ${tests} | ${entry.lifecycle} |`;
    })
    .join('\n');

  const tokenRows = tokenManifest.layers
    .map((layer) => {
      const tokens = tokenInventory.tokens.filter((token) => token.layer === layer.name);
      const examples = tokens
        .slice(0, 6)
        .map((token) => `\`${token.name}\``)
        .join(', ');
      return `| ${layer.name} | ${layer.files.map((file) => `\`${file}\``).join('<br>')} | ${tokens.length} | ${examples || '—'} |`;
    })
    .join('\n');

  return `<!-- Generated by pnpm docs:generate. Edit docs/design-system-registry.json instead. -->
# Generated design-system inventory

This file is generated from [docs/design-system-registry.json](design-system-registry.json),
the primitive source exports, the Button type unions, and the canonical token inventory. It is
intentionally inventory-focused; explanatory guidance remains in
[docs/design-system.md](design-system.md).

## Primitive registry

Rows represent primitive source files. Compound primitives keep their related public exports in
one row, while the export list is checked exactly against the source file.

| Primitive | Public exports | Purpose | Owner | Props / variants | State model | Accessibility contract | Styling owner | Example | Tests | Lifecycle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## Token source inventory

| Layer | Definition files | Token count | Sample names |
| --- | --- | ---: | --- |
${tokenRows}

## Drift checks

\`pnpm docs:check\` verifies primitive files and exports, Button variants and sizes, registry paths,
and token-manifest references. \`pnpm docs:generate\` refreshes this file after an intentional
registry or token-source change.
`;
}

function main() {
  const registry = readJson(registryPath);
  const tokenManifest = readJson(tokenManifestPath);
  const tokenInventory = readJson(tokenInventoryPath);
  const diagnostics = validateRegistry(registry, tokenManifest, tokenInventory);

  if (diagnostics.length) {
    for (const diagnostic of diagnostics) console.error(`design-system-registry: ${diagnostic}`);
    process.exitCode = 1;
    return;
  }

  const command = process.argv[2] ?? 'check';
  if (command === 'generate') {
    fs.writeFileSync(generatedPath, generatedMarkdown(registry, tokenManifest, tokenInventory));
    console.log(`Generated ${relativePath(generatedPath)}.`);
    return;
  }

  if (command !== 'check') {
    console.error(`Unknown command: ${command}. Use check or generate.`);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(generatedPath)) {
    console.error(
      `Missing generated inventory: ${relativePath(generatedPath)}; run pnpm docs:generate`
    );
    process.exitCode = 1;
    return;
  }

  const expected = generatedMarkdown(registry, tokenManifest, tokenInventory);
  const actual = fs.readFileSync(generatedPath, 'utf8');
  if (actual !== expected) {
    console.error(
      `Generated inventory is stale: ${relativePath(generatedPath)}; run pnpm docs:generate`
    );
    process.exitCode = 1;
    return;
  }

  console.log('Design-system registry and generated inventory are in sync.');
}

main();

export { exportedSymbols, generatedMarkdown, validateRegistry };
