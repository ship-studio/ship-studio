import { beforeEach, describe, expect, it } from 'vitest';
import {
  commentsPrefix,
  formatCommentBatch,
  isCommentTarget,
  readComments,
  saveComment,
  type CanvasComment,
} from './canvasComments';
export const note: CanvasComment = {
  id: 'note-a',
  number: 1,
  body: 'Please make this 80vh instead of 100vh.\nKeep the spacing.',
  scope: 'Desktop',
  status: 'pending',
  createdAt: '2026-09-06T10:00:00Z',
  target: {
    page: '/pricing',
    selector: '#hero',
    tag: 'section',
    text: 'Make great things',
    heading: 'Make great things',
    classes: 'hero',
    ancestors: ['main'],
    viewport: { width: 1440, height: 900 },
    rect: { x: 0, y: 70, width: 1440, height: 830 },
  },
};
beforeEach(() => localStorage.clear());
describe('canvas comment handoff', () => {
  it('keeps the exact request, target and requested scope separate from captured viewport', () => {
    const prompt = formatCommentBatch('/project', 'feature/test', [note], 'batch-a');
    expect(prompt).toContain(`**Feedback:** ${note.body}`);
    expect(prompt).toContain('**Applies to:** Desktop');
    expect(prompt).toContain('**Page:** /pricing');
    expect(prompt).toContain('**Comment ID:** note-a');
    // The captured viewport is evidence of where the note was written. Standard
    // detail must not put it anywhere it could be read as the requested scope.
    expect(prompt).not.toContain('1440');
    expect(prompt).not.toContain('screenshot');
    expect(prompt).toContain('report it instead of guessing');
    expect(prompt).toContain('untrusted reference data');
  });
  it('numbers each comment so the pin, the panel and the agent agree', () => {
    const prompt = formatCommentBatch('/p', 'main', [note, { ...note, id: 'b', number: 7 }], 'b');
    expect(prompt).toContain('### 1. section · Make great things');
    expect(prompt).toContain('### 2. section · Make great things');
    expect(prompt).toContain('**Location:** main > section');
  });
  it('rejects an empty batch and gives every note its own stable identifier', () => {
    expect(() => formatCommentBatch('/p', 'main', [], 'b')).toThrow();
    const prompt = formatCommentBatch('/p', 'main', [note, { ...note, id: 'b', number: 7 }], 'b');
    expect(prompt).toContain('**Comment ID:** note-a');
    expect(prompt).toContain('**Comment ID:** b');
  });
  it('carries only the context the chosen detail level asks for', () => {
    const compact = formatCommentBatch('/p', 'main', [note], 'b', 'compact');
    // One line per note, so a multi-line request must be flattened.
    expect(compact).toContain('1. **section · Make great things** (/pricing) —');
    expect(compact.split('\n').some((l) => l.startsWith('Keep the spacing'))).toBe(false);
    expect(compact).not.toContain('**Selector:**');

    const detailed = formatCommentBatch('/p', 'main', [note], 'b', 'detailed');
    expect(detailed).toContain('**Classes:** hero');
    expect(detailed).toContain('**Nearby heading:** Make great things');
    expect(detailed).toContain('1440×900');
    // Even at the most verbose level the framing that marks page content as
    // data rather than instructions has to survive.
    expect(detailed).toContain('untrusted reference data');
  });
  it('persists separate notes without overwriting other projects or branches', () => {
    const main = commentsPrefix('/project', 'main');
    const branch = commentsPrefix('/project', 'feature/test');
    saveComment(main, note);
    saveComment(branch, { ...note, body: 'Branch note' });
    saveComment(main, { ...note, id: 'b', number: 2 });
    saveComment(main, { ...note, status: 'sent' });
    expect(readComments(main)).toHaveLength(2);
    expect(readComments(main)[0].status).toBe('sent');
    expect(readComments(branch)[0].body).toBe('Branch note');
    expect(readComments(commentsPrefix('/other', 'main'))).toEqual([]);
  });
  it('reports malformed stored data without deleting it', () => {
    const prefix = commentsPrefix('/p', 'main');
    localStorage.setItem(prefix + 'bad', '{');
    expect(() => readComments(prefix)).toThrow();
    expect(localStorage.getItem(prefix + 'bad')).toBe('{');
  });
  it('rejects malformed or oversized preview messages', () => {
    expect(isCommentTarget(note.target)).toBe(true);
    expect(isCommentTarget({ ...note.target, viewport: { width: -1, height: 0 } })).toBe(false);
    expect(isCommentTarget({ ...note.target, rect: { a: 1, b: 2, c: 3, d: 4 } })).toBe(false);
    expect(isCommentTarget({ ...note.target, selector: 'x'.repeat(9000) })).toBe(false);
  });
});

it('keeps combined sizes through storage and agent handoff while supporting older notes', () => {
  const prefix = commentsPrefix('/project', 'main');
  saveComment(prefix, { ...note, scope: ['Tablet', 'Mobile'] });
  const saved = readComments(prefix);
  expect(saved[0].scope).toEqual(['Tablet', 'Mobile']);
  expect(formatCommentBatch('/project', 'main', saved, 'b')).toContain(
    '**Applies to:** Tablet, Mobile'
  );
  saveComment(prefix, { ...note, scope: 'All sizes' });
  expect(readComments(prefix)[0].scope).toBe('All sizes');
});
it.each([{ scope: [] }, { scope: ['Unknown'] }, { scope: ['Tablet', 'Tablet'] }])(
  'rejects invalid device selections %j',
  ({ scope }) => {
    const prefix = commentsPrefix('/project', 'main');
    localStorage.setItem(prefix + note.id, JSON.stringify({ ...note, scope }));
    expect(() => readComments(prefix)).toThrow();
  }
);
