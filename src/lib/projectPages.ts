/**
 * Local, per-workspace organization for the Pages panel.
 *
 * Route inventory and source mutations come from the backend. This module only
 * stores display names, manual folders/order, and the last time a route was
 * opened in the preview.
 */

export type PageSortMode = 'manual' | 'az' | 'za' | 'recent';

export interface PageRouteInfo {
  route: string;
  file_path: string;
}

export interface PagePreference {
  displayName: string | null;
  parentFolderId: string | null;
  order: number;
  lastUsedAt: number | null;
}

export interface PageFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
  order: number;
}

export interface ProjectPagesState {
  version: 1;
  sortMode: PageSortMode;
  pages: Record<string, PagePreference>;
  folders: PageFolder[];
}

export type PageTreeEntry =
  | { kind: 'page'; id: string; label: string; order: number; lastUsedAt: number | null }
  | { kind: 'folder'; id: string; label: string; order: number; lastUsedAt: number | null };

export type PageEntryRef = { kind: 'page'; id: string } | { kind: 'folder'; id: string };

const STORAGE_PREFIX = 'shipstudio.pages.v1:';
const VALID_SORT_MODES = new Set<PageSortMode>(['manual', 'az', 'za', 'recent']);

export function emptyProjectPagesState(): ProjectPagesState {
  return { version: 1, sortMode: 'manual', pages: {}, folders: [] };
}

/**
 * Storage is scoped to the active checkout and monorepo workspace. Worktrees
 * naturally receive their own identity because `projectPath` is their path.
 */
