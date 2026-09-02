import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTokenGraph } from './check-css-tokens.mjs';

const fixtureRoot = fileURLToPath(new URL('./fixtures/css-token-graph/', import.meta.url));

function checkFixture(name) {
  return checkTokenGraph({
    cssRoot: path.join(fixtureRoot, name),
    sourceRoot: path.join(fixtureRoot, name),
  });
}

test('clean token graph passes', () => {
  assert.deepEqual(checkFixture('clean').diagnostics, []);
});

test('undefined token is reported', () => {
  const { diagnostics } = checkFixture('undefined');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'undefined');
  assert.match(diagnostics[0].message, /--missing-token/);
});

test('duplicate token in one scope is reported', () => {
  const { diagnostics } = checkFixture('duplicate');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'duplicate');
});

test('direct token cycle is reported', () => {
  const { diagnostics } = checkFixture('direct-cycle');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'cycle');
  assert.match(diagnostics[0].message, /--self -> --self/);
});

test('transitive token cycle is reported with its chain', () => {
  const { diagnostics } = checkFixture('transitive-cycle');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'cycle');
  assert.match(diagnostics[0].message, /--first -> --second -> --first/);
});

test('explicit token override is allowed', () => {
  assert.deepEqual(checkFixture('allowed-override').diagnostics, []);
});

test('runtime-defined token satisfies CSS references', () => {
  assert.deepEqual(checkFixture('runtime').diagnostics, []);
});
