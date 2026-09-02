#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'src');
const assetRoot = path.join(sourceRoot, 'assets');
const iconsRoot = path.join(assetRoot, 'icons');
const graphicsRoot = path.join(assetRoot, 'graphics');
const componentRoot = path.join(sourceRoot, 'components', 'icons');
const indexPath = path.join(componentRoot, 'index.tsx');
const svgFilename = /^[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/;
const trailingNumber = /-[0-9]+\.svg$/;

function walk(directory) {
  return walkFiles(directory).filter((file) => file.endsWith('.svg'));
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(absolute);
    return [absolute];
  });
}

function relative(file) {
  return path.relative(projectRoot, file).split(path.sep).join('/');
}

function assetSource(file) {
  return path.relative(assetRoot, file).split(path.sep).join('/');
}

function literal(node, sourceFile) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function property(object, name, sourceFile) {
  const match = object.properties.find(
    (entry) => ts.isPropertyAssignment(entry) && entry.name?.getText(sourceFile) === name
  );
  return match && ts.isPropertyAssignment(match) ? literal(match.initializer, sourceFile) : undefined;
}

function iconDeclarations({ componentDirectory = componentRoot } = {}) {
  const declarations = [];
  const errors = [];
  const moduleFiles = fs
    .readdirSync(componentDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => path.join(componentDirectory, entry.name));

  for (const file of moduleFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(sourceFile) === 'createIcon'
      ) {
        const [asset, metadata] = node.initializer.arguments;
        const name = node.name.text;
        if (!metadata || !ts.isObjectLiteralExpression(metadata)) {
          errors.push(`${relative(file)}:${name}: createIcon metadata must be an object literal`);
        } else {
          declarations.push({
            file,
            exportName: name,
            name: property(metadata, 'name', sourceFile),
            source: property(metadata, 'source', sourceFile),
            kind: property(metadata, 'kind', sourceFile),
            defaultSize: property(metadata, 'defaultSize', sourceFile),
            compact: property(metadata, 'compact', sourceFile),
            strokeWidth: property(metadata, 'strokeWidth', sourceFile),
            asset: asset?.getText(sourceFile),
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  return { declarations, errors };
}

function validateSvg(file) {
  const errors = [];
  const basename = path.basename(file);
  if (!svgFilename.test(basename)) {
    errors.push(`${relative(file)}: filename must be lowercase kebab-case`);
  }
  if (trailingNumber.test(basename)) {
    errors.push(`${relative(file)}: trailing numeric filename segments are not allowed`);
  }

  const source = fs.readFileSync(file, 'utf8');
  const root = source.match(/<svg\b[^>]*>/i)?.[0];
  if (!root) {
    errors.push(`${relative(file)}: SVG root is missing`);
    return errors;
  }
  const viewBoxes = [...root.matchAll(/\bviewBox\s*=\s*(["'])(.*?)\1/gi)];
  if (viewBoxes.length !== 1 || !/^-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?){3}$/.test(viewBoxes[0]?.[2] ?? '')) {
    errors.push(`${relative(file)}: SVG root must contain exactly one valid viewBox`);
  }
  if (/<script\b|<foreignObject\b/i.test(source)) {
    errors.push(`${relative(file)}: script and foreignObject markup is not allowed`);
  }
  if (/\son[a-z]+\s*=/i.test(source)) {
    errors.push(`${relative(file)}: inline event attributes are not allowed`);
  }
  for (const match of source.matchAll(/\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    if (!match[2].startsWith('#')) {
      errors.push(`${relative(file)}: external href values are not allowed`);
    }
  }

  return errors;
}

function validateAssets({ iconsDirectory = iconsRoot, graphicsDirectory = graphicsRoot } = {}) {
  const errors = [];
  const files = [...walk(iconsDirectory), ...walk(graphicsDirectory)];
  const basenames = new Map();

  for (const file of files) {
    errors.push(...validateSvg(file));
    const key = path.basename(file).slice(0, -4);
    const previous = basenames.get(key);
    if (previous) {
      errors.push(`${relative(file)}: duplicate SVG basename also appears at ${relative(previous)}`);
    } else {
      basenames.set(key, file);
    }
  }

  return { errors, files, basenames, iconsDirectory, graphicsDirectory };
}

function validateDeclarations(
  assetInfo,
  { componentDirectory = componentRoot, indexFile = indexPath, iconsDirectory = assetInfo.iconsDirectory ?? iconsRoot } = {}
) {
  const { declarations, errors } = iconDeclarations({ componentDirectory });
  const allErrors = [...errors];
  const names = new Set();
  const sources = new Set();
  const validKinds = new Set(['ui', 'brand']);

  for (const declaration of declarations) {
    const label = declaration.name ?? declaration.exportName;
    if (!declaration.exportName.endsWith('Icon')) {
      allErrors.push(`${relative(declaration.file)}: ${declaration.exportName}: export name must end in Icon`);
    }
    if (typeof declaration.name !== 'string' || !declaration.name.endsWith('Icon')) {
      allErrors.push(`${relative(declaration.file)}:${label}: iconMeta.name must end in Icon`);
    }
    if (names.has(declaration.name)) allErrors.push(`duplicate icon metadata name: ${declaration.name}`);
    if (declaration.name) names.add(declaration.name);
    if (!declaration.source || typeof declaration.source !== 'string') {
      allErrors.push(`${relative(declaration.file)}:${label}: iconMeta.source is required`);
      continue;
    }
    if (!/^icons\/.+\.svg$/.test(declaration.source)) {
      allErrors.push(`${relative(declaration.file)}:${label}: iconMeta.source must use the icons asset namespace`);
    } else {
      const sourceFile = path.join(iconsDirectory, declaration.source.slice('icons/'.length));
      if (!fs.existsSync(sourceFile)) {
        allErrors.push(`${relative(declaration.file)}:${label}: source does not exist: ${declaration.source}`);
      }
      sources.add(declaration.source);
    }
    if (!validKinds.has(declaration.kind)) {
      allErrors.push(`${relative(declaration.file)}:${label}: kind must be ui or brand`);
    }
    if (typeof declaration.defaultSize !== 'number') {
      allErrors.push(`${relative(declaration.file)}:${label}: defaultSize must be numeric`);
    }
  }

  const index = fs.readFileSync(indexFile, 'utf8');
  const reExportedModules = new Set(
    [...index.matchAll(/export\s+\*\s+from\s+['"]\.\/([^'"]+)['"]/g)].map((match) => match[1])
  );
  const modulesWithIcons = new Set(declarations.map((entry) => path.basename(entry.file, '.tsx')));
  for (const module of modulesWithIcons) {
    if (!reExportedModules.has(module)) allErrors.push(`icon module is not re-exported by index.tsx: ${module}`);
  }

  const primary = assetInfo.files.filter((file) => path.dirname(file) === iconsDirectory);
  const unreferencedPrimary = primary.filter((file) => !sources.has(`icons/${path.basename(file)}`));
  return { errors: allErrors, declarations, names, sources, unreferencedPrimary };
}

function validateDynamicSvg({ sourceDirectory = sourceRoot, branchFile = path.join(sourceRoot, 'components', 'branches', 'BranchGraph.tsx') } = {}) {
  const errors = [];
  const tsxFiles = walkFiles(sourceDirectory).filter((file) => file.endsWith('.tsx'));
  for (const file of tsxFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const count = [...source.matchAll(/<svg\b/g)].length;
    if (file === branchFile) {
      if (count !== 1 || !source.includes('data-dynamic-svg="branch-graph"')) {
        errors.push(`${relative(file)}: the marked dynamic SVG exception must contain exactly one SVG and its marker`);
      }
    } else if (count > 0) {
      errors.push(`${relative(file)}: static inline SVG is not allowed`);
    }
  }
  return errors;
}

function status() {
  const assetInfo = validateAssets();
  const declarationInfo = validateDeclarations(assetInfo);
  const primary = assetInfo.files.filter((file) => path.dirname(file) === iconsRoot).length;
  const oldIcons = assetInfo.files.filter((file) => path.dirname(file) === path.join(iconsRoot, 'old-icons')).length;
  const graphics = assetInfo.files.filter((file) => file.startsWith(`${graphicsRoot}${path.sep}`)).length;
  const ui = declarationInfo.declarations.filter((entry) => entry.kind === 'ui').length;
  const brand = declarationInfo.declarations.filter((entry) => entry.kind === 'brand').length;
  console.log(`Primary icons:              ${primary}`);
  console.log(`App-specific icons:         ${oldIcons}`);
  console.log(`Feature graphics:           ${graphics}`);
  console.log(`Shared UI exports:           ${ui}`);
  console.log(`Brand exports:               ${brand}`);
  console.log(`Unreferenced primary assets: ${declarationInfo.unreferencedPrimary.length}`);
  if (declarationInfo.unreferencedPrimary.length) {
    for (const file of declarationInfo.unreferencedPrimary.sort()) console.log(`  ${assetSource(file)}`);
  }
}

const command = process.argv[2] ?? 'status';
function main() {
  if (command === 'status') {
    status();
  } else if (command === 'check') {
    const assetInfo = validateAssets();
    const declarationInfo = validateDeclarations(assetInfo);
    const errors = [...assetInfo.errors, ...declarationInfo.errors, ...validateDynamicSvg()];
    if (errors.length) {
      console.error('Icon asset check failed:\n');
      for (const error of errors) console.error(`- ${error}`);
      process.exit(1);
    }
    console.log('Icon asset check passed.');
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();

export { validateAssets, validateDeclarations, validateDynamicSvg, validateSvg };
