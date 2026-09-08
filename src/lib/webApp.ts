import { invoke } from './ipc';
import { isTauriRuntime } from './webEvents';

declare const __APP_VERSION__: string;

export function getVersion(): Promise<string> {
  return isTauriRuntime() ? invoke<string>('plugin:app|version') : Promise.resolve(__APP_VERSION__);
}
