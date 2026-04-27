/**
 * Strip ANSI escape sequences (SGR colors, cursor moves, OSC titles) from
 * a string so it can be displayed as plain text or sent to an agent
 * without the `\x1b[32mfoo\x1b[0m` noise.
 *
 * Covers two families:
 *   - CSI (Control Sequence Introducer): `ESC [ … letter`  — colors, cursor
 *   - OSC (Operating System Command):    `ESC ] … BEL`     — window titles
 */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}
