import { getCapabilities } from './capabilities';
import { invoke } from './ipc';
import { isTauriRuntime } from './webEvents';

export async function homeDir(): Promise<string> {
  if (isTauriRuntime()) return invoke<string>('plugin:path|resolve_directory', { directory: 21 });
  return (await getCapabilities()).homeDir ?? '/';
}
