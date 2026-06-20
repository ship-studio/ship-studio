import { describe, it, expect } from 'vitest';
import { stripAnsi } from './ansi';

describe('stripAnsi', () => {
  it('removes SGR color codes', () => {
    expect(stripAnsi('\x1b[32mfoo\x1b[0m')).toBe('foo');
  });

  it('removes cursor-move / erase CSI sequences', () => {
    expect(stripAnsi('a\x1b[2Kb')).toBe('ab');
  });

  it('removes BEL-terminated OSC window-title sequences', () => {
    expect(stripAnsi('\x1b]0;my title\x07rest')).toBe('rest');
  });

  it('removes interleaved CSI and OSC families', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07plain')).toBe('red plain');
  });

  it('passes a plain string through unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});
