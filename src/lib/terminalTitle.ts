/**
 * Remove agent activity glyphs from a terminal title before it is shown in
 * Ship Studio's tab and sidebar labels.
 *
 * Claude Code animates its thinking state by repeatedly replacing a leading
 * Braille character in the terminal title. Match the complete Braille Unicode
 * block rather than individual frames so newly introduced or multi-character
 * frames cannot leak into the visible title beside Ship Studio's own loader.
 */
const AGENT_STATUS_PREFIX = /^[\u2800-\u28ff·•✳✱✲*]+\s*/u;

export function sanitizeTerminalTitle(title: string): string {
  return title.replace(AGENT_STATUS_PREFIX, '').trim();
}