export function projectPagesStorageKey(
  projectPath: string,
  workspaceSubpath: string | null
): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(JSON.stringify([projectPath, workspaceSubpath ?? '']))}`;
}

export function loadProjectPagesState(storageKey: string): ProjectPagesState {
  try {
    const saved = window.localStorage.getItem(storageKey);
    return saved
      ? normalizeProjectPagesState(JSON.parse(saved) as unknown)
      : emptyProjectPagesState();
  } catch {
    return emptyProjectPagesState();
  }
}

export function saveProjectPagesState(storageKey: string, state: ProjectPagesState): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Organization remains usable for this session when storage is unavailable.
  }
}

export function normalizeProjectPagesState(value: unknown): ProjectPagesState {
  if (!isRecord(value) || value.version !== 1) return emptyProjectPagesState();

  const sortMode = VALID_SORT_MODES.has(value.sortMode as PageSortMode)
    ? (value.sortMode as PageSortMode)
    : 'manual';
  const rawFolders = Array.isArray(value.folders)
    ? value.folders.flatMap((item) => {
        if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') {
          return [];
        }
        return [
          {
            id: item.id,
            name: item.name,
            parentFolderId: typeof item.parentFolderId === 'string' ? item.parentFolderId : null,
            order: finiteOr(item.order, 0),
          },
        ];
      })
    : [];
  const folders = rawFolders.filter(
    (folder, index) => rawFolders.findIndex((candidate) => candidate.id === folder.id) === index
  );
  const folderIds = new Set(folders.map((folder) => folder.id));
  const normalizedFolders = folders.map((folder) => ({
    ...folder,
    parentFolderId:
      folder.parentFolderId &&
      folder.parentFolderId !== folder.id &&
      folderIds.has(folder.parentFolderId)
        ? folder.parentFolderId
        : null,
  }));
  breakFolderCycles(normalizedFolders);

  const pages: ProjectPagesState['pages'] = {};
  if (isRecord(value.pages)) {
    for (const [route, raw] of Object.entries(value.pages)) {
      if (!isRecord(raw)) continue;
      const parentFolderId = typeof raw.parentFolderId === 'string' ? raw.parentFolderId : null;
      pages[route] = {
        displayName: typeof raw.displayName === 'string' ? raw.displayName : null,
        parentFolderId: parentFolderId && folderIds.has(parentFolderId) ? parentFolderId : null,
        order: finiteOr(raw.order, 0),
        lastUsedAt: Number.isFinite(raw.lastUsedAt) ? (raw.lastUsedAt as number) : null,
      };
    }
  }

  return { version: 1, sortMode, pages, folders: normalizedFolders };
}

/** Add new routes and their route-derived folders; keep saved manual moves. */
export function reconcilePageInventory(
  state: ProjectPagesState,
  inventory: readonly PageRouteInfo[]
): ProjectPagesState {
  // Keep preferences for temporarily absent routes. A branch switch or an
  // incomplete scan must not erase the user's organization; an explicit delete
  // removes its preference in `removePagePreference`.
  const pages = { ...state.pages };
  const folders = state.folders.map((folder) => ({ ...folder }));
  for (const page of inventory) {
    if (pages[page.route]) continue;
    const parentFolderId = ensureRouteFolders(page.route, folders, pages);
    const order = nextOrder(folders, pages, parentFolderId);
    pages[page.route] = { displayName: null, parentFolderId, order, lastUsedAt: null };
  }

  return { ...state, pages, folders };
}

/** Read the display name saved for a route or derive a concise label from it. */
export function pageDisplayName(route: string, preference?: PagePreference): string {
  const custom = preference?.displayName?.trim();
  if (custom) return custom;
  if (route === '/') return 'Home';
  const segments = route.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? route;
  return lastSegment
    .replace(/\[[^\]]+\]/g, 'Dynamic')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function isDynamicPageRoute(route: string): boolean {
  return (route.includes('[') && route.includes(']')) || /:[^/]+|\*/.test(route);
}

/** Validate user-entered paths without guessing or constructing a URL. */
export function validateStaticPageRoute(input: string): {
  route: string | null;
  error: string | null;
} {
  const route = input.trim();
  if (!route.startsWith('/')) {
    return { route: null, error: 'Start the URL with /, for example /about.' };
  }
  if (route === '/') return { route, error: null };
  if (
    route.startsWith('//') ||
    route.endsWith('/') ||
    /[?#\\%\s:*]/.test(route) ||
    route.includes('[') ||
    route.includes(']')
  ) {
    return {
      route: null,
      error: 'Use a static path such as /about or /blog/post, without a trailing slash.',
    };
  }
  const segments = route.slice(1).split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.startsWith('.') ||
        segment.startsWith('_') ||
        /\.(astro|md|mdx|html|js|ts)$/i.test(segment) ||
        !/^[\p{L}\p{N}._~-]+$/u.test(segment)
    )
  ) {
    return {
      route: null,
      error:
        'Use static URL segments with letters, numbers, hyphens, underscores, dots, or tildes. Avoid file extensions and reserved prefixes.',
    };
  }
  return { route, error: null };
}

export function setPageSortMode(
  state: ProjectPagesState,
  sortMode: PageSortMode
): ProjectPagesState {
  return { ...state, sortMode };
}

export function renamePagePreference(
  state: ProjectPagesState,
  route: string,
  displayName: string
): ProjectPagesState {
  const current = state.pages[route];
  if (!current) return state;
  const clean = displayName.trim();
  return {
    ...state,
    pages: { ...state.pages, [route]: { ...current, displayName: clean || null } },
  };
}

export function recordPageOpened(
  state: ProjectPagesState,
  route: string,
  openedAt = Date.now()
): ProjectPagesState {
  const current = state.pages[route];
  if (!current) return state;
  return {
    ...state,
    pages: { ...state.pages, [route]: { ...current, lastUsedAt: openedAt } },
  };
}

export function createPageFolder(
  state: ProjectPagesState,
  name: string,
  parentFolderId: string | null,
  id: string
): ProjectPagesState {
  const folderName = name.trim();
  if (!folderName) return state;
  const order = nextOrder(state.folders, state.pages, parentFolderId);
  return {
    ...state,
    folders: [...state.folders, { id, name: folderName, parentFolderId, order }],
  };
}

export function renamePageFolder(
  state: ProjectPagesState,
  id: string,
  name: string
): ProjectPagesState {
  const folderName = name.trim();
  if (!folderName) return state;
  return {
    ...state,
    folders: state.folders.map((folder) =>
      folder.id === id ? { ...folder, name: folderName } : folder
    ),
  };
}

/** Removing a folder keeps every page and nested folder by lifting its direct children. */
export function removePageFolder(state: ProjectPagesState, id: string): ProjectPagesState {
  const folder = state.folders.find((item) => item.id === id);
  if (!folder) return state;
  const next = {
    ...state,
    pages: { ...state.pages },
    folders: state.folders.filter((item) => item.id !== id),
  };
  let appendAt = nextOrder(next.folders, next.pages, folder.parentFolderId);
  for (const [route, preference] of Object.entries(next.pages)) {
    if (preference.parentFolderId === id) {
      next.pages[route] = {
        ...preference,
        parentFolderId: folder.parentFolderId,
        order: appendAt,
      };
      appendAt += 1;
    }
  }
  next.folders = next.folders.map((item) => {
    if (item.parentFolderId !== id) return item;
    const moved = { ...item, parentFolderId: folder.parentFolderId, order: appendAt };
    appendAt += 1;
    return moved;
  });
  return next;
}

export function siblingEntries(
  state: ProjectPagesState,
  parentFolderId: string | null,
  sortMode: PageSortMode = state.sortMode
): PageTreeEntry[] {
  const entries: PageTreeEntry[] = [
    ...state.folders
      .filter((folder) => folder.parentFolderId === parentFolderId)
      .map((folder) => ({
        kind: 'folder' as const,
        id: folder.id,
        label: folder.name,
        order: folder.order,
        lastUsedAt: mostRecentPageInFolder(state, folder.id),
      })),
    ...Object.entries(state.pages)
      .filter(([, preference]) => preference.parentFolderId === parentFolderId)
      .map(([route, preference]) => ({
        kind: 'page' as const,
        id: route,
        label: pageDisplayName(route, preference),
        order: preference.order,
        lastUsedAt: preference.lastUsedAt,
      })),
  ];
  if (sortMode === 'manual')
    return entries.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  if (sortMode === 'recent') {
    return entries.sort(
      (a, b) =>
        (b.lastUsedAt ?? Number.NEGATIVE_INFINITY) - (a.lastUsedAt ?? Number.NEGATIVE_INFINITY) ||
        a.label.localeCompare(b.label)
    );
  }
  const direction = sortMode === 'az' ? 1 : -1;
  return entries.sort((a, b) => direction * a.label.localeCompare(b.label));
}

export function parentFolderForEntry(state: ProjectPagesState, entry: PageEntryRef): string | null {
  return entry.kind === 'page'
    ? (state.pages[entry.id]?.parentFolderId ?? null)
    : (state.folders.find((folder) => folder.id === entry.id)?.parentFolderId ?? null);
}

export function canMovePageEntry(
  state: ProjectPagesState,
  entry: PageEntryRef,
  destinationFolderId: string | null
): boolean {
  if (!destinationFolderId) return true;
  const target = state.folders.find((folder) => folder.id === destinationFolderId);
  if (!target) return false;
  if (entry.kind === 'folder' && entry.id === destinationFolderId) return false;
  let parent = target.parentFolderId;
  while (parent) {
    if (entry.kind === 'folder' && parent === entry.id) return false;
    parent = state.folders.find((folder) => folder.id === parent)?.parentFolderId ?? null;
  }
  return true;
}

/** Move a page or folder to a sibling position, or nest it in another folder. */
export function movePageEntry(
  state: ProjectPagesState,
  entry: PageEntryRef,
  destinationFolderId: string | null,
  destinationIndex: number
): ProjectPagesState {
  if (!canMovePageEntry(state, entry, destinationFolderId)) return state;
  const siblings = siblingEntries(state, destinationFolderId, 'manual').filter(
    (item) => !(item.kind === entry.kind && item.id === entry.id)
  );
  const index = Math.max(0, Math.min(destinationIndex, siblings.length));
  const order = [
    ...siblings.slice(0, index),
    { kind: entry.kind, id: entry.id },
    ...siblings.slice(index),
  ];
  const pages = { ...state.pages };
  const folders = state.folders.map((folder) => ({ ...folder }));

  order.forEach((item, siblingOrder) => {
    if (item.kind === 'page') {
      const preference = pages[item.id];
      if (preference)
        pages[item.id] = {
          ...preference,
          parentFolderId: destinationFolderId,
          order: siblingOrder,
        };
    } else {
      const folder = folders.find((candidate) => candidate.id === item.id);
      if (folder) {
        folder.parentFolderId = destinationFolderId;
        folder.order = siblingOrder;
      }
    }
  });
  return { ...state, pages, folders };
}

export function renamePageRoutePreference(
  state: ProjectPagesState,
  oldRoute: string,
  newRoute: string
): ProjectPagesState {
  const preference = state.pages[oldRoute];
  if (!preference) return state;
  const pages = { ...state.pages };
  delete pages[oldRoute];
  pages[newRoute] = preference;
  return { ...state, pages };
}

export function swapPageRoutePreferences(
  state: ProjectPagesState,
  firstRoute: string,
  secondRoute: string
): ProjectPagesState {
  if (firstRoute === secondRoute) return state;
  const first = state.pages[firstRoute];
  const second = state.pages[secondRoute];
  if (!first && !second) return state;
  const pages = { ...state.pages };
  if (first) pages[secondRoute] = first;
  else delete pages[secondRoute];
  if (second) pages[firstRoute] = second;
  else delete pages[firstRoute];
  return { ...state, pages };
}

export function removePagePreference(state: ProjectPagesState, route: string): ProjectPagesState {
  if (!state.pages[route]) return state;
  const pages = { ...state.pages };
  delete pages[route];
  return { ...state, pages };
}

function ensureRouteFolders(
  route: string,
  folders: PageFolder[],
  pages: ProjectPagesState['pages']
): string | null {
  const segments = route.split('/').filter(Boolean);
  if (segments.length <= 1) return null;
  let parentFolderId: string | null = null;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const prefix = `/${segments.slice(0, index + 1).join('/')}`;
    const id = `route:${prefix}`;
    let folder = folders.find((item) => item.id === id);
    if (!folder) {
      folder = {
        id,
        name: segments[index] ?? prefix,
        parentFolderId,
        order: nextOrder(folders, pages, parentFolderId),
      };
      folders.push(folder);
    }
    parentFolderId = id;
  }
  return parentFolderId;
}

function nextOrder(
  folders: readonly PageFolder[],
  pages: ProjectPagesState['pages'],
  parentFolderId: string | null
): number {
  const orders = [
    ...folders
      .filter((folder) => folder.parentFolderId === parentFolderId)
      .map((folder) => folder.order),
    ...Object.values(pages)
      .filter((page) => page.parentFolderId === parentFolderId)
      .map((page) => page.order),
  ];
  return orders.length ? Math.max(...orders) + 1 : 0;
}

function mostRecentPageInFolder(state: ProjectPagesState, folderId: string): number | null {
  const descendantIds = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of state.folders) {
      if (
        folder.parentFolderId &&
        descendantIds.has(folder.parentFolderId) &&
        !descendantIds.has(folder.id)
      ) {
        descendantIds.add(folder.id);
        changed = true;
      }
    }
  }
  const dates = Object.values(state.pages)
    .filter((page) => page.parentFolderId && descendantIds.has(page.parentFolderId))
    .flatMap((page) => (page.lastUsedAt === null ? [] : [page.lastUsedAt]));
  return dates.length ? Math.max(...dates) : null;
}

function breakFolderCycles(folders: PageFolder[]): void {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    const visited = new Set([folder.id]);
    let parent = folder.parentFolderId;
    while (parent) {
      if (visited.has(parent)) {
        folder.parentFolderId = null;
        break;
      }
      visited.add(parent);
      parent = byId.get(parent)?.parentFolderId ?? null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
