import { invoke } from './ipc';
import { isTauriRuntime } from './webEvents';

export enum BaseDirectory {
  Resource = 11,
}

interface FsOptions {
  baseDir?: BaseDirectory;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin' });
  const body = (await response.json()) as { ok: boolean; data?: T; error?: unknown };
  if (!body.ok) throw body.error;
  return body.data as T;
}

export async function readTextFile(path: string, options?: FsOptions): Promise<string> {
  if (isTauriRuntime()) return invoke('plugin:fs|read_text_file', { path, options });
  const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`Failed to read ${path}`);
  return response.text();
}

export async function readFile(path: string, options?: FsOptions): Promise<Uint8Array> {
  if (isTauriRuntime()) return invoke('plugin:fs|read_file', { path, options });
  const response = await fetch(options?.baseDir === BaseDirectory.Resource ? `/${path}` : path);
  if (!response.ok) throw new Error(`Failed to read ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function readDir(path: string, options?: FsOptions): Promise<DirEntry[]> {
  if (isTauriRuntime()) return invoke('plugin:fs|read_dir', { path, options });
  const data = await api<{ entries: Array<{ name: string; isDirectory: boolean }> }>(
    `/api/browse?path=${encodeURIComponent(path)}`
  );
  return data.entries;
}

export async function exists(path: string, options?: FsOptions): Promise<boolean> {
  if (isTauriRuntime()) return invoke('plugin:fs|exists', { path, options });
  return api<boolean>(`/api/fs/exists?path=${encodeURIComponent(path)}`);
}
