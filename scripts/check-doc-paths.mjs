/**
 * Every repo path a document points at must be obtainable from the repo.
 *
 * Written after `docs/ui-harness.md` shipped to main listing
 * `.claude/skills/ui-harness/SKILL.md`, a file that only ever existed on one
 * machine because `.gitignore` excludes `.claude/`. A verification loop had
 * "confirmed" it with `[ -f "$f" ]` — a correct answer to "is this on disk",
 * asked when the question was "did this ship".
 *
 * Only paths containing a slash are checked, so prose that names a bare
 * filename (`base.ts`) is left alone. Generated artefacts are exempt by
 * prefix: they are reproducible from tracked sources, which is the actual
 * test — not "is it committed" but "can someone else get it from the repo".
 */

import { execFileSync } from 'node:child_process';

const GENERATED_PREFIXES = ['harness/shots/'];

export function checkDocPaths(docs, { trackedFiles } = {}) {
  const tracked = new Set(
    trackedFiles ?? execFileSync('git', ['ls-files'], { encoding: 'utf-8' }).split('\n')
  );
  const problems = [];

  for (const [doc, body] of Object.entries(docs)) {
    const referenced = new Set();
    for (const [, p] of body.matchAll(/`([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*-]+)+)`/g)) {
      referenced.add(p);
    }
    for (const p of [...referenced].sort()) {
      const clean = p.replace(/\/$/, '');
      if (GENERATED_PREFIXES.some((g) => clean.startsWith(g))) continue;
      if (tracked.has(clean)) continue;
      // A directory is fine when anything under it is tracked.
      if ([...tracked].some((t) => t.startsWith(clean + '/'))) continue;
      // Globs and wildcards are illustrative, not literal paths.
      if (clean.includes('*')) continue;
      problems.push({ doc, path: clean });
    }
  }
  return problems;
}
