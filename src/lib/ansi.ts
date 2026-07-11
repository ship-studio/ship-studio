/**
 * Strip ANSI escape sequences (SGR colors, cursor moves, OSC titles) from
 * a string so it can be displayed as plain text or sent to an agent
 * without the `\x1b[32mfoo\x1b[0m` noise.
 *
 * Covers three families:
 *   - CSI (Control Sequence Introducer): `ESC [ … final` — colors, cursor
 *     (including intermediate bytes, e.g. `ESC [ ? 25 l`)
 *   - OSC (Operating System Command): `ESC ] … BEL|ST` — window titles,
 *     hyperlinks (terminated by BEL or `ESC \`)
 *   - Single-character escapes in the `ESC @` … `ESC _` range — index,
 *     next-line, string terminator, etc.
 */
export function stripAnsi(input: string): string {
  return (
    input
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
  );
}
