/**
 * Element tree panel — a Webflow-style navigator for the preview.
 *
 * Shows the rendered DOM as a collapsible tree; clicking a row selects the
 * element through the same path as clicking it on the canvas, so the visual
 * editor panel picks it up. Structural edits (insert / duplicate / delete /
 * cut / copy / paste)
 * live in the row context menu; each action selects its row first
 * (`selectAndRun`) so it operates on the element the user aimed at.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
  type CSSProperties,
  type RefObject,
} from 'react';
import {
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  ContractVerticalIcon,
  ContrastIcon,
  CopyIcon,
  CutIcon,
  DuplicateIcon,
  ExpandVerticalIcon,
  FontIcon,
  PinIcon,
  PasteIcon,
  PlusIcon,
  TagIconsIcon,
  TrashIcon,
} from '@/components/icons';
import { ElementHtmlEditor } from './ElementHtmlEditor';
import { InsertMenu } from './InsertMenu';
import { getElementIcon } from './element-icons';
import { describeClipboardError, useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useElementDisplayPreferences } from '../../hooks/useElementDisplayPreferences';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';
import { Tooltip } from '../primitives/Tooltip';
import type { ElementTreeNode } from '../../hooks/useElementTree';
import type { ElementSignature } from '../../lib/edit';
import {
  STRUCTURAL_ELEMENTS,
  VOID_ELEMENTS,
  type ElementKind,
  type InsertPosition,
} from '../../lib/edit-structure';
import { kbd } from '../../lib/shortcuts';
import { DragSortItem, DragSortScope } from '../primitives/DragSort';
import { useDragSortContext } from '../../contexts/DragSortContext';
import type {
  DragSortMove,
  DragSortPlacement,
  DragSortPoint,
  DragSortTarget as DragSortCollisionTarget,
} from '../../lib/drag-sort/types';
import { useCommands } from '../../commands/useCommands';
import type { PaletteCtx } from '../../commands/types';
import {
  flattenElementTree,
  projectElementTree,
  type ElementTreeRow,
} from '../../lib/element-tree-drag';

/** The structural-edit actions the panel's context menu drives
 *  (from `useElementStructure`). */
export interface TreeStructureActions {
  selectAndRun: (nodeId: number, action: () => void) => void;
  insert: (position: InsertPosition, kind: ElementKind) => void;
  move?: (
    sourceNodeId: number,
    targetNodeId: number,
    position: InsertPosition
  ) => void | Promise<void>;
  duplicate: () => void;
  remove: () => void;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  hasClipboard: boolean;
  clipboardSourceNodeId: number | null;
  busy?: boolean;
}

interface Props {
  tree: ElementTreeNode | null;
  truncated: boolean;
  selectedId: number | null;
  /** The element currently hovered in the preview, when edit mode is active. */
  hoveredId?: number | null;
  /** Same-source matches that will also change when the primary selection is edited. */
  affectedIds?: readonly number[];
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
  /** The currently-selected element (for the Code/HTML view). */
  projectPath: string;
  selectedSignature: ElementSignature | null;
  /** Notified when the Visual/Code view toggles, so the parent can widen the
   *  panel for editing markup. */
  onViewChange?: (view: 'visual' | 'code') => void;
  /** When provided, rows get the structural-edit context menu. */
  structure?: TreeStructureActions;
  /** Ref to the panel shell, used by the parent resize control. */
  panelRef?: RefObject<HTMLDivElement | null>;
  /** Whether the panel currently occupies its left-hand preview dock. */
  pinned?: boolean;
  /** Switch between the preview dock and a draggable floating panel. */
  onTogglePin?: () => void;
  /** Hide the panel without changing its docked/floating preference. */
  onClose?: () => void;
}

/** Rows at depth < this start expanded so the tree isn't a single chevron. */
const AUTO_EXPAND_DEPTH = 3;
const TREE_INSIDE_ZONE_START = 0.35;
const TREE_INSIDE_ZONE_END = 0.65;
const TREE_INSIDE_HOLD_DELAY_MS = 500;
const TREE_INSIDE_HOLD_FLASH_DURATION_MS = 150;

/** Map of node id → ancestor id chain, for auto-expanding to a selection. */
function buildAncestors(root: ElementTreeNode): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const walk = (node: ElementTreeNode, chain: number[]) => {
    out.set(node.id, chain);
    const next = [...chain, node.id];
    for (const child of node.children) walk(child, next);
  };
  walk(root, []);
  return out;
}

