/** Tree view for routes and their independently persisted panel folders. */

import { useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useDragSortContext } from '../../contexts/dragSortContextValue';
import {
  canMovePageEntry,
  isDynamicPageRoute,
  pageDisplayName,
  parentFolderForEntry,
  siblingEntries,
  type PageEntryRef,
  type PageFolder,
  type PageRouteInfo,
  type ProjectPagesState,
} from '../../lib/projectPages';
import type {
  DragSortMove,
  DragSortPlacement,
  DragSortPoint,
  DragSortTarget as DragSortCollisionTarget,
  DragSortValidation,
  DragSortValidationContext,
} from '../../lib/drag-sort/types';
import { Button } from '../primitives/Button';
import {
  DragSortHandle,
  DragSortItem,
  DragSortScope,
  DragSortTarget,
} from '../primitives/DragSort';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubmenu,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import { IconButton } from '../primitives/IconButton';
import { TemplateIcon } from '@/components/icons';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileIcon,
  EditFieldIcon,
  FolderIcon,
  FolderOpenIcon,
  HomeIcon,
  MoreHorizontalIcon,
  MoveToFolderIcon,
  DuplicateIcon,
  SettingsIcon,
  TrashIcon,
} from '@/components/icons';

export type PagePanelAction = 'rename' | 'settings' | 'duplicate' | 'delete' | 'homepage';
export type FolderPanelAction = 'rename' | 'delete';

interface Props {
  pages: readonly PageRouteInfo[];
  state: ProjectPagesState;
  currentRoute?: string;
  selectedTemplateRoute?: string | null;
  query: string;
  sourceMutationEnabled: boolean;
  onOpenPage: (route: string) => void;
  onPageAction: (page: PageRouteInfo, action: PagePanelAction) => void;
  onFolderAction: (folder: PageFolder, action: FolderPanelAction) => void;
  onMoveEntry: (entry: PageEntryRef, parentFolderId: string | null, index: number) => void;
  onDropToRoot: (entry: PageEntryRef) => void;
}

const ROOT_DROP_TARGET_ID = 'pages:root-drop-target';
const ROOT_GROUP_ID = 'pages:root';

function dragSortId(entry: PageEntryRef): string {
  return `${entry.kind}:${entry.id}`;
}

function entryFromDragSortId(id: string | number | undefined): PageEntryRef | null {
  if (typeof id !== 'string' || id === ROOT_DROP_TARGET_ID) return null;
  const separator = id.indexOf(':');
  if (separator < 0) return null;
  const kind = id.slice(0, separator);
  if (kind !== 'page' && kind !== 'folder') return null;
  return { kind, id: id.slice(separator + 1) };
}

function groupForParent(parentFolderId: string | null): string {
  return parentFolderId === null ? ROOT_GROUP_ID : `pages:folder:${parentFolderId}`;
}

function sameEntry(first: PageEntryRef, second: PageEntryRef): boolean {
  return first.kind === second.kind && first.id === second.id;
}

function isInsideFolder(state: ProjectPagesState, entry: PageEntryRef, folderId: string): boolean {
  let parentFolderId = parentFolderForEntry(state, entry);
  while (parentFolderId) {
    if (parentFolderId === folderId) return true;
    parentFolderId =
      state.folders.find((folder) => folder.id === parentFolderId)?.parentFolderId ?? null;
  }
  return false;
}

function placementForPageTarget(
  target: DragSortCollisionTarget,
  point: DragSortPoint,
  axis: 'vertical' | 'horizontal'
): DragSortPlacement {
  if (target.id === ROOT_DROP_TARGET_ID) return 'after';
  const entry = entryFromDragSortId(target.id);
  const coordinate = axis === 'horizontal' ? point.x : point.y;
  const start = axis === 'horizontal' ? target.rect.left : target.rect.top;
  const size = axis === 'horizontal' ? target.rect.width : target.rect.height;
  const ratio = size > 0 ? (coordinate - start) / size : 0.5;
  if (entry?.kind === 'folder' && ratio > 0.28 && ratio < 0.72) return 'inside';
  return ratio < 0.5 ? 'before' : 'after';
}

