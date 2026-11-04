/**
 * Small JSON files in the app's documents folder: the offline cache, the
 * outbox, drafts and preferences. Each write goes to a temporary file first
 * and is then moved over the old one, so a crash mid-write leaves the last
 * good copy rather than half of one.
 */

import * as FileSystem from 'expo-file-system/legacy';

const DIR = `${FileSystem.documentDirectory ?? ''}companion-state/`;

export async function readJson<T>(name: string): Promise<T | null> {
  try {
    const raw = await FileSystem.readAsStringAsync(`${DIR}${name}`);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  const tmp = `${DIR}${name}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(value));
  await FileSystem.moveAsync({ from: tmp, to: `${DIR}${name}` });
}

export const removeJson = (name: string) =>
  FileSystem.deleteAsync(`${DIR}${name}`, { idempotent: true });

/**
 * `write` at most once per `ms`, always with the latest value, and once more
 * on `flush()` (the app going to the background, where it may be killed).
 */
export function debounced(write: () => Promise<void>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  const run = () => {
    timer = null;
    running = running.then(write).catch(() => {});
    return running;
  };
  return {
    schedule() {
      if (!timer) timer = setTimeout(() => void run(), ms);
    },
    flush() {
      if (timer) clearTimeout(timer);
      return run();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
