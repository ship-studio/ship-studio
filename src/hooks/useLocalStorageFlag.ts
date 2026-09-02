import { useCallback, useState } from 'react';

function readFlag(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? defaultValue : raw === '1';
  } catch {
    // Private-mode / disabled storage — fall back to the default rather than
    // taking the whole view down.
    return defaultValue;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Non-fatal: the preference just doesn't survive the session.
  }
}

/**
 * A boolean UI preference persisted in localStorage as '1' / '0'.
 *
 * Panel pins and visibility toggles all repeated the same read-on-mount /
 * write-on-change pair; this centralizes it (and the storage guards).
 *
 * Returns `[value, set, toggle]`.
 */
export function useLocalStorageFlag(
  key: string,
  defaultValue: boolean
): [boolean, (value: boolean) => void, () => void] {
  const [value, setValue] = useState(() => readFlag(key, defaultValue));

  const set = useCallback(
    (next: boolean) => {
      writeFlag(key, next);
      setValue(next);
    },
    [key]
  );

  const toggle = useCallback(() => {
    setValue((current) => {
      writeFlag(key, !current);
      return !current;
    });
  }, [key]);

  return [value, set, toggle];
}
