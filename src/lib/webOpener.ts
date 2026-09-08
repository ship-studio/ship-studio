import { invoke } from './ipc';
import { isTauriRuntime } from './webEvents';

export async function openUrl(url: string, openWith?: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke('plugin:opener|open_url', { url, with: openWith });
    return;
  }
  const parsed = new URL(url);
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}
