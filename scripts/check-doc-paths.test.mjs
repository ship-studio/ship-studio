import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { checkDocPaths } from './check-doc-paths.mjs';

test('every repo path docs/ui-harness.md points at is in the repo', () => {
  const problems = checkDocPaths({
    'docs/ui-harness.md': readFileSync('docs/ui-harness.md', 'utf-8'),
  });
  assert.deepEqual(
    problems,
    [],
    `Documented paths that nobody else can obtain:\n` +
      problems.map((p) => `  ${p.doc} -> ${p.path}`).join('\n')
  );
});

test('it catches a path that is not tracked', () => {
  // Guards the guard: a rename of the matcher would otherwise make the test
  // above pass by finding nothing to check.
  const problems = checkDocPaths(
    { 'fake.md': 'see `.claude/skills/x/SKILL.md` for details' },
    { trackedFiles: ['docs/ui-harness.md'] }
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, '.claude/skills/x/SKILL.md');
});

test('generated artefacts are exempt because they are reproducible', () => {
  const problems = checkDocPaths(
    { 'fake.md': 'output lands in `harness/shots/report.md`' },
    { trackedFiles: ['scripts/harness-capture.mjs'] }
  );
  assert.deepEqual(problems, []);
});
