/**
 * `tauri-pty` talks to a native side that does not exist in a browser. The
 * harness is for looking at UI, not for driving a real agent session, so the
 * terminal renders its chrome and stays inert — visibly empty rather than
 * faking agent output that never happened.
 */
export function spawn() {
  return {
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
}
export default { spawn };
