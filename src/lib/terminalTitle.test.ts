import { describe, expect, it } from 'vitest';
import { agentStatusFromTitle, isFocusReport, sanitizeTerminalTitle } from './terminalTitle';

describe('sanitizeTerminalTitle', () => {
  it.each(['⠂', '⠐', '⠋', '⣿'])('removes Braille spinner frame %s', (frame) => {
    expect(sanitizeTerminalTitle(`${frame} ship-studio`)).toBe('ship-studio');
  });

  it('removes a multi-character animated status prefix', () => {
    expect(sanitizeTerminalTitle('⠂⠐⠋ ship-studio')).toBe('ship-studio');
  });

  it('continues to remove the existing dot and star status markers', () => {
    expect(sanitizeTerminalTitle('· ship-studio')).toBe('ship-studio');
    expect(sanitizeTerminalTitle('✳ ship-studio')).toBe('ship-studio');
  });

  it.each(['◐', '◑'])('removes the Claude Code 2.1 working frame %s', (frame) => {
    expect(sanitizeTerminalTitle(`${frame} Counting from 1 to 40`)).toBe('Counting from 1 to 40');
  });

  it('preserves an ordinary terminal title', () => {
    expect(sanitizeTerminalTitle('ship-studio')).toBe('ship-studio');
  });
});

describe('agentStatusFromTitle', () => {
  // A real turn from Claude Code 2.1.311, captured from its PTY.
  it('reads a Claude Code 2.1 turn as working, then waiting', () => {
    const titles = [
      '✳ Claude Code',
      '◐ Claude Code',
      '◐ Counting from 1 to 40',
      '◑ Counting from 1 to 40',
      '✳ Counting from 1 to 40',
    ];
    expect(titles.map(agentStatusFromTitle)).toEqual([
      'waiting',
      'thinking',
      'thinking',
      'thinking',
      'waiting',
    ]);
  });

  it.each(['⠂', '⠐', '⠋', '·', '•'])('reads older working frame %s as thinking', (frame) => {
    expect(agentStatusFromTitle(`${frame} ship-studio`)).toBe('thinking');
  });

  it.each(['✳', '✱', '✲', '*'])('reads %s as waiting', (glyph) => {
    expect(agentStatusFromTitle(`${glyph} ship-studio`)).toBe('waiting');
  });

  it('reads an unadorned title as idle', () => {
    expect(agentStatusFromTitle('ship-studio')).toBe('idle');
    expect(agentStatusFromTitle('')).toBe('idle');
  });
});

describe('isFocusReport', () => {
  it('matches exactly the focus-in and focus-out reports', () => {
    expect(isFocusReport('\x1b[I')).toBe(true);
    expect(isFocusReport('\x1b[O')).toBe(true);
  });

  it('leaves keystrokes and pastes alone', () => {
    expect(isFocusReport('\x1bOA')).toBe(false); // application-mode up arrow
    expect(isFocusReport('I')).toBe(false);
    expect(isFocusReport('\x1b[200~\x1b[O\x1b[201~')).toBe(false);
  });
});
