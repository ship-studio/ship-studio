import type { ITheme, ITerminalOptions } from '@xterm/xterm';

export type TerminalThemeVariant = 'normal' | 'onboarding' | 'build' | 'logs' | 'connection';

type TerminalVisualOptions = Pick<
  ITerminalOptions,
  | 'fontFamily'
  | 'fontSize'
  | 'lineHeight'
  | 'cursorBlink'
  | 'cursorStyle'
  | 'scrollback'
  | 'minimumContrastRatio'
>;

/*
 * These values intentionally live at the xterm API boundary. They are not CSS
 * values and cannot be represented by the app token cascade; each terminal
 * variant consumes this one palette through createTerminalOptions().
 */
const TERMINAL_THEME: ITheme = {
  background: '#141414',
  foreground: '#bcbcbc',
  cursor: '#ffffff',
  selectionBackground: '#393939',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

const STANDARD_TERMINAL_OPTIONS: TerminalVisualOptions = {
  fontFamily: '"JetBrainsMono NF", Menlo, Monaco, "Courier New", monospace',
  lineHeight: 1.2,
  cursorBlink: true,
  cursorStyle: 'block',
  scrollback: 5000,
  // Match VS Code's default and keep dim ANSI text readable on dark cells.
  minimumContrastRatio: 4.5,
};

const TERMINAL_VARIANT_OPTIONS: Record<TerminalThemeVariant, TerminalVisualOptions> = {
  normal: { ...STANDARD_TERMINAL_OPTIONS, fontSize: 13 },
  onboarding: { ...STANDARD_TERMINAL_OPTIONS, fontSize: 13 },
  build: { ...STANDARD_TERMINAL_OPTIONS, fontSize: 12, cursorStyle: 'bar' },
  logs: { ...STANDARD_TERMINAL_OPTIONS, fontSize: 13, cursorBlink: false, scrollback: 10000 },
  connection: { ...STANDARD_TERMINAL_OPTIONS, fontSize: 13, scrollback: 1000 },
};

const TERMINAL_VARIANT_THEME: Record<TerminalThemeVariant, Partial<ITheme>> = {
  normal: {},
  onboarding: {},
  build: {},
  logs: { background: '#1a1a1a' },
  connection: {},
};

/**
 * Build the shared xterm options for a terminal surface.
 *
 * Callers may provide lifecycle/input overrides, but visual options and the
 * palette stay explicit and centralized here.
 */
export function createTerminalOptions(
  variant: TerminalThemeVariant,
  overrides: Partial<ITerminalOptions> = {}
): ITerminalOptions {
  const { theme: themeOverride, ...behaviorOverrides } = overrides;

  return {
    ...TERMINAL_VARIANT_OPTIONS[variant],
    ...behaviorOverrides,
    theme: {
      ...TERMINAL_THEME,
      ...TERMINAL_VARIANT_THEME[variant],
      ...themeOverride,
    },
  };
}
