import { invoke } from './ipc';
import { isTauriRuntime } from './webEvents';

export async function exit(code = 0): Promise<void> {
  if (isTauriRuntime()) await invoke('plugin:process|exit', { code });
}

export async function relaunch(): Promise<void> {
  if (isTauriRuntime()) await invoke('plugin:process|restart');
  else location.reload();
}