function findExpandableElements(root: ElementTreeNode) {
  const elements: { id: number; depth: number; tag: string }[] = [];
  const walk = (node: ElementTreeNode, depth: number) => {
    if (node.children.length > 0) elements.push({ id: node.id, depth, tag: node.tag });
    node.children.forEach((child) => walk(child, depth + 1));
  };
  walk(root, 0);
  return elements;
}

function findSiblings(
  root: ElementTreeNode,
  nodeId: number
): { siblings: ElementTreeNode[]; index: number } | null {
  const walk = (node: ElementTreeNode): { siblings: ElementTreeNode[]; index: number } | null => {
    const index = node.children.findIndex((child) => child.id === nodeId);
    if (index >= 0) return { siblings: [...node.children], index };
    for (const child of node.children) {
      const result = walk(child);
      if (result) return result;
    }
    return null;
  };
  return walk(root);
}

/** The CSS-selector-shaped string the tree row's own label is built from
 *  (tag + every class, dot-joined) — what "Copy selector" puts on the
 *  clipboard, so pasting it into a chat matches what was right-clicked. */
function elementSelector(tag: string, cls: string): string {
  const classes = cls.trim().split(/\s+/).filter(Boolean);
  return classes.length > 0 ? `${tag}.${classes.join('.')}` : tag;
}

function RowLabel({ node, showTagIcons }: { node: ElementTreeNode; showTagIcons: boolean }) {
  const firstClass = node.cls.split(/\s+/)[0] ?? '';
  const elementIcon = showTagIcons ? getElementIcon(node.tag) : undefined;
  return (
    <>
      {elementIcon ? (
        <span className="ss-tree-tag-icon" title={`<${node.tag}>`}>
          {elementIcon}
        </span>
      ) : (
        <span className="ss-tree-tag">{node.tag}</span>
      )}
      {elementIcon && !firstClass && <span className="ss-tree-tag">{node.tag}</span>}
      {firstClass && <span className="ss-tree-class">.{firstClass}</span>}
      {node.text && <span className="ss-tree-text">{node.text}</span>}
    </>
  );
}

function selectorForNode(node: ElementTreeNode): string {
  return `${node.tag}${node.cls
    .split(/\s+/)
    .filter(Boolean)
    .map((className) => `.${className}`)
    .join('')}`;
}

export function treePlacementForTarget(
  target: DragSortCollisionTarget,
  point: DragSortPoint,
  axis: 'vertical' | 'horizontal'
): DragSortPlacement {
  const coordinate = axis === 'horizontal' ? point.x : point.y;
  const start = axis === 'horizontal' ? target.rect.left : target.rect.top;
  const size = axis === 'horizontal' ? target.rect.width : target.rect.height;
  const ratio = size > 0 ? (coordinate - start) / size : 0.5;
  if (ratio < TREE_INSIDE_ZONE_START) return 'before';
  if (ratio > TREE_INSIDE_ZONE_END) return 'after';
  return 'inside';
}

