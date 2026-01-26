/**
 * Mock for tauri-pty package
 */
export const spawn = () => ({
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => () => {},
  onExit: () => () => {},
});

export default { spawn };
