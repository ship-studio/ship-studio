/**
 * Diffs as the phone draws them: a change card's file (`agents.changeDiff`,
 * a unified diff) and the edit a session is asking about (Claude Code's own
 * box on its screen, read back by `sessions.read`). Pure, so it's tested.
 */

import type { SessionQuestion } from '@shipstudio/companion-protocol';

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'context';

/**
 * A unified diff's `+`/`-`/`@@`, or Claude Code's numbered `13 +   …`.
 * `+++`/`---` file headers are context, not changes.
 */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (/^\+(?!\+\+)/.test(line)) return 'add';
  if (/^-(?!--)/.test(line)) return 'del';
  const numbered = /^\s*\d+\s+([+-])(\s|$)/.exec(line);
  if (numbered) return numbered[1] === '+' ? 'add' : 'del';
  return 'context';
}

const BOX_EDGE = /^[\s╭╮╰╯─┌┐└┘━]+$/;
const BOX_SIDE = /^\s*[│┃]\s?|\s?[│┃]\s*$/g;
/** A tool call's first line on Claude Code's screen: `⏺ Update(src/Header.tsx)`. */
const TOOL_LINE = /^\s*⏺/;

/**
 * What the session is asking about: the lines between the tool call that
 * raised the question and the question itself, out of their box. Empty when
 * the screen doesn't show the question (it scrolled, or it changed).
 */
export function questionContext(screen: string, question: SessionQuestion, max = 80): string[] {
  const lines = screen.split('\n');
  const asked = question.question.trim();
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].replace(BOX_SIDE, '').trim() === asked) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  let start = end;
  while (start > 0 && !TOOL_LINE.test(lines[start - 1]) && end - start < max) start--;
  const body = lines
    .slice(start, end)
    .filter((l) => !BOX_EDGE.test(l))
    .map((l) => l.replace(BOX_SIDE, '').replace(/\s+$/, ''));
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body;
}
