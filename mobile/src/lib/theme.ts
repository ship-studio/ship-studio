/**
 * Ship Studio's tokens, for React Native. Values are copied from the desktop's
 * token layers (src/styles/global/tokens-core.css → tokens-semantic.css); the
 * names are the semantic roles, so `colors.surfacePanel` is `--surface-panel`.
 * Don't add a colour here that the desktop doesn't have.
 */

export const colors = {
  surfaceApp: '#141414', // --surface-app (gray-950)
  surfacePanel: '#1a1a1a', // --surface-panel (gray-900)
  surfaceControl: '#282828', // --surface-control (gray-850)
  surfaceControlHover: '#303030', // --surface-control-hover (gray-800)
  surfaceSelected: '#393939', // --surface-selected (gray-750)
  textWhite: '#ffffff',
  textPrimary: '#bcbcbc', // --text-primary (gray-200)
  textSecondary: '#979797', // --text-secondary (gray-400)
  // --text-muted is gray-600 on the desk, 4.06:1 on these surfaces: too faint
  // for words read outdoors at 12-14pt. The phone takes the next step up the
  // desktop's own scale, which passes 4.5:1 on app and panel.
  textMuted: '#868686', // --color-gray-500
  // Decoration only (rules, chevrons, a disabled glyph), never words: 2.2:1.
  textFaint: '#4e4e4e', // --text-faint (gray-700)
  textOnAccent: '#141414', // --text-on-accent
  borderDefault: '#282828', // --border-default
  borderSubtle: '#303030', // --border-subtle
  borderStrong: '#393939', // --border-strong
  accentActive: '#46e76f', // --accent-active (green-500)
  accentSuccess: '#35d35d', // --accent-success (green-600)
  accentWarning: '#e89a1c', // --accent-warning (orange-600)
  accentError: '#f44747', // --accent-error
  accentErrorLight: '#ef4444', // --accent-error-light
  accentFocus: '#2792ff', // --accent-focus (blue-500)
  scrim: 'rgba(0, 0, 0, 0.75)', // --color-black-o75
  black: '#000000', // --color-black: behind a photo, as the system viewer has it
} as const;

/** `--agents-tint-*` in src/styles/features/agents.css, keyed like `Agent.color`. */
export const agentTints: Record<string, string> = {
  white: '#e6e6e6',
  brown: '#b08560',
  red: '#ef5b50',
  orange: '#f07c3c',
  amber: '#e9a83a',
  green: '#3fbf6a',
  teal: '#2fb3a1',
  blue: '#4d8ff5',
  purple: '#9471f5',
  pink: '#e45a9f',
  gray: '#8a8a8a',
};

/** `--spacing-*`. */
export const space = {
  '3xs': 1,
  '2xs': 2,
  xs: 4,
  tight: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
} as const;

/** `--radius-*`. */
export const radius = { sm: 4, control: 6, card: 8, lg: 12, pill: 999 } as const;

/**
 * The desktop's type scale (`--font-size-*`), one step up where the desk
 * reads at arm's length and a phone at hand's: body 16 (T3 and most chat
 * apps sit at 16-17), subtitles 14, captions 12 for metadata only.
 */
export const type = {
  caption: 12,
  small: 14,
  body: 16,
  subhead: 16,
  title: 18,
  display: 28,
} as const;

/**
 * How far chrome may grow with Dynamic Type before it would crowd out what
 * it frames: titles, pills, avatar initials and buttons. Message bodies have
 * no cap; they reflow.
 */
export const chromeScale = 1.3;

export const lineHeight = (size: number, ratio = 1.4) => Math.round(size * ratio);

export const fonts = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  mono: 'GeistMono_400Regular',
} as const;

/** `color-mix(in srgb, a p%, b)`, which the avatar tile uses. */
export function mix(a: string, b: string, p: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const c = ca.map((v, i) => Math.round(v * p + cb[i] * (1 - p)));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** `rgba()` of a hex colour, for tints and glows. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function parseHex(hex: string): number[] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** `--duration-*`. */
export const duration = { fast: 100, standard: 150, slow: 300 } as const;
