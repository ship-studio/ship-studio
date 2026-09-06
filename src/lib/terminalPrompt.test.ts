import { expect, it } from 'vitest';
import { assertPromptReady, bracketedPrompt } from './terminalPrompt';
it('rejects the native agent trust screen even though bracketed paste is enabled', () => {
  expect(() =>
    assertPromptReady(
      'Accessing\nworkspace: /test\nYes, I trust this\nfolder\nEnter to confirm',
      false
    )
  ).toThrow('still pending');
});
it('rejects permission menus and working agents', () => {
  expect(() => assertPromptReady('Allow once\nAllow always', false)).toThrow();
  expect(() => assertPromptReady('Thinking…', true)).toThrow('busy');
  expect(() => assertPromptReady('❯ Try fixing a bug', false)).not.toThrow();
});
it('wraps one multiline paste without a submitting carriage return or embedded escape', () => {
  expect(bracketedPrompt('First\nSecond\r\x1b[201~')).toBe('\x1b[200~First\nSecond[201~\x1b[201~');
  expect(bracketedPrompt('hello').endsWith('\r')).toBe(false);
});
