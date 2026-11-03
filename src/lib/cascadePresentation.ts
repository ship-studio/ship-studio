import { nestedRules, type RuleBody } from './cssBody';
import {
  cascadeSourceProvenance,
  cascadeSourceProvenanceKey,
  rowKey,
  type CascadeGroupItem,
  type CascadeRow,
  type CascadeSourceProvenance,
} from './cssCascade';

export type CascadeDisplayOrder = 'newest-top' | 'newest-bottom';

/** App-global localStorage key for the CSS cascade's presentation-only order. */
export const CASCADE_DISPLAY_ORDER_PREFERENCE_KEY = 'cssCascadeNewestBottom';

export interface CascadeSourceGroup {
  kind: 'source';
  /** Stable identity for this contiguous run, even when the same source recurs later. */
  key: string;
  source: CascadeSourceProvenance;
  items: CascadeGroupItem[];
}

export interface CascadeDestinationGroup {
  kind: 'destination';
  /** Stable identity for a contiguous run of drafts proposed for one known file. */
  key: string;
  file: string;
  items: CascadeGroupItem[];
}

export type CascadeFileGroup = CascadeSourceGroup | CascadeDestinationGroup;
export type CascadeDisplayItem = CascadeGroupItem | CascadeFileGroup;

export function isCascadeFileGroup(item: CascadeDisplayItem): item is CascadeFileGroup {
  return item.kind === 'source' || item.kind === 'destination';
}

/** Strip only the virtual suffix used for an embedded Astro `<style>` block. */
export function cascadeSourceBackingFile(path: string): string {
  const styleSuffix = /\?style=(\d+)$/.exec(path);
  return styleSuffix ? path.slice(0, styleSuffix.index) : path;
}

/** Use the compact source label while preserving the full reference for identity/tooltips. */
export function cascadeSourceFileLabel(path: string): string {
  const file = cascadeSourceBackingFile(path);
  const name = file.split(/[\\/]/).pop() ?? file;
  return file !== path ? `${name} › style` : name;
}

/** Stable collapse identity: source grouping follows the complete recorded path. */
export function cascadeFileCollapseKey(file: string): string {
  return `file:${file}`;
}

/** Keep collapse identity compatible for resolved paths and distinct for candidates. */
export function cascadeSourceCollapseKey(source: CascadeSourceProvenance): string {
  return source.kind === 'resolved'
    ? cascadeFileCollapseKey(source.file)
    : `sources:${cascadeSourceProvenanceKey(source)}`;
}

/** Top-level source groups are excluded from selector collapse/expand controls. */
export function isCascadeGroupCollapseKey(key: string): boolean {
  return key.startsWith('file:') || key.startsWith('sources:');
}

/** Group only contiguous rows with matching source provenance or a verified draft destination.
 *  A draft's destination stays separate from its source provenance and never gains a source line. */