export function PagesPanelTree(props: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const pagesByRoute = useMemo(
    () => new Map(props.pages.map((page) => [page.route, page])),
    [props.pages]
  );
  const query = props.query.trim().toLocaleLowerCase();
  const searching = query.length > 0;
  const matchingRoutes = useMemo(() => {
    if (!searching) return new Set(props.pages.map((page) => page.route));
    return new Set(
      props.pages
        .filter((page) => {
          const name = pageDisplayName(
            page.route,
            props.state.pages[page.route]
          ).toLocaleLowerCase();
          return name.includes(query) || page.route.toLocaleLowerCase().includes(query);
        })
        .map((page) => page.route)
    );
  }, [props.pages, props.state.pages, query, searching]);
  const matchingAncestorFolders = useMemo(() => {
    const folderIds = new Set<string>();
    if (!searching) return folderIds;
    for (const route of matchingRoutes) {
      let parentFolderId = props.state.pages[route]?.parentFolderId ?? null;
      while (parentFolderId && !folderIds.has(parentFolderId)) {
        folderIds.add(parentFolderId);
        parentFolderId =
          props.state.folders.find((folder) => folder.id === parentFolderId)?.parentFolderId ??
          null;
      }
    }
    return folderIds;
  }, [matchingRoutes, props.state.folders, props.state.pages, searching]);
  const sortingEnabled = !searching && props.state.sortMode === 'manual';

  const canSortMove = (
    destination: { index: number; group: string | number; placement?: DragSortPlacement },
    context: DragSortValidationContext
  ): DragSortValidation => {
    if (!sortingEnabled) return { allowed: false, reason: 'Page sorting is unavailable here.' };
    const active = entryFromDragSortId(context.active.id);
    if (!active || !context.target) return { allowed: false, reason: 'Choose a page or folder.' };
    if (context.target.id === ROOT_DROP_TARGET_ID) {
      return parentFolderForEntry(props.state, active) === null
        ? { allowed: false, reason: 'This page or folder is already at the root.' }
        : { allowed: true };
    }
    const target = entryFromDragSortId(context.target.id);
    if (!target) return { allowed: false, reason: 'Choose a page or folder.' };
    if (destination.placement === 'inside' && target.kind !== 'folder') {
      return { allowed: false, reason: 'Pages cannot contain other pages or folders.' };
    }
    const destinationFolderId =
      destination.placement === 'inside' && target.kind === 'folder'
        ? target.id
        : parentFolderForEntry(props.state, target);
    return canMovePageEntry(props.state, active, destinationFolderId)
      ? { allowed: true }
      : {
          allowed: false,
          reason: 'A folder cannot move into itself or one of its own descendants.',
        };
  };

  const handleSortMove = (move: DragSortMove) => {
    if (!sortingEnabled) return;
    const active = entryFromDragSortId(move.activeId);
    if (!active || move.targetId === undefined) return;
    if (move.targetId === ROOT_DROP_TARGET_ID) {
      props.onDropToRoot(active);
      return;
    }
    const target = entryFromDragSortId(move.targetId);
    if (!target) return;
    if (move.to.placement === 'inside' && target.kind === 'folder') {
      props.onMoveEntry(active, target.id, siblingEntries(props.state, target.id, 'manual').length);
      return;
    }
    const destinationFolderId = parentFolderForEntry(props.state, target);
    const siblings = siblingEntries(props.state, destinationFolderId, 'manual').filter(
      (sibling) => !sameEntry(sibling, active)
    );
    const targetIndex = siblings.findIndex((sibling) => sameEntry(sibling, target));
    if (targetIndex < 0) return;
    props.onMoveEntry(
      active,
      destinationFolderId,
      targetIndex + (move.to.placement === 'after' ? 1 : 0)
    );
  };

  const isPartOfMovedFolder = (activeId: string | number, itemId: string | number) => {
    const active = entryFromDragSortId(activeId);
    const item = entryFromDragSortId(itemId);
    return Boolean(
      active?.kind === 'folder' &&
      item &&
      active.id !== item.id &&
      isInsideFolder(props.state, item, active.id)
    );
  };

  const toggleFolder = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderMoveSubmenu = (entry: PageEntryRef, label: string) => {
    const currentParent = parentFolderForEntry(props.state, entry);
    const destinations: { id: string | null; label: string }[] = [];
    if (currentParent !== null && canMovePageEntry(props.state, entry, null)) {
      destinations.push({ id: null, label: 'Root' });
    }
    for (const folder of orderedPageFolders(props.state)) {
      if (folder.id === currentParent || !canMovePageEntry(props.state, entry, folder.id)) continue;
      destinations.push({ id: folder.id, label: pageFolderPath(props.state, folder) });
    }

    return (
      <ContextMenuSubmenu
        label={label}
        icon={<MoveToFolderIcon size={14} />}
        disabled={destinations.length === 0}
      >
        {destinations.map((destination) => (
          <ContextMenuItem
            key={destination.id ?? 'root'}
            onSelect={() =>
              props.onMoveEntry(
                entry,
                destination.id,
                siblingEntries(props.state, destination.id, 'manual').length
              )
            }
          >
            {destination.label}
          </ContextMenuItem>
        ))}
      </ContextMenuSubmenu>
    );
  };

  const renderBranch = (parentFolderId: string | null, depth: number): ReactNode => {
    const entries = siblingEntries(props.state, parentFolderId);
    return entries.map((entry, index) => {
      const ref: PageEntryRef = { kind: entry.kind, id: entry.id };

      if (entry.kind === 'folder') {
        const folder = props.state.folders.find((item) => item.id === entry.id);
        if (!folder) return null;
        if (searching && !matchingAncestorFolders.has(folder.id)) return null;
        const isCollapsed = !searching && collapsed.has(folder.id);
        const actions = (
          <ContextMenu>
            <ContextMenuTrigger asChild openOnClick>
              <IconButton
                variant="ghost"
                size="compact"
                className="pages-row__menu-trigger"
                icon={<MoreHorizontalIcon size={16} />}
                aria-haspopup="menu"
                aria-label={`Settings for ${folder.name}`}
                title={`Settings for ${folder.name}`}
              />
            </ContextMenuTrigger>
            <ContextMenuContent aria-label={`Settings for ${folder.name}`}>
              <ContextMenuItem onSelect={() => props.onFolderAction(folder, 'rename')}>
                <EditFieldIcon size={14} />
                Rename folder
              </ContextMenuItem>
              {renderMoveSubmenu(ref, 'Move folder…')}
              {!searching && props.state.sortMode === 'manual' && index > 0 && (
                <ContextMenuItem onSelect={() => props.onMoveEntry(ref, parentFolderId, index - 1)}>
                  <ArrowUpIcon size={14} />
                  Move up
                </ContextMenuItem>
              )}
              {!searching && props.state.sortMode === 'manual' && index < entries.length - 1 && (
                <ContextMenuItem onSelect={() => props.onMoveEntry(ref, parentFolderId, index + 1)}>
                  <ArrowDownIcon size={14} />
                  Move down
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onSelect={() => props.onFolderAction(folder, 'delete')}
              >
                <TrashIcon size={14} />
                Remove folder
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );

        return (
          <div
            key={`folder:${folder.id}`}
            className="pages-tree__entry pages-tree__folder"
            role="treeitem"
            aria-expanded={!isCollapsed}
            aria-level={depth + 1}
            data-tree-depth={depth}
            data-folder-id={folder.id}
          >
            <DragSortItem
              id={dragSortId(ref)}
              group={groupForParent(parentFolderId)}
              index={index}
              label={`${folder.name} folder`}
              disabled={!sortingEnabled}
              targetDisabled={!sortingEnabled}
              showTargetIndicator={sortingEnabled}
              className="pages-tree__sortable-row"
              style={{ '--pages-tree-depth': depth } as CSSProperties}
            >
              <DragSortTarget className="pages-row pages-row--folder">
                <DragSortHandle asChild keyboardActivation="space">
                  <Button
                    variant="ghost"
                    size="compact"
                    className="pages-row__main"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleFolder(folder.id)}
                  >
                    <span className="pages-row__folder-icon">
                      {isCollapsed ? <FolderIcon size={16} /> : <FolderOpenIcon size={16} />}
                    </span>
                    <span className="pages-row__copy">
                      <span className="pages-row__name">{folder.name}</span>
                      <span className="pages-row__route">Folder</span>
                    </span>
                  </Button>
                </DragSortHandle>
                {actions}
              </DragSortTarget>
            </DragSortItem>
            {!isCollapsed && (
              <div role="group" className="pages-tree__branch">
                {renderBranch(folder.id, depth + 1)}
              </div>
            )}
          </div>
        );
      }

      const page = pagesByRoute.get(entry.id);
      if (!page || (searching && !matchingRoutes.has(page.route))) return null;
      const active = props.selectedTemplateRoute
        ? props.selectedTemplateRoute === page.route
        : props.currentRoute === page.route;
      const visuallyActive = active && page.route !== '/';
      return (
        <div
          key={`page:${page.route}`}
          className="pages-tree__entry"
          role="treeitem"
          aria-level={depth + 1}
          data-tree-depth={depth}
          aria-current={active ? 'page' : undefined}
          data-page-route={page.route}
        >
          <DragSortItem
            id={dragSortId(ref)}
            group={groupForParent(parentFolderId)}
            index={index}
            label={`${pageDisplayName(page.route, props.state.pages[page.route])} page`}
            disabled={!sortingEnabled}
            targetDisabled={!sortingEnabled}
            showTargetIndicator={sortingEnabled}
            className="pages-tree__sortable-row"
            style={{ '--pages-tree-depth': depth } as CSSProperties}
          >
            <DragSortTarget className={`pages-row${visuallyActive ? ' pages-row--active' : ''}`}>
              <PageRow
                page={page}
                state={props.state}
                searching={searching}
                sourceMutationEnabled={props.sourceMutationEnabled}
                renderMoveSubmenu={renderMoveSubmenu}
                siblings={entries.map((item) => item.id)}
                onOpen={props.onOpenPage}
                onAction={props.onPageAction}
                onMove={(targetParent, index) => props.onMoveEntry(ref, targetParent, index)}
              />
            </DragSortTarget>
          </DragSortItem>
        </div>
      );
    });
  };

  return (
    <DragSortScope
      axis="vertical"
      allowCrossGroup
      label="Pages"
      onMove={handleSortMove}
      canMove={canSortMove}
      placementForTarget={placementForPageTarget}
      insideHoldDelayMs={500}
      insideHoldFlashDurationMs={150}
      isPartOfActiveMove={isPartOfMovedFolder}
    >
      <div className="pages-tree" role="tree" aria-label="Pages">
        <div role="group" className="pages-tree__list">
          {renderBranch(null, 0)}
          {searching && matchingRoutes.size === 0 && (
            <div className="pages-tree__empty">No pages match this search.</div>
          )}
          {!searching && !props.pages.length && (
            <div className="pages-tree__empty">No pages found in this workspace.</div>
          )}
          {sortingEnabled && <RootDropTarget state={props.state} />}
        </div>
      </div>
    </DragSortScope>
  );
}

function RootDropTarget({ state }: { state: ProjectPagesState }) {
  const { manager } = useDragSortContext();
  const snapshot = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot
  );
  const active = entryFromDragSortId(snapshot.activeId ?? undefined);
  if (
    !active ||
    (snapshot.phase !== 'dragging' && snapshot.phase !== 'dropping') ||
    parentFolderForEntry(state, active) === null
  ) {
    return null;
  }
  return (
    <DragSortItem
      id={ROOT_DROP_TARGET_ID}
      group={ROOT_GROUP_ID}
      index={siblingEntries(state, null, 'manual').length}
      label="Move to root"
      targetOnly
      showTargetIndicator
      className="pages-tree__root-target"
    >
      <div className="pages-tree__root-drop">Drop here to move to root</div>
    </DragSortItem>
  );
}

