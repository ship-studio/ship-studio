import { getWindowLabel, isTauriRuntime } from './webEvents';

interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>, options?: unknown): Promise<T>;
  convertFileSrc(path: string, protocol?: string): string;
  transformCallback(callback: (value: unknown) => void): number;
  unregisterCallback(id: number): void;
}

const tauri = () =>
  (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;

export class Resource {
  constructor(public readonly rid: number) {}

  async close(): Promise<void> {
    await invoke('plugin:resources|close', { rid: this.rid });
  }
}

export class Channel<T = unknown> {
  readonly id: number;
  onmessage: (message: T) => void = () => {};

  constructor(onmessage?: (message: T) => void) {
    if (onmessage) this.onmessage = onmessage;
    this.id = tauri().transformCallback((raw) => {
      const frame = raw as { message?: T; end?: true };
      if ('end' in frame) tauri().unregisterCallback(this.id);
      else this.onmessage(frame.message as T);
    });
  }

  toJSON(): string {
    return `__CHANNEL__:${this.id}`;
  }
}

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