function TreeSortableRows({
  root,
  rows,
  isExpanded,
  renderRow,
  onDragActiveChange,
}: {
  root: ElementTreeNode;
  rows: readonly ElementTreeRow[];
  isExpanded: (id: number, depth: number) => boolean;
  renderRow: (
    row: ElementTreeRow,
    projectedDepth: number,
    activeDragId: number | null
  ) => ReactNode;
  onDragActiveChange: (id: number | null) => void;
}) {
  const { manager } = useDragSortContext();
  const snapshot = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot
  );
  const activeDragId =
    snapshot.phase !== 'idle' && snapshot.phase !== 'pending' && snapshot.activeId !== null
      ? Number(snapshot.activeId)
      : null;
  // Parent expansion is a presentation detail of the Elements tree. Derive
  // the active row from the manager's dragging phase so a pointer-down that
  // never crosses the activation threshold behaves like an ordinary click.
  // Keep the state in the panel as well so optimistic drop rows remain
  // collapsed until the manager has finished settling and returned to idle.
  useLayoutEffect(() => {
    const activeNode = activeDragId === null ? null : findTreeNode(root, activeDragId);
    onDragActiveChange(activeNode?.children.length ? activeDragId : null);
  }, [activeDragId, onDragActiveChange, root]);

  const dragIsExpanded = useCallback(
    (id: number, depth: number) => id !== activeDragId && isExpanded(id, depth),
    [activeDragId, isExpanded]
  );
  const descendantIds = useMemo(() => {
    if (activeDragId === null) return null;
    const ids = new Set<number>();
    const activeNode = findTreeNode(root, activeDragId);
    const collect = (node: ElementTreeNode) => {
      node.children.forEach((child) => {
        ids.add(child.id);
        collect(child);
      });
    };
    if (activeNode) collect(activeNode);
    return ids;
  }, [activeDragId, root]);
  const renderedRows = useMemo(
    () => (descendantIds ? rows.filter((row) => !descendantIds.has(row.node.id)) : rows),
    [descendantIds, rows]
  );
  const visibleIds = useMemo(() => new Set(renderedRows.map((row) => row.node.id)), [renderedRows]);
  // Once the active parent has been removed from the rendered row set, refresh
  // the manager's captured geometry. This keeps projected positions atomic
  // with the collapsed subtree instead of retaining stale child rectangles.
  useLayoutEffect(() => {
    if (activeDragId !== null) manager.remeasure();
  }, [activeDragId, manager, renderedRows.length]);
  const projection = useMemo(() => {
    if (
      (snapshot.phase !== 'dragging' && snapshot.phase !== 'dropping') ||
      snapshot.activeId === null ||
      snapshot.targetId === null ||
      snapshot.placement === null ||
      snapshot.invalidReason !== null
    ) {
      return null;
    }
    if (
      snapshot.input === 'pointer' &&
      snapshot.placement === 'inside' &&
      (snapshot.insideHold === 'pending' || snapshot.insideHold === 'flashing')
    ) {
      return null;
    }
    return projectElementTree(
      root,
      Number(snapshot.activeId),
      Number(snapshot.targetId),
      snapshot.placement,
      dragIsExpanded,
      visibleIds
    );
  }, [dragIsExpanded, root, snapshot, visibleIds]);
  const depthById = useMemo(() => {
    const depths = new Map(renderedRows.map((row) => [row.node.id, row.depth]));
    projection?.rows.forEach((row) => depths.set(row.node.id, row.depth));
    return depths;
  }, [projection, renderedRows]);

  // Keep the source DOM order stable. DragSortManager owns the translated
  // positions; changing this order as the pointer moves would apply the
  // projection twice and make the list jump.
  return (
    <>
      {renderedRows.map((row) =>
        renderRow(row, depthById.get(row.node.id) ?? row.depth, activeDragId)
      )}
    </>
  );
}

function findTreeNode(root: ElementTreeNode, id: number): ElementTreeNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findTreeNode(child, id);
    if (found) return found;
  }
  return null;
}

