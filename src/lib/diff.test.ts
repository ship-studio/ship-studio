import { describe, expect, it } from 'vitest';
import { newFileRows, parseUnifiedDiff } from './diff';

describe('parseUnifiedDiff', () => {
  const diff = [
    'diff --git a/src/Footer.tsx b/src/Footer.tsx',
    'index 3f2a1c4..9b8d7e2 100644',
    '--- a/src/Footer.tsx',
    '+++ b/src/Footer.tsx',
    '@@ -12,3 +12,3 @@ export function Footer() {',
    '   <p>',
    '-    © 2024',
    '+    © 2026',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  it('drops git’s file headers and takes the marker off each line', () => {
    expect(parseUnifiedDiff(diff)).toEqual([
      { kind: 'hunk', text: 'export function Footer() {' },
      { kind: 'context', text: '  <p>', oldLine: 12, newLine: 12 },
      { kind: 'delete', text: '    © 2024', oldLine: 13 },
      { kind: 'add', text: '    © 2026', newLine: 13 },
      { kind: 'note', text: 'No newline at end of file' },
    ]);
  });

  it('keeps a removed line that itself starts with dashes', () => {
    const rows = parseUnifiedDiff('@@ -1 +1 @@\n---- heading\n++++ heading');
    expect(rows[0]).toEqual({ kind: 'hunk', text: '@@ -1 +1 @@' });
    expect(rows.slice(1)).toEqual([
      { kind: 'delete', text: '--- heading', oldLine: 1 },
      { kind: 'add', text: '+++ heading', newLine: 1 },
    ]);
  });

  it('numbers a new file’s plain content as additions', () => {
    expect(newFileRows('a\nb\n')).toEqual([
      { kind: 'add', text: 'a', newLine: 1 },
      { kind: 'add', text: 'b', newLine: 2 },
    ]);
  });
});
