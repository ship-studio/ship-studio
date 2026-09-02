#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS_EXTENSIONS = new Set(['.css']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
// Custom-property names are `--` followed by any CSS ident characters, which
// includes `_` — leaving it out silently split names like `--foo_bar` in two,
// so a reference to an undefined token could pass the check.
const VAR_REFERENCE = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
const CSS_DEFINITION = /--[a-zA-Z0-9_-]+(?=\s*:)/g;
const RUNTIME_DEFINITION = /['"](--[a-zA-Z0-9_-]+)['"]/g;

function listFiles(root, extensions) {
  if (!fs.existsSync(root)) return [];

  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolutePath, extensions));
    } else if (extensions.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

function lineNumberAt(offsets, index) {
  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= index) low = middle + 1;
    else high = middle - 1;
  }

  return high + 1;
}

function lineOffsets(source) {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function scopeEvents(source) {
  const events = [{ position: -1, scope: '<global>' }];
  const stack = [];
  let preludeStart = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === '{') {
      const prelude = source.slice(preludeStart, index).trim().replace(/\s+/g, ' ');
      stack.push(prelude || '<anonymous>');
      events.push({ position: index, scope: stack.join(' > ') });
      preludeStart = index + 1;
    } else if (character === '}') {
      stack.pop();
      events.push({ position: index, scope: stack.join(' > ') || '<global>' });
      preludeStart = index + 1;
    }
  }

  return events;
}

function scopeAt(events, index) {
  let low = 0;
  let high = events.length - 1;
  let result = events[0].scope;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (events[middle].position <= index) {
      result = events[middle].scope;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

function referencesIn(value) {
  return [...value.matchAll(VAR_REFERENCE)].map((match) => match[1]);
}

function overrideReason(source, definitionStart, valueEnd) {
  const lineStart = source.lastIndexOf('\n', definitionStart - 1) + 1;
  const contextStart = Math.max(0, lineStart - 320);
  const context = source.slice(contextStart, valueEnd);
  const matches = [...context.matchAll(/css-token-override\s*:\s*([a-zA-Z0-9_-]+)/g)];
  return matches.at(-1)?.[1] ?? null;
}

function scanCssFile(filePath, source) {
  const cleanSource = withoutComments(source);
  const offsets = lineOffsets(source);
  const events = scopeEvents(cleanSource);
  const definitions = [];
  const references = [];

  for (const match of cleanSource.matchAll(CSS_DEFINITION)) {
    const name = match[0];
    const start = match.index;
    const previousCharacter = start > 0 ? cleanSource[start - 1] : '';
    if (previousCharacter && !/[{;\s]/.test(previousCharacter)) continue;
    const valueStart = start + name.length;
    const semicolon = cleanSource.indexOf(';', valueStart);
    const closingBrace = cleanSource.indexOf('}', valueStart);
    const valueEnd =
      semicolon === -1
        ? closingBrace === -1
          ? cleanSource.length
          : closingBrace
        : closingBrace === -1
          ? semicolon
          : Math.min(semicolon, closingBrace);

    definitions.push({
      name,
      filePath,
      line: lineNumberAt(offsets, start),
      scope: scopeAt(events, start),
      value: source.slice(valueStart, valueEnd),
      override: overrideReason(source, start, valueEnd),
      start,
      valueEnd,
    });
  }

  for (const match of cleanSource.matchAll(VAR_REFERENCE)) {
    const inDefinition = definitions.some(
      (definition) => match.index >= definition.start && match.index <= definition.valueEnd
    );
    references.push({
      name: match[1],
      filePath,
      line: lineNumberAt(offsets, match.index),
      inDefinition,
    });
  }

  return { definitions, references };
}

function scanRuntimeFile(filePath, source) {
  const offsets = lineOffsets(source);
  return [...source.matchAll(RUNTIME_DEFINITION)].map((match) => ({
    name: match[1],
    filePath,
    line: lineNumberAt(offsets, match.index),
    runtime: true,
  }));
}

function diagnostic(code, message, location) {
  return { code, message, ...location };
}

function findCycles(definitions) {
  const graph = new Map();
  for (const definition of definitions) {
    const edges = graph.get(definition.name) ?? new Set();
    for (const reference of referencesIn(definition.value)) edges.add(reference);
    graph.set(definition.name, edges);
  }

  const visited = new Set();
  const active = new Map();
  const cycles = [];

  function visit(name, path) {
    if (active.has(name)) {
      const cycle = [...path.slice(active.get(name)), name];
      const key = cycle.join('->');
      if (!cycles.some((entry) => entry.key === key)) cycles.push({ key, cycle });
      return;
    }
    if (visited.has(name)) return;

    active.set(name, path.length);
    for (const reference of graph.get(name) ?? []) visit(reference, [...path, name]);
    active.delete(name);
    visited.add(name);
  }

  for (const name of graph.keys()) visit(name, []);
  return cycles.map(({ cycle }) => cycle);
}

export function checkTokenGraph({ cssRoot, sourceRoot }) {
  const cssFiles = listFiles(cssRoot, CSS_EXTENSIONS);
  const sourceFiles = listFiles(sourceRoot, SOURCE_EXTENSIONS);
  const cssResults = cssFiles.map((filePath) =>
    scanCssFile(filePath, fs.readFileSync(filePath, 'utf8'))
  );
  const runtimeDefinitions = sourceFiles.flatMap((filePath) =>
    scanRuntimeFile(filePath, fs.readFileSync(filePath, 'utf8'))
  );
  const definitions = cssResults.flatMap((result) => result.definitions);
  const references = cssResults.flatMap((result) => result.references);
  const diagnostics = [];
  const definedNames = new Set([
    ...definitions.map((definition) => definition.name),
    ...runtimeDefinitions.map((definition) => definition.name),
  ]);

  const missingReferences = new Map();
  for (const reference of references) {
    if (!definedNames.has(reference.name) && !missingReferences.has(reference.name)) {
      missingReferences.set(reference.name, reference);
      diagnostics.push(
        diagnostic('undefined', `custom property ${reference.name} is not defined`, reference)
      );
    }
  }

  const byScope = new Map();
  for (const definition of definitions) {
    const key = `${definition.scope}\u0000${definition.name}`;
    const entries = byScope.get(key) ?? [];
    entries.push(definition);
    byScope.set(key, entries);
  }

  for (const entries of byScope.values()) {
    if (entries.length < 2) continue;
    for (const definition of entries.slice(1)) {
      if (definition.override) continue;
      diagnostics.push(
        diagnostic(
          'duplicate',
          `${definition.name} is defined more than once in scope ${definition.scope}`,
          definition
        )
      );
    }
  }

  for (const cycle of findCycles(definitions)) {
    const firstDefinition = definitions.find((definition) => definition.name === cycle[0]);
    diagnostics.push(
      diagnostic('cycle', `custom-property cycle: ${cycle.join(' -> ')}`, firstDefinition)
    );
  }

  return { diagnostics, definitions, references, runtimeDefinitions };
}

function displayPath(filePath) {
  return path.relative(process.cwd(), filePath) || filePath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const result = checkTokenGraph({
    cssRoot: path.join(root, 'src/styles'),
    sourceRoot: path.join(root, 'src'),
  });

  for (const issue of result.diagnostics) {
    console.error(`${issue.code}: ${displayPath(issue.filePath)}:${issue.line} — ${issue.message}`);
  }

  if (result.diagnostics.length > 0) process.exitCode = 1;
}
