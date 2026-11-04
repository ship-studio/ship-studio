import { describe, expect, it } from 'vitest';
import { blockedCopy, joinDictation } from './dictation';

describe('joinDictation', () => {
  it('appends spoken text after the draft with one space', () => {
    expect(joinDictation('', ' hello ')).toBe('hello');
    expect(joinDictation('Hi', 'there')).toBe('Hi there');
    expect(joinDictation('Hi\n', 'there')).toBe('Hi\nthere');
    expect(joinDictation('Hi', '  ')).toBe('Hi');
  });
});

describe('blockedCopy', () => {
  it('links permission problems to the right privacy pane', () => {
    expect(blockedCopy('microphone').settings).toContain('Privacy_Microphone');
    expect(blockedCopy('speechRecognition').settings).toContain('Privacy_SpeechRecognition');
    expect(blockedCopy('unavailable').settings).toBeUndefined();
  });
});