function orderedPageFolders(
  state: ProjectPagesState,
  parentFolderId: string | null = null
): PageFolder[] {
  const folders = state.folders
    .filter((folder) => folder.parentFolderId === parentFolderId)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return folders.flatMap((folder) => [folder, ...orderedPageFolders(state, folder.id)]);
}

function pageFolderPath(state: ProjectPagesState, folder: PageFolder): string {
  const names = [folder.name];
  const visited = new Set([folder.id]);
  let parentFolderId = folder.parentFolderId;
  while (parentFolderId && !visited.has(parentFolderId)) {
    visited.add(parentFolderId);
    const parent = state.folders.find((item) => item.id === parentFolderId);
    if (!parent) break;
    names.unshift(parent.name);
    parentFolderId = parent.parentFolderId;
  }
  return names.join(' / ');
}

function PageRow({
  page,
  state,
  searching,
  sourceMutationEnabled,
  renderMoveSubmenu,
  siblings,
  onOpen,
  onAction,
  onMove,
}: {
  page: PageRouteInfo;
  state: ProjectPagesState;
  searching: boolean;
  sourceMutationEnabled: boolean;
  renderMoveSubmenu: (entry: PageEntryRef, label: string) => ReactNode;
  siblings: readonly string[];
  onOpen: (route: string) => void;
  onAction: (page: PageRouteInfo, action: PagePanelAction) => void;
  onMove: (parentFolderId: string | null, index: number) => void;
}) {
  const preference = state.pages[page.route];
  const dynamic = isDynamicPageRoute(page.route);
  const canEditSource = sourceMutationEnabled && !dynamic;
  const parentFolderId = preference?.parentFolderId ?? null;
  const siblingIndex = siblings.indexOf(page.route);

  return (
    <>
      <DragSortHandle asChild keyboardActivation="space">
        <Button
          variant="ghost"
          size="compact"
          width="fill"
          className={`pages-row__main pages-row__page${dynamic ? ' pages-row__page--dynamic' : ''}`}
          leftIcon={dynamic ? <TemplateIcon size={16} /> : <FileIcon size={16} />}
          onClick={() => onOpen(page.route)}
          aria-label={
            dynamic
              ? `Choose preview entry for ${pageDisplayName(page.route, preference)}`
              : undefined
          }
        >
          <span className="pages-row__copy">
            <span className="pages-row__name">
              {pageDisplayName(page.route, preference)}
              {page.route === '/' && (
                <span className="pages-row__home-badge">
                  <HomeIcon size={12} aria-hidden="true" />
                  Homepage
                </span>
              )}
            </span>
            <span className="pages-row__route">{page.route}</span>
          </span>
        </Button>
      </DragSortHandle>
      <ContextMenu>
        <ContextMenuTrigger asChild openOnClick>
          <IconButton
            variant="ghost"
            size="compact"
            className="pages-row__menu-trigger"
            icon={<MoreHorizontalIcon size={16} />}
            aria-haspopup="menu"
            aria-label={`Settings for ${pageDisplayName(page.route, preference)}`}
            title={`Settings for ${pageDisplayName(page.route, preference)}`}
          />
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`Settings for ${pageDisplayName(page.route, preference)}`}>
          <ContextMenuItem onSelect={() => onAction(page, 'rename')}>
            <EditFieldIcon size={14} />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onAction(page, 'settings')}>
            <SettingsIcon size={14} />
            Edit settings
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canEditSource || page.route === '/'}
            onSelect={() => onAction(page, 'homepage')}
          >
            <HomeIcon size={14} />
            Set as homepage
          </ContextMenuItem>
          <ContextMenuSeparator />
          {renderMoveSubmenu({ kind: 'page', id: page.route }, 'Move to folder…')}
          {!searching && state.sortMode === 'manual' && siblingIndex > 0 && (
            <ContextMenuItem onSelect={() => onMove(parentFolderId, siblingIndex - 1)}>
              <ArrowUpIcon size={14} />
              Move up
            </ContextMenuItem>
          )}
          {!searching &&
            state.sortMode === 'manual' &&
            siblingIndex >= 0 &&
            siblingIndex < siblings.length - 1 && (
              <ContextMenuItem onSelect={() => onMove(parentFolderId, siblingIndex + 1)}>
                <ArrowDownIcon size={14} />
                Move down
              </ContextMenuItem>
            )}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!canEditSource} onSelect={() => onAction(page, 'duplicate')}>
            <DuplicateIcon size={14} />
            Duplicate
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            disabled={!canEditSource}
            onSelect={() => onAction(page, 'delete')}
          >
            <TrashIcon size={14} />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
}
