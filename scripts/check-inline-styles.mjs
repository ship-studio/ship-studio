#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'src', 'components');
const baselinePath = path.join(projectRoot, 'scripts', 'inline-style-baseline.json');
const STYLE_OBJECT_MARKER = /style=\{\s*\{/g;
const INLINE_EXCEPTION = /inline-style-ok\s*:\s*([^*\n]+)/i;
const PLATFORM_PROPERTIES = new Set(['WebkitAppRegion']);

function relativePath(filePath) {
  if (!path.isAbsolute(filePath)) return filePath.split(path.sep).join('/');
  return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

function listSourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(filePath));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(filePath);
  }
  return files.sort();
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === '\n') line += 1;
  }
  return line;
}

function findObjectBody(source, markerEnd) {
  let depth = 2;
  let quote = null;
  let escaped = false;
  let bodyEnd = markerEnd;

  for (let index = markerEnd; index < source.length; index += 1) {
    const character = source[index];

    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character !== '}') continue;

    depth -= 1;
    if (depth === 1) bodyEnd = index;
    if (depth === 0) return { body: source.slice(markerEnd, bodyEnd), end: index + 1 };
  }

  return null;
}

function splitTopLevel(source) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === ',' && parentheses === 0 && brackets === 0 && braces === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(source.slice(start));
  return parts;
}

function findTopLevelColon(source) {
  let quote = null;
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === ':' && parentheses === 0 && brackets === 0 && braces === 0) {
      return index;
    }
  }

  return -1;
}

function normalizeValue(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function isStaticValue(value) {
  const normalized = normalizeValue(value);
  if (!normalized) return true;
  if (/^(?:true|false|null|undefined|-?\d+(?:\.\d+)?)$/.test(normalized)) return true;
  if (/^'(?:[^'\\]|\\.)*'$/.test(normalized)) return true;
  if (/^"(?:[^"\\]|\\.)*"$/.test(normalized)) return true;
  if (/^`(?:[^`\\]|\\.)*`$/.test(normalized)) return !normalized.includes('${');
  return false;
}

function exceptionReason(source, styleStart) {
  const context = source.slice(Math.max(0, styleStart - 320), styleStart);
  return context.match(INLINE_EXCEPTION)?.[1].trim() ?? null;
}

function scanSource(source, filePath) {
  const entries = [];
  for (const marker of source.matchAll(STYLE_OBJECT_MARKER)) {
    const styleStart = marker.index;
    const bodyStart = styleStart + marker[0].length;
    const object = findObjectBody(source, bodyStart);
    if (!object) continue;

    for (const declaration of splitTopLevel(object.body)) {
      const colon = findTopLevelColon(declaration);
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim();
      const value = normalizeValue(declaration.slice(colon + 1));
      if (!/^[A-Za-z_$][\w$-]*$/.test(property)) continue;
      if (!isStaticValue(value)) continue;

      entries.push({
        path: relativePath(filePath),
        line: lineNumberAt(source, styleStart),
        property,
        value,
        exception: exceptionReason(source, styleStart),
      });
    }
  }
  return entries;
}

export function scanInlineStyles(root = sourceRoot) {
  return listSourceFiles(root).flatMap((filePath) =>
    scanSource(fs.readFileSync(filePath, 'utf8'), filePath)
  );
}

export function inlineStyleSignature(entry) {
  return `${entry.path}\u0000${entry.property}\u0000${entry.value}`;
}

function baselineCounts(baseline) {
  const counts = new Map();
  for (const entry of baseline.entries ?? []) {
    const signature = `${entry.path}\u0000${entry.property}\u0000${entry.value}`;
    counts.set(signature, (counts.get(signature) ?? 0) + (entry.count ?? 1));
  }
  return counts;
}

export function checkInlineStyleDelta(entries, baseline) {
  const remaining = baselineCounts(baseline);
  const diagnostics = [];

  for (const entry of entries) {
    if (entry.exception || PLATFORM_PROPERTIES.has(entry.property)) continue;
    const signature = inlineStyleSignature(entry);
    const available = remaining.get(signature) ?? 0;
    if (available > 0) {
      remaining.set(signature, available - 1);
      continue;
    }
    diagnostics.push(
      `${entry.path}:${entry.line} adds static inline style ${entry.property}: ${entry.value}; move it to a token-backed class or add an inline-style-ok reason for a genuine exception`
    );
  }

  return diagnostics;
}

function createBaseline(entries) {
  const counts = new Map();
  for (const entry of entries) {
    if (entry.exception || PLATFORM_PROPERTIES.has(entry.property)) continue;
    const signature = inlineStyleSignature(entry);
    const current = counts.get(signature) ?? {
      path: entry.path,
      property: entry.property,
      value: entry.value,
      count: 0,
    };
    current.count += 1;
    counts.set(signature, current);
  }
  return {
    schemaVersion: 1,
    policy:
      'Static inline-style signatures are frozen; computed geometry and platform API values are allowed.',
    entries: [...counts.values()].sort((left, right) =>
      `${left.path}:${left.property}:${left.value}`.localeCompare(
        `${right.path}:${right.property}:${right.value}`
      )
    ),
  };
}

function run() {
  const entries = scanInlineStyles();
  if (process.argv.includes('--baseline')) {
    fs.writeFileSync(baselinePath, `${JSON.stringify(createBaseline(entries), null, 2)}\n`);
    console.log(`Wrote ${relativePath(baselinePath)} (${entries.length} static declarations).`);
    return;
  }

  if (!fs.existsSync(baselinePath)) {
    console.error(
      `Missing ${relativePath(baselinePath)}; run pnpm check:inline-styles -- --baseline.`
    );
    process.exitCode = 1;
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const diagnostics = checkInlineStyleDelta(entries, baseline);
  for (const diagnostic of diagnostics) console.error(`inline-styles: ${diagnostic}`);
  if (diagnostics.length > 0) process.exitCode = 1;
  else
    console.log(`Inline-style delta check passed (${entries.length} static declarations scanned).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();

export { createBaseline, isStaticValue, scanSource };