export function groupCascadeItemsByFile(items: readonly CascadeGroupItem[]): CascadeDisplayItem[] {
  const displayItems: CascadeDisplayItem[] = [];

  const descriptorFor = (
    item: CascadeGroupItem
  ):
    | { kind: 'source'; key: string; source: CascadeSourceProvenance }
    | {
        kind: 'destination';
        key: string;
        file: string;
      }
    | undefined => {
    const rows = item.kind === 'media' ? item.rows : [item.row];
    const first = rows[0];
    const source = first && cascadeSourceProvenance(first);
    const sourceKey = cascadeSourceProvenanceKey(source);
    if (
      source &&
      rows.every((row) => cascadeSourceProvenanceKey(cascadeSourceProvenance(row)) === sourceKey)
    ) {
      return {
        kind: 'source',
        key: source.kind === 'resolved' ? `file:${source.file}` : `sources:${sourceKey}`,
        source,
      };
    }

    if (rows.length === 1 && first?.draft && first.draftTargetFile) {
      return {
        kind: 'destination',
        key: `file:${first.draftTargetFile}`,
        file: first.draftTargetFile,
      };
    }
    return undefined;
  };

  const displayGroupKey = (item: CascadeFileGroup): string =>
    item.kind === 'source'
      ? item.source.kind === 'resolved'
        ? `file:${item.source.file}`
        : `sources:${cascadeSourceProvenanceKey(item.source)}`
      : `file:${item.file}`;

  for (const item of items) {
    const descriptor = descriptorFor(item);
    if (!descriptor) {
      displayItems.push(item);
      continue;
    }

    const previous = displayItems[displayItems.length - 1];
    if (previous && isCascadeFileGroup(previous) && displayGroupKey(previous) === descriptor.key) {
      if (
        previous.kind === 'destination' &&
        descriptor.kind === 'source' &&
        descriptor.source.kind === 'resolved'
      ) {
        displayItems[displayItems.length - 1] = {
          kind: 'source',
          key: '',
          source: descriptor.source,
          items: [...previous.items, item],
        };
      } else {
        previous.items.push(item);
      }
    } else {
      displayItems.push(
        descriptor.kind === 'source'
          ? { kind: 'source', key: '', source: descriptor.source, items: [item] }
          : { kind: 'destination', key: '', file: descriptor.file, items: [item] }
      );
    }
  }

  // Provenance is not a run identity: the same source can recur after other rows.
  // Sorted row identities keep each run's React key stable when display order
  // reverses, while preserving independent headers for recurring runs.
  const itemKeys = (items: CascadeGroupItem[]) =>
    items
      .flatMap((groupItem) =>
        groupItem.kind === 'media' ? groupItem.rows.map(rowKey) : [rowKey(groupItem.row)]
      )
      .sort();
  return displayItems.map((item) => {
    if (item.kind === 'source') {
      return {
        ...item,
        key: JSON.stringify([cascadeSourceProvenanceKey(item.source), itemKeys(item.items)]),
      };
    }
    if (item.kind === 'destination') {
      return { ...item, key: JSON.stringify([item.file, itemKeys(item.items)]) };
    }
    return item;
  });
}

/** Keep inactive rules after applying rules in either direction; reverse the two cascade
 *  sections independently when newest rules are shown at the bottom. */
export function orderCascadeRowsForDisplay(
  rows: readonly CascadeRow[],
  order: CascadeDisplayOrder
): CascadeRow[] {
  const created: CascadeRow[] = [];
  const applying: CascadeRow[] = [];
  const inactive: CascadeRow[] = [];

  for (const row of rows) {
    // The editor assigns line 0 and a monotonically increasing synthetic index to a
    // rule created from Add selector. Drafts have no source line and remain in cascade position.
    if (row.editable && !row.draft && row.line === 0 && row.sourceOrder == null) {
      created.push(row);
    } else if (row.inactiveMedia) {
      inactive.push(row);
    } else {
      applying.push(row);
    }
  }

  created.sort((a, b) => b.index - a.index);
  return order === 'newest-top'
    ? [...created, ...applying, ...inactive]
    : [...applying.reverse(), ...inactive.reverse(), ...created.reverse()];
}

export function cascadeRuleCollapseKey(selector: string, context = ''): string {
  return `${selector}|${context}`;
}

export function cascadeMediaCollapseKey(key: string): string {
  return `media:${key}`;
}

/** Stable path for a nested card, independent of declaration indices. */
export function nestedRuleCollapseKey(
  parentKey: string,
  selector: string,
  occurrence: number
): string {
  return `${parentKey}::nested:${selector}#${occurrence}`;
}

/** Collect nested card identities using the same keys as `CascadeRuleCard`. */
export function collectNestedCollapseKeys(body: RuleBody, parentKey: string): Set<string> {
  const keys = new Set<string>();
  const visit = (current: RuleBody, parent: string) => {
    const occurrences = new Map<string, number>();
    for (const nested of nestedRules(current)) {
      const occurrence = occurrences.get(nested.selector) ?? 0;
      occurrences.set(nested.selector, occurrence + 1);
      const key = nestedRuleCollapseKey(parent, nested.selector, occurrence);
      keys.add(key);
      visit(nested.body, key);
    }
  };
  visit(body, parentKey);
  return keys;
}
