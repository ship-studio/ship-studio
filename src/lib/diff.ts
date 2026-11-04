/**
 * Reads `git diff` output into rows the diff modal can draw: one marker per
 * line (git's own, taken off the text), line numbers from the hunk headers,
 * and none of git's per-file header lines (`diff --git`, `index`, `---`,
 * `+++`, modes, renames), which repeat the path the modal already shows.
 *
 * @module lib/diff
 */

export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'delete' | 'context'; text: string; oldLine?: number; newLine?: number }
  /** "\ No newline at end of file" */
  | { kind: 'note'; text: string };

const HUNK = /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@) ?(.*)$/;

export function parseUnifiedDiff(content: string): DiffRow[] {
  const rows: DiffRow[] = [];
  // Until the first hunk (and again after another file's `diff --git`), lines are headers.
  let inHeader = true;
  let oldLine = 0;
  let newLine = 0;
  for (const line of content.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      inHeader = false;
      oldLine = Number(hunk[2]);
      newLine = Number(hunk[3]);
      // The enclosing function when git found one; the range itself otherwise.
      rows.push({ kind: 'hunk', text: hunk[4] || hunk[1] });
      continue;
    }
    if (inHeader || line === '') continue;
    const marker = line[0];
    const text = line.slice(1);
    if (marker === '+') rows.push({ kind: 'add', text, newLine: newLine++ });
    else if (marker === '-') rows.push({ kind: 'delete', text, oldLine: oldLine++ });
    else if (marker === '\\') rows.push({ kind: 'note', text: line.slice(2) });
    else rows.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
  }
  return rows;
}

/** A new file sent as its plain content: every line an addition. */
export function newFileRows(content: string): DiffRow[] {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((text, i) => ({ kind: 'add', text, newLine: i + 1 }));
}
