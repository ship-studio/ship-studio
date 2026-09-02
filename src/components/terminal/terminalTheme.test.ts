import { describe, expect, it } from 'vitest';
import { createTerminalOptions, type TerminalThemeVariant } from './terminalTheme';

const variants: Array<
  [
    TerminalThemeVariant,
    {
      fontSize: number;
      cursorBlink: boolean;
      cursorStyle: 'block' | 'bar';
      scrollback: number;
      background: string;
    },
  ]
> = [
  [
    'normal',
    {
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      background: '#141414',
    },
  ],
  [
    'onboarding',
    {
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      background: '#141414',
    },
  ],
  [
    'build',
    {
      fontSize: 12,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      background: '#141414',
    },
  ],
  [
    'logs',
    {
      fontSize: 13,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: 10000,
      background: '#1a1a1a',
    },
  ],
  [
    'connection',
    {
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 1000,
      background: '#141414',
    },
  ],
];

describe('createTerminalOptions', () => {
  it.each(variants)('keeps the %s surface contract explicit', (variant, expected) => {
    expect(createTerminalOptions(variant)).toMatchObject({
      fontFamily: '"JetBrainsMono NF", Menlo, Monaco, "Courier New", monospace',
      fontSize: expected.fontSize,
      lineHeight: 1.2,
      cursorBlink: expected.cursorBlink,
      cursorStyle: expected.cursorStyle,
      scrollback: expected.scrollback,
      theme: {
        background: expected.background,
        foreground: '#bcbcbc',
        brightWhite: '#ffffff',
      },
    });
  });

  it('merges behavior and theme overrides without dropping the shared palette', () => {
    const options = createTerminalOptions('logs', {
      disableStdin: true,
      theme: { cursor: '#00ff00' },
    });

    expect(options.disableStdin).toBe(true);
    expect(options.theme).toMatchObject({
      cursor: '#00ff00',
      red: '#cd3131',
      brightBlue: '#3b8eea',
    });
  });
});
