/**
 * Tests for the multi-line terminal link computer: URLs split across rows
 * by the terminal (soft wrap) AND by programs that wrap their own output
 * (hard wrap at full width, with or without a continuation indent — the
 * Claude Code TUI case) must resolve as one clickable link.
 */

import { describe, expect, it } from 'vitest';
import { computeMultilineLinks, type LinkableBuffer, type LinkableLine } from './terminalLinks';

const COLS = 20;

function fakeLine(text: string, wrapped = false, cols = COLS): LinkableLine {
  if (text.length > cols) throw new Error(`fixture longer than ${cols} cols: "${text}"`);
  return {
    isWrapped: wrapped,
    length: cols,
    translateToString: (trimRight: boolean) =>
      trimRight ? text.replace(/\s+$/, '') : text.padEnd(cols),
    getCell: (x: number) => ({
      getChars: () => (x < text.length ? text[x] : ''),
      getWidth: () => 1,
    }),
  };
}

function fakeBuffer(lines: LinkableLine[]): LinkableBuffer {
  return { getLine: (y: number) => lines[y] };
}

describe('computeMultilineLinks', () => {
  it('finds a single-line URL with a correct 1-based range', () => {
    const buf = fakeBuffer([fakeLine('see https://x.co ok')]);
    const links = computeMultilineLinks(buf, 0, COLS);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('https://x.co');
    expect(links[0].range).toEqual({ start: { x: 5, y: 1 }, end: { x: 16, y: 1 } });
  });

  it('drops trailing interpunction like the stock addon', () => {
    const buf = fakeBuffer([fakeLine('(https://x.co/a).')]);
    const links = computeMultilineLinks(buf, 0, COLS);
    expect(links.map((l) => l.text)).toEqual(['https://x.co/a']);
  });

  it('joins terminal soft wraps (isWrapped)', () => {
    // "go to https://exampl" is exactly 20 cols; the terminal wrapped it.
    const buf = fakeBuffer([fakeLine('go to https://exampl'), fakeLine('e.com/path now', true)]);
    for (const row of [0, 1]) {
      const links = computeMultilineLinks(buf, row, COLS);
      expect(links.map((l) => l.text)).toEqual(['https://example.com/path']);
    }
  });

  it('joins program hard wraps at full width (inferred wrap)', () => {
    // Same content, but the program printed a real newline: isWrapped=false.
    const buf = fakeBuffer([fakeLine('go to https://exampl'), fakeLine('e.com/path now', false)]);
    const links = computeMultilineLinks(buf, 0, COLS);
    expect(links.map((l) => l.text)).toEqual(['https://example.com/path']);
    expect(links[0].range.start).toEqual({ x: 7, y: 1 });
    expect(links[0].range.end).toEqual({ x: 10, y: 2 });
  });

  it('joins indented continuations (Claude Code style) from either row', () => {
    // Full-width row breaks mid-URL; continuation indented two spaces.
    const buf = fakeBuffer([fakeLine('x https://example.co'), fakeLine('  m/pr/82 done', false)]);
    for (const row of [0, 1]) {
      const links = computeMultilineLinks(buf, row, COLS);
      expect(links.map((l) => l.text)).toEqual(['https://example.com/pr/82']);
    }
    // End maps past the stripped indent: '2' is at 0-based col 8 on row 2.
    const [link] = computeMultilineLinks(buf, 1, COLS);
    expect(link.range.end).toEqual({ x: 9, y: 2 });
  });

  it('chains across three rows', () => {
    const buf = fakeBuffer([
      fakeLine('x https://example.co'),
      fakeLine('  m/some/deep/path/t', false),
      fakeLine('  o/file end', false),
    ]);
    const links = computeMultilineLinks(buf, 1, COLS);
    expect(links.map((l) => l.text)).toEqual(['https://example.com/some/deep/path/to/file']);
  });

  it('joins when the break row stops a few columns short (program right margin)', () => {
    // Claude Code's TUI wraps short of the terminal edge — the real-world
    // case: 35 chars in a 40-col terminal, continuation indented two spaces.
    const buf = fakeBuffer([
      fakeLine('x https://example.com/docs/en/secur', false, 40),
      fakeLine('  ity done', false, 40),
    ]);
    for (const row of [0, 1]) {
      const links = computeMultilineLinks(buf, row, 40);
      expect(links.map((l) => l.text)).toEqual(['https://example.com/docs/en/security']);
    }
  });

  it('clamps word-wrapped prose: a URL ending near the edge does not swallow the next word', () => {
    // "page" moved to the next line because it didn't fit — the URL is
    // complete. The joined token (19 chars) would have fit on the 19-char
    // row, so no wrapper would have split it there → clamp to the boundary.
    const buf = fakeBuffer([fakeLine('see https://exam.co'), fakeLine('page two', false)]);
    const links = computeMultilineLinks(buf, 0, COLS);
    expect(links.map((l) => l.text)).toEqual(['https://exam.co']);
  });

  it('does not join when the first row is clearly short of the wrap zone', () => {
    const buf = fakeBuffer([
      fakeLine('go https://t.co', false, 40),
      fakeLine('abcdefghij', false, 40),
    ]);
    const links = computeMultilineLinks(buf, 0, 40);
    expect(links.map((l) => l.text)).toEqual(['https://t.co']);
  });

  it('does not join past a deeply indented next row', () => {
    const buf = fakeBuffer([
      fakeLine('x https://example.co'),
      fakeLine('      quoted block', false),
    ]);
    const links = computeMultilineLinks(buf, 0, COLS);
    expect(links.map((l) => l.text)).toEqual(['https://example.co']);
  });

  it('returns nothing for rows without URLs', () => {
    const buf = fakeBuffer([fakeLine('no links here')]);
    expect(computeMultilineLinks(buf, 0, COLS)).toEqual([]);
    expect(computeMultilineLinks(buf, 5, COLS)).toEqual([]);
  });
});