export function ElementTreePanel({
  tree,
  truncated,
  selectedId,
  hoveredId = null,
  affectedIds = [],
  onSelect,
  onHover,
  projectPath,
  selectedSignature,
  onViewChange,
  structure,
  panelRef,
  pinned = true,
  onTogglePin,
  onClose,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [collapsedDragId, setCollapsedDragId] = useState<number | null>(null);
  const [pendingRows, setPendingRows] = useState<{
    tree: ElementTreeNode;
    rows: readonly ElementTreeRow[];
  } | null>(null);
  const [view, setView] = useState<'visual' | 'code'>('visual');
  const {
    showTagIcons,
    toggleShowTagIcons,
    showTagSansSerif,
    toggleShowTagSansSerif,
    showTagColors,
    toggleShowTagColors,
  } = useElementDisplayPreferences();
  // The insert palette is anchored to the most recent context-menu gesture.
  // The primitive owns menu state; this ref only bridges the menu item to the
  // existing InsertMenu, which opens after the context menu closes.
  const contextTargetRef = useRef<{
    nodeId: number;
    tag: string;
    cls: string;
    x: number;
    y: number;
  } | null>(null);
  const { showToast } = useOptionalToast();
  // Name the reason a copy failed, like the other clipboard call sites — a bare
  // "Could not copy" told neither the user nor the report why (issue #1049).
  const { copy: copySelector } = useCopyToClipboard({
    onCopy: () => showToast('Selector copied', 'success'),
    onError: (err) =>
      showToast(`Could not copy the selector (${describeClipboardError(err)})`, 'error'),
  });
  const [insertFor, setInsertFor] = useState<{
    nodeId: number;
    tag: string;
    anchor: { left: number; top: number; bottom: number };
  } | null>(null);
  const notifyCopy = useCallback(
    () => showToast('Element id copied — paste it to your agent', 'success'),
    [showToast]
  );
  const { copy: copyElementId, isCopied: elementIdCopied } = useCopyToClipboard({
    onCopy: notifyCopy,
    onError: (err) =>
      showToast(`Could not copy the element id (${describeClipboardError(err)})`, 'error'),
  });
  const selectView = (next: 'visual' | 'code') => {
    setView(next);
    onViewChange?.(next);
  };
  const bodyRef = useRef<HTMLDivElement>(null);
  const visibleView = structure ? view : 'visual';
  const affectedSet = useMemo(() => new Set(affectedIds), [affectedIds]);

  const ancestors = useMemo(() => (tree ? buildAncestors(tree) : null), [tree]);
  useCommands(() => {
    if (!structure || !tree || selectedId === null || !structure.move) return [];
    const siblingState = findSiblings(tree, selectedId);
    if (!siblingState) return [];
    const { siblings, index } = siblingState;
    const move = (destination: ElementTreeNode, position: InsertPosition) =>
      structure.move?.(selectedId, destination.id, position);
    return [
      {
        id: 'element.moveSelectedUp',
        title: 'Move selected element up',
        category: 'project' as const,
        keywords: ['element', 'move', 'up', 'reorder'],
        when: ({ kind }: PaletteCtx) => kind === 'project' && index > 0,
        run: () => {
          const destination = siblings[index - 1];
          if (destination) void move(destination, 'before');
        },
      },
      {
        id: 'element.moveSelectedDown',
        title: 'Move selected element down',
        category: 'project' as const,
        keywords: ['element', 'move', 'down', 'reorder'],
        when: ({ kind }: PaletteCtx) =>
          kind === 'project' && index >= 0 && index < siblings.length - 1,
        run: () => {
          const destination = siblings[index + 1];
          if (destination) void move(destination, 'after');
        },
      },
    ];
  }, [selectedId, structure, tree]);
  // Selecting on the canvas should reveal the row: expand its ancestor chain
  // (presence in `collapsed` is depth-inverted). Done as
  // a render-time state adjustment (the sanctioned "derive from prop change"
  // pattern) rather than an effect, so there's no cascading re-render.
  const [revealedFor, setRevealedFor] = useState<number | null>(null);
  if (selectedId !== revealedFor) {
    setRevealedFor(selectedId);
    const chain = selectedId != null ? ancestors?.get(selectedId) : undefined;
    if (chain) {
      let changed = false;
      const next = new Set(collapsed);
      chain.forEach((id, depth) => {
        const wantPresence = depth >= AUTO_EXPAND_DEPTH; // presence = expanded there
        if (wantPresence && !next.has(id)) {
          next.add(id);
          changed = true;
        } else if (!wantPresence && next.has(id)) {
          next.delete(id);
          changed = true;
        }
      });
      if (changed) setCollapsed(next);
    }
  }

  // Scroll the selected row into view once it exists in the DOM.
  useEffect(() => {
    if (selectedId == null) return;
    const raf = requestAnimationFrame(() => {
      bodyRef.current
        ?.querySelector(`[data-tree-id="${selectedId}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedId]);

  const toggle = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isExpanded = useCallback(
    (id: number, depth: number) =>
      id !== collapsedDragId &&
      (depth < AUTO_EXPAND_DEPTH ? !collapsed.has(id) : collapsed.has(id)),
    [collapsed, collapsedDragId]
  );
  const expandableElements = useMemo(() => (tree ? findExpandableElements(tree) : []), [tree]);
  const allElementsExpanded =
    expandableElements.length > 0 &&
    expandableElements.every(({ id, depth }) => isExpanded(id, depth));
  const hasExpandedCollapsibleElements = expandableElements.some(
    ({ id, depth, tag }) => tag.toLowerCase() !== 'body' && isExpanded(id, depth)
  );
  const setAllElementsExpanded = useCallback(
    (expanded: boolean) => {
      const next = new Set<number>();
      expandableElements.forEach(({ id, depth, tag }) => {
        const shouldExpand = expanded || tag.toLowerCase() === 'body';
        const defaultExpanded = depth < AUTO_EXPAND_DEPTH;
        if (shouldExpand ? !defaultExpanded : defaultExpanded) next.add(id);
      });
      setCollapsed(next);
    },
    [expandableElements]
  );
  const toggleAllElementsExpanded = useCallback(
    () => setAllElementsExpanded(!hasExpandedCollapsibleElements),
    [hasExpandedCollapsibleElements, setAllElementsExpanded]
  );
  useCommands(() => {
    if (!tree || expandableElements.length === 0) return [];
    return [
      {
        id: 'element.expandAll',
        title: 'Expand all elements',
        category: 'project' as const,
        keywords: ['element', 'tree', 'expand', 'open', 'all'],
        when: ({ kind }: PaletteCtx) => kind === 'project' && !allElementsExpanded,
        run: () => setAllElementsExpanded(true),
      },
      {
        id: 'element.collapseAll',
        title: 'Collapse all elements',
        category: 'project' as const,
        keywords: ['element', 'tree', 'collapse', 'close', 'all'],
        when: ({ kind }: PaletteCtx) => kind === 'project' && hasExpandedCollapsibleElements,
        run: () => setAllElementsExpanded(false),
      },
    ];
  }, [
    allElementsExpanded,
    expandableElements.length,
    hasExpandedCollapsibleElements,
    setAllElementsExpanded,
    tree,
  ]);
  const sourceVisibleRows = useMemo(
    () => (tree ? flattenElementTree(tree, isExpanded).rows : []),
    [isExpanded, tree]
  );
  if (pendingRows && pendingRows.tree !== tree) setPendingRows(null);
  const visibleRows = pendingRows?.tree === tree ? pendingRows.rows : sourceVisibleRows;
  const visibleOrder = useMemo(() => visibleRows.map((row) => row.node.id), [visibleRows]);
  const visibleIndex = useMemo(
    () => new Map(visibleOrder.map((id, index) => [id, index])),
    [visibleOrder]
  );
  const nodeById = useMemo(() => {
    const out = new Map<number, ElementTreeNode>();
    const walk = (node: ElementTreeNode) => {
      out.set(node.id, node);
      node.children.forEach(walk);
    };
    if (tree) walk(tree);
    return out;
  }, [tree]);
  const projectTreeOrder = useCallback(
    (
      order: readonly (string | number)[],
      activeId: string | number,
      targetId: string | number,
      placement: DragSortPlacement
    ) => {
      if (!tree) return [...order];
      const sourceIds = new Map(order.map((id) => [String(id), id]));
      const projection = projectElementTree(
        tree,
        Number(activeId),
        Number(targetId),
        placement,
        isExpanded,
        new Set(order.map(Number))
      );
      return projection.order.map((id) => sourceIds.get(String(id)) ?? id);
    },
    [isExpanded, tree]
  );
  const hasProjectedTreeMove = useCallback(
    (activeId: string | number, targetId: string | number, placement: DragSortPlacement) =>
      Boolean(
        tree &&
        projectElementTree(
          tree,
          Number(activeId),
          Number(targetId),
          placement,
          isExpanded,
          new Set(visibleOrder)
        ).changed
      ),
    [isExpanded, tree, visibleOrder]
  );
  const isPartOfActiveMove = useCallback(
    (activeId: string | number, itemId: string | number) => {
      const active = Number(activeId);
      const item = Number(itemId);
      if (active === item) return false;
      return ancestors?.get(item)?.includes(active) ?? false;
    },
    [ancestors]
  );
  const handleTreeMove = useCallback(
    (move: DragSortMove) => {
      const target = move.targetId;
      if (!tree || target === undefined || target === move.activeId || !structure?.move) return;
      const placement = (move.to.placement ?? 'after') as InsertPosition;
      const projection = projectElementTree(
        tree,
        Number(move.activeId),
        Number(target),
        placement,
        isExpanded,
        new Set(visibleOrder)
      );
      setPendingRows({ tree, rows: projection.rows });
      try {
        const result = structure.move(Number(move.activeId), Number(target), placement);
        return result instanceof Promise
          ? result.catch((error: unknown) => {
              setPendingRows(null);
              throw error;
            })
          : result;
      } catch (error) {
        setPendingRows(null);
        throw error;
      }
    },
    [isExpanded, structure, tree, visibleOrder]
  );
  const treeMoveBusy = structure?.busy ?? false;
  const canTreeMove = useCallback(
    (
      destination: { index: number; group: string | number; placement?: InsertPosition },
      context: { active: { id: string | number }; target?: { id: string | number } }
    ) => {
      const targetId = Number(context.target?.id);
      const activeId = Number(context.active.id);
      const target = nodeById.get(targetId);
      if (!target || targetId === activeId)
        return { allowed: false, reason: 'Choose another element.' };
      const activeNode = nodeById.get(activeId);
      if (!activeNode || STRUCTURAL_ELEMENTS.has(activeNode.tag)) {
        return { allowed: false, reason: `<${activeNode?.tag ?? 'element'}> cannot be moved.` };
      }
      if (ancestors?.get(targetId)?.includes(activeId)) {
        return { allowed: false, reason: 'An element cannot be moved into its own descendant.' };
      }
      if (destination.placement === 'inside' && VOID_ELEMENTS.has(target.tag)) {
        return { allowed: false, reason: `<${target.tag}> cannot contain children.` };
      }
      if (destination.placement !== 'inside' && STRUCTURAL_ELEMENTS.has(target.tag)) {
        return { allowed: false, reason: `Nothing can be placed beside <${target.tag}>.` };
      }
      if (treeMoveBusy) return { allowed: false, reason: 'Another element move is in progress.' };
      return { allowed: true as const };
    },
    [ancestors, nodeById, treeMoveBusy]
  );

  const renderReadOnlyNode = (node: ElementTreeNode, depth: number): ReactNode => {
    const hasChildren = node.children.length > 0;
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;
    const isAffected = !isSelected && affectedSet.has(node.id);
    // Collapsed = explicitly collapsed, or deep and never explicitly expanded.
    // The `collapsed` set tracks explicit toggles both ways via presence.
    const isCollapsed = hasChildren && !isExpanded(node.id, depth);
    const rowClassName = `ss-tree-row${isSelected ? ' selected' : ''}${
      isHovered ? ' hovered' : ''
    }${isAffected ? ' affected' : ''}`;
    return (
      <div key={node.id} className="ss-tree-node">
        <div
          className={rowClassName}
          style={{ '--element-tree-depth': depth } as CSSProperties}
          data-tree-id={node.id}
          onClick={() => onSelect(node.id)}
          onMouseEnter={() => onHover(node.id)}
          onMouseLeave={() => onHover(null)}
        >
          {hasChildren ? (
            <button
              type="button"
              className={`ss-tree-chevron${isCollapsed ? '' : ' open'}`}
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.id);
              }}
              aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            >
              <ChevronRightIcon size={10} />
            </button>
          ) : (
            <span className="ss-tree-chevron-spacer" />
          )}
          <RowLabel node={node} showTagIcons={showTagIcons} />
        </div>
        {hasChildren && !isCollapsed && node.children.map((c) => renderReadOnlyNode(c, depth + 1))}
      </div>
    );
  };

  const renderSortableRow = (row: ElementTreeRow, depth: number, activeDragId: number | null) => {
    const { node } = row;
    const hasChildren = node.children.length > 0;
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;
    const isAffected = !isSelected && affectedSet.has(node.id);
    const isCollapsed =
      hasChildren && (node.id === activeDragId || !isExpanded(node.id, row.depth));
    const clipboardSourceNodeId = structure?.clipboardSourceNodeId;
    const pasteDisabled =
      !structure?.hasClipboard ||
      VOID_ELEMENTS.has(node.tag) ||
      clipboardSourceNodeId === node.id ||
      (clipboardSourceNodeId != null && ancestors?.get(node.id)?.includes(clipboardSourceNodeId));
    const rowClassName = `ss-tree-row${isSelected ? ' selected' : ''}${
      isHovered ? ' hovered' : ''
    }${isAffected ? ' affected' : ''}`;
    const rowContent = (
      <ContextMenu>
        <ContextMenuTrigger
          asChild
          onContextMenu={(e) => {
            onSelect(node.id);
            contextTargetRef.current = {
              nodeId: node.id,
              tag: node.tag,
              cls: node.cls,
              x: e.clientX,
              y: e.clientY,
            };
          }}
        >
          <div
            className={rowClassName}
            data-tree-id={node.id}
            onClick={() => onSelect(node.id)}
            onMouseEnter={() => onHover(node.id)}
            onMouseLeave={() => onHover(null)}
          >
            {hasChildren ? (
              <button
                type="button"
                className={`ss-tree-chevron${isCollapsed ? '' : ' open'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(node.id);
                }}
                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
              >
                <ChevronRightIcon size={10} />
              </button>
            ) : (
              <span className="ss-tree-chevron-spacer" />
            )}
            <RowLabel node={node} showTagIcons={showTagIcons} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`Actions for ${node.tag}`}>
          <ContextMenuItem
            onSelect={() => {
              const target = contextTargetRef.current;
              if (!target || target.nodeId !== node.id) return;
              setInsertFor({
                nodeId: node.id,
                tag: node.tag,
                anchor: { left: target.x, top: target.y, bottom: target.y },
              });
            }}
          >
            <PlusIcon size={12} />
            <span>Insert element…</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyElementId(selectorForNode(node))}>
            {elementIdCopied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            <span>{elementIdCopied ? 'Copied' : 'Copy ID'}</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copySelector(elementSelector(node.tag, node.cls))}>
            <CopyIcon size={12} />
            <span>Copy selector</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => structure!.selectAndRun(node.id, structure!.duplicate)}>
            <DuplicateIcon size={12} />
            <span>Duplicate</span>
            <ContextMenuShortcut>{kbd('mod', 'D')}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => structure!.selectAndRun(node.id, structure!.cut)}>
            <CutIcon size={12} />
            <span>Cut</span>
            <ContextMenuShortcut>{kbd('mod', 'X')}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => structure!.selectAndRun(node.id, structure!.copy)}>
            <CopyIcon size={12} />
            <span>Copy</span>
            <ContextMenuShortcut>{kbd('mod', 'C')}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={pasteDisabled}
            onSelect={() => structure!.selectAndRun(node.id, structure!.paste)}
          >
            <PasteIcon size={12} />
            <span>Paste</span>
            <ContextMenuShortcut>{kbd('mod', 'V')}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => structure!.selectAndRun(node.id, structure!.remove)}
          >
            <TrashIcon size={12} />
            <span>Delete</span>
            <ContextMenuShortcut>{kbd('⌫')}</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
    return (
      <DragSortItem
        key={node.id}
        id={node.id}
        group="elements"
        index={visibleIndex.get(node.id) ?? 0}
        label={`${node.tag} element`}
        activation="item"
        disabled={STRUCTURAL_ELEMENTS.has(node.tag)}
        showTargetIndicator
        style={
          {
            '--drag-sort-tree-depth': depth,
            '--element-tree-depth': depth,
          } as CSSProperties
        }
      >
        {rowContent}
      </DragSortItem>
    );
  };

  const sigKey = selectedSignature
    ? `${selectedSignature.tagName}|${selectedSignature.className}|${(selectedSignature.text ?? '').slice(0, 60)}`
    : '';

  const tagToggle = (
    <ToggleButton
      variant="ghost"
      size="compact"
      className="button--icon-only ss-tree-panel__preference-toggle"
      onClick={toggleShowTagIcons}
      data-tooltip-content={showTagIcons ? 'Use tag names' : 'Use tag icons'}
      aria-label={showTagIcons ? 'Use tag names' : 'Use tag icons'}
      pressed={showTagIcons}
      leftIcon={<TagIconsIcon size={14} />}
    />
  );
  const fontToggle = (
    <ToggleButton
      variant="ghost"
      size="compact"
      className="button--icon-only ss-tree-panel__preference-toggle"
      onClick={toggleShowTagSansSerif}
      data-tooltip-content={showTagSansSerif ? 'Mono font on' : 'Mono font off'}
      aria-label={showTagSansSerif ? 'Mono font on' : 'Mono font off'}
      pressed={!showTagSansSerif}
      leftIcon={<FontIcon size={14} />}
    />
  );
  const colorToggle = (
    <ToggleButton
      variant="ghost"
      size="compact"
      className="button--icon-only ss-tree-panel__preference-toggle"
      onClick={toggleShowTagColors}
      data-tooltip-content={showTagColors ? 'Use shades of grey' : 'Use color-coding'}
      aria-label={showTagColors ? 'Use shades of grey' : 'Use color-coding'}
      pressed={showTagColors}
      leftIcon={<ContrastIcon size={14} />}
    />
  );
  const treeExpansionLabel = hasExpandedCollapsibleElements
    ? 'Collapse all elements'
    : 'Expand all elements';
  const treeExpansionToggle = (
    <IconButton
      variant="ghost"
      size="compact"
      className="ss-tree-panel__preference-toggle ss-tree-panel__tree-expansion-toggle"
      onClick={toggleAllElementsExpanded}
      data-tooltip-content={treeExpansionLabel}
      aria-label={treeExpansionLabel}
      disabled={
        expandableElements.length === 0 || (allElementsExpanded && !hasExpandedCollapsibleElements)
      }
      icon={
        hasExpandedCollapsibleElements ? (
          <ContractVerticalIcon size={14} />
        ) : (
          <ExpandVerticalIcon size={14} />
        )
      }
    />
  );
  const panelControls = (
    <div className="ss-tree-panel__controls">
      <div className="ss-tree-panel__controls-start">
        <div
          className="ss-tree-panel__preference-group"
          role="group"
          aria-label="Element display preferences"
        >
          {tagToggle}
          {fontToggle}
          {colorToggle}
        </div>
        {!structure && (
          <Tooltip content="Turn on edit mode to select and edit elements.">
            <span className="ss-tree-panel__view-only">View only</span>
          </Tooltip>
        )}
      </div>
      <div
        className="ss-tree-panel__preference-group"
        role="group"
        aria-label="Element tree expansion"
      >
        {treeExpansionToggle}
      </div>
    </div>
  );
  const panelClassName = `ss-tree-panel${structure ? '' : ' ss-tree-panel--view-only'}${
    showTagSansSerif ? ' ss-tree-panel--sans-serif' : ''
  }${showTagColors ? '' : ' ss-tree-panel--monochrome'}`;

  return (
    <div ref={panelRef} className={panelClassName} data-testid="element-tree-panel">
      {structure ? (
        <Tabs value={visibleView} onValueChange={(next) => selectView(next as 'visual' | 'code')}>
          <div className="ss-tree-panel__header" data-dockable-drag-handle>
            <span className="ss-tree-panel__title workspace-panel-title">Elements</span>
            <TabsList className="ss-tree-panel__modes" aria-label="Elements view">
              <TabsTab value="visual">Visual</TabsTab>
              <TabsTab value="code">Code</TabsTab>
            </TabsList>
            {onTogglePin && (
              <ToggleButton
                variant="ghost"
                size="compact"
                className="button--icon-only panel-pin-toggle"
                onClick={onTogglePin}
                title={pinned ? 'Unpin — float over the workspace' : 'Pin to the window'}
                aria-label={pinned ? 'Unpin Elements panel' : 'Pin Elements panel to the window'}
                pressed={pinned}
                leftIcon={<PinIcon size={13} />}
              />
            )}
            {onClose && (
              <IconButton
                variant="ghost"
                size="compact"
                onClick={onClose}
                title="Close Elements panel"
                aria-label="Close Elements panel"
                icon={<CloseIcon size={14} />}
              />
            )}
          </div>
          {panelControls}
          <TabsPanel value={visibleView} className="ss-tree-panel__active-view">
            {visibleView === 'visual' ? (
              <div className="ss-tree-panel__body" ref={bodyRef} onMouseLeave={() => onHover(null)}>
                {tree ? (
                  <DragSortScope
                    label="Elements"
                    collision="containment"
                    canMove={canTreeMove}
                    onMove={handleTreeMove}
                    placementForTarget={treePlacementForTarget}
                    insideHoldDelayMs={TREE_INSIDE_HOLD_DELAY_MS}
                    insideHoldFlashDurationMs={TREE_INSIDE_HOLD_FLASH_DURATION_MS}
                    projectOrder={projectTreeOrder}
                    hasProjectedMove={hasProjectedTreeMove}
                    isPartOfActiveMove={isPartOfActiveMove}
                  >
                    <TreeSortableRows
                      root={tree}
                      rows={visibleRows}
                      isExpanded={isExpanded}
                      renderRow={renderSortableRow}
                      onDragActiveChange={setCollapsedDragId}
                    />
                  </DragSortScope>
                ) : (
                  <div className="ss-tree-panel__empty">Loading elements…</div>
                )}
                {truncated && (
                  <div className="ss-tree-panel__note">
                    Large page — showing the first part of the tree.
                  </div>
                )}
              </div>
            ) : (
              <div className="ss-tree-panel__body ss-tree-panel__body--code">
                {selectedSignature ? (
                  <ElementHtmlEditor
                    key={sigKey}
                    projectPath={projectPath}
                    signature={selectedSignature}
                  />
                ) : (
                  <div className="ss-tree-panel__empty">Select an element to edit its HTML.</div>
                )}
              </div>
            )}
          </TabsPanel>
          <TabsPanel
            value={visibleView === 'visual' ? 'code' : 'visual'}
            className="ss-tree-panel__active-view"
          />
        </Tabs>
      ) : (
        <>
          <div className="ss-tree-panel__header" data-dockable-drag-handle>
            <span className="ss-tree-panel__title workspace-panel-title">Elements</span>
            {onTogglePin && (
              <ToggleButton
                variant="ghost"
                size="compact"
                className="button--icon-only panel-pin-toggle"
                onClick={onTogglePin}
                title={pinned ? 'Unpin — float over the workspace' : 'Pin to the window'}
                aria-label={pinned ? 'Unpin Elements panel' : 'Pin Elements panel to the window'}
                pressed={pinned}
                leftIcon={<PinIcon size={13} />}
              />
            )}
            {onClose && (
              <IconButton
                variant="ghost"
                size="compact"
                onClick={onClose}
                title="Close Elements panel"
                aria-label="Close Elements panel"
                icon={<CloseIcon size={14} />}
              />
            )}
          </div>
          {panelControls}
          <div className="ss-tree-panel__body" ref={bodyRef} onMouseLeave={() => onHover(null)}>
            {tree ? (
              renderReadOnlyNode(tree, 0)
            ) : (
              <div className="ss-tree-panel__empty">Loading elements…</div>
            )}
            {truncated && (
              <div className="ss-tree-panel__note">
                Large page — showing the first part of the tree.
              </div>
            )}
          </div>
        </>
      )}
      {structure && (
        <>
          <InsertMenu
            anchor={insertFor?.anchor ?? null}
            insideDisabled={insertFor ? VOID_ELEMENTS.has(insertFor.tag) : false}
            outsideDisabled={insertFor ? STRUCTURAL_ELEMENTS.has(insertFor.tag) : false}
            onInsert={(position, kind) => {
              if (!insertFor) return;
              structure.selectAndRun(insertFor.nodeId, () => structure.insert(position, kind));
            }}
            onClose={() => setInsertFor(null)}
          />
        </>
      )}
    </div>
  );
}
