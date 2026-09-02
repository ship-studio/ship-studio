import assert from 'node:assert/strict';
import test from 'node:test';

import { validateTokenTaxonomy } from './token-inventory.mjs';

const root = '/fixture';
const manifest = {
  schemaVersion: 1,
  entry: 'src/styles/index.css',
  layers: [
    {
      name: 'core',
      files: ['src/styles/global/fonts.css', 'src/styles/global/tokens-core.css'],
    },
    {
      name: 'semantic',
      files: ['src/styles/global/tokens-semantic.css'],
    },
    {
      name: 'components',
      files: ['src/styles/global/tokens-components.css'],
    },
    {
      name: 'compatibility',
      files: ['src/styles/global/tokens-compatibility.css'],
    },
  ],
};

const indexSource = [
  "@import './global/fonts.css';",
  "@import './global/tokens-core.css';",
  "@import './global/tokens-semantic.css';",
  "@import './global/tokens-components.css';",
  "@import './global/tokens-compatibility.css';",
].join('\n');

const definitions = [
  {
    name: '--font-size-12',
    filePath: root + '/src/styles/global/tokens-core.css',
    line: 1,
    value: ': 12px;',
  },
  {
    name: '--font-size-body-md',
    filePath: root + '/src/styles/global/tokens-semantic.css',
    line: 1,
    value: ': var(--font-size-12);',
  },
];

test('ordered token manifest with unique definitions passes', () => {
  assert.deepEqual(
    validateTokenTaxonomy({
      manifest,
      indexSource,
      definitions,
      references: [],
      root,
    }),
    []
  );
});

test('token import order changes are reported', () => {
  const reversed = [
    "@import './global/fonts.css';",
    "@import './global/tokens-semantic.css';",
    "@import './global/tokens-core.css';",
    "@import './global/tokens-components.css';",
    "@import './global/tokens-compatibility.css';",
  ].join('\n');
  const diagnostics = validateTokenTaxonomy({
    manifest,
    indexSource: reversed,
    definitions,
    references: [],
    root,
  });
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'token-order'));
});

test('duplicate token definitions are reported across token files', () => {
  const diagnostics = validateTokenTaxonomy({
    manifest,
    indexSource,
    definitions: [
      ...definitions,
      {
        name: '--font-size-12',
        filePath: root + '/src/styles/global/tokens-semantic.css',
        line: 2,
        value: ': var(--font-size-body-md);',
      },
    ],
    references: [],
    root,
  });
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-token'));
});

test('restricted primitive consumers are bounded by the migration baseline', () => {
  const references = [
    {
      name: '--font-size-12',
      filePath: root + '/src/styles/features/example.css',
      line: 4,
      inDefinition: false,
    },
  ];
  const withoutBaseline = validateTokenTaxonomy({
    manifest,
    indexSource,
    definitions,
    references,
    root,
  });
  assert.ok(withoutBaseline.some((diagnostic) => diagnostic.code === 'restricted-consumer'));

  assert.deepEqual(
    validateTokenTaxonomy({
      manifest,
      indexSource,
      definitions,
      references,
      baselineEntries: [
        {
          path: 'src/styles/features/example.css',
          token: '--font-size-12',
          count: 1,
        },
      ],
      root,
    }),
    []
  );
});

test('a plugin-stable token missing from every layer is reported', () => {
  const contractManifest = {
    ...manifest,
    pluginStableApi: {
      prefixes: ['--bg-', '--text-'],
      tokens: ['--accent', '--font-size-12'],
    },
  };
  const diagnostics = validateTokenTaxonomy({
    manifest: contractManifest,
    indexSource,
    definitions,
    references: [],
    root,
  });
  const missing = diagnostics.filter((diagnostic) => diagnostic.code === 'plugin-stable-missing');
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /^--accent /);
});

test('a fully defined plugin-stable contract passes', () => {
  const contractManifest = {
    ...manifest,
    pluginStableApi: {
      prefixes: ['--bg-', '--text-'],
      tokens: ['--font-size-12', '--font-size-body-md'],
    },
  };
  assert.deepEqual(
    validateTokenTaxonomy({
      manifest: contractManifest,
      indexSource,
      definitions,
      references: [],
      root,
    }),
    []
  );
});

test('the shipped manifest declares the documented plugin-stable API', async () => {
  const { default: shippedManifest } = await import(
    '../src/styles/global/token-manifest.json',
    { with: { type: 'json' } }
  );
  for (const name of ['--accent', '--action', '--border', '--error', '--success', '--warning']) {
    assert.ok(
      shippedManifest.pluginStableApi.tokens.includes(name),
      name + ' must stay in the plugin-stable contract'
    );
  }
});
