/** This phone's own settings (not the Mac's): kept on disk, read at launch. */

import { readJson, writeJson } from './persist';
import { defaultPrefs, getApp, setApp, type Prefs } from './store';

const FILE = 'prefs.json';

export async function loadPrefs() {
  const saved = await readJson<Partial<Prefs>>(FILE);
  if (saved) setApp({ prefs: { ...defaultPrefs, ...saved } });
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  const prefs = { ...getApp().prefs, [key]: value };
  setApp({ prefs });
  void writeJson(FILE, prefs).catch(() => {});
}
