import { describe, expect, it } from 'vitest';
import { sanitizeTerminalTitle } from './terminalTitle';

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

  it('preserves an ordinary terminal title', () => {
    expect(sanitizeTerminalTitle('ship-studio')).toBe('ship-studio');
  });
});
