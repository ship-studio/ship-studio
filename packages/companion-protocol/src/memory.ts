/**
 * An agent's memory as both clients list it: entries by group, and the
 * change that undoes a delete. Pure, shared with the desktop's
 * src/lib/agents.ts (which re-exports them).
 */

import type { MemoryChange, MemoryEntry } from './model';

export interface MemoryGroup {
  /** null: the agent's own memory, above any heading. */
  title: string | null;
  items: { entry: MemoryEntry; index: number }[];
}

/** Entries by group: the agent's own first, then each heading in file order. */
export function groupMemory(entries: MemoryEntry[]): MemoryGroup[] {
  const groups: MemoryGroup[] = [{ title: null, items: [] }];
  entries.forEach((entry, index) => {
    const title = entry.group ?? null;
    let group = groups.find((g) => g.title === title);
    if (!group) {
      group = { title, items: [] };
      groups.push(group);
    }
    group.items.push({ entry, index });
  });
  return groups.filter((g) => g.title === null || g.items.length > 0);
}

/** The change that puts back entry `index` of `before`, removed as `removed`. */
export function undoDelete(
  before: MemoryEntry[],
  index: number,
  removed: string | undefined
): MemoryChange {
  const entry = before[index];
  const sameGroup = (e: MemoryEntry | undefined) =>
    e && (e.group ?? null) === (entry.group ?? null) ? e.text : undefined;
  return {
    op: 'add',
    text: entry.text,
    group: entry.group,
    after: sameGroup(before[index - 1]),
    before: sameGroup(before[index + 1]),
    raw: removed,
  };
}
