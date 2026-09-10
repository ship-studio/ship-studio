/**
 * Shared design tokens for Harbr plugin UI components.
 *
 * Values are sourced from src/styles/base.css to ensure visual consistency
 * with the host app. Components use inline styles so no CSS files are needed.
 */

export const tokens = {
  borderRadius: {
    sm: '4px',
    md: '6px',
    lg: '12px',
  },
  transition: '0.15s ease',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif",
  fontSize: {
    xs: '10px',
    sm: '11px',
    base: '13px',
    md: '14px',
    lg: '16px',
    xl: '18px',
  },
} as const;
