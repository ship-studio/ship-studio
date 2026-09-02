import { describe, expect, it } from 'vitest';
import { maxDockedPanelWidth } from './panelSizing';

const MIN = 220;
const MAX = 560;
const RESERVE = 160;

describe('maxDockedPanelWidth', () => {
  it('allows the full max on a wide pane', () => {
    expect(maxDockedPanelWidth(1400, MIN, MAX, RESERVE)).toBe(MAX);
  });

  it('reserves the canvas column once the pane can no longer afford the max', () => {
    // 700 - 160 = 540: the pinned panel gives way so the toolbar column keeps
    // enough room for its controls.
    expect(maxDockedPanelWidth(700, MIN, MAX, RESERVE)).toBe(540);
  });

  it('never drops below the panel minimum', () => {
    expect(maxDockedPanelWidth(300, MIN, MAX, RESERVE)).toBe(MIN);
    expect(maxDockedPanelWidth(0, MIN, MAX, RESERVE)).toBe(MIN);
  });
});
