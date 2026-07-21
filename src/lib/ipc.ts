import { getWindowLabel, isTauriRuntime } from './webEvents';

interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>, options?: unknown): Promise<T>;
  convertFileSrc(path: string, protocol?: string): string;
}

const tauri = () =>
  (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;

export async function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
  options?: unknown
): Promise<T> {
  if (isTauriRuntime()) return tauri().invoke<T>(command, args, options);

  const windowLabel = await getWindowLabel();
  const response = await fetch(`/api/cmd/${encodeURIComponent(command)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Ship-Window': windowLabel },
    body: JSON.stringify(args),
  });
  const envelope = (await response.json()) as { ok: true; data: T } | { ok: false; error: unknown };
  if (!envelope.ok) throw envelope.error;
  return envelope.data;
}

export function convertFileSrc(path: string, protocol = 'asset'): string {
  if (isTauriRuntime()) return tauri().convertFileSrc(path, protocol);
  return `/api/file?path=${encodeURIComponent(path)}`;
}
