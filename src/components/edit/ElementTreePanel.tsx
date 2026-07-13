/**
 * Element tree panel — a read-only, Webflow-style navigator for the preview.
 *
 * Shows the rendered DOM as a collapsible tree; clicking a row selects the
 * element through the same path as clicking it on the canvas, so the visual
 * editor panel picks it up. No editing or renaming here by design.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRightIcon, SearchIcon } from '../icons';
import { ElementHtmlEditor } from './ElementHtmlEditor';
import type { ElementTreeNode } from '../../hooks/useElementTree';
import { filterElementTree, isTreeQueryActive } from '../../lib/elementTreeFilter';
import type { ElementSignature } from '../../lib/edit';
import { useCommands } from '../../commands/useCommands';

interface Props {
  tree: ElementTreeNode | null;
  truncated: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
  /** The currently-selected element (for the Code/HTML view). */
  projectPath: string;
  selectedSignature: ElementSignature | null;
  /** Notified when the Visual/Code view toggles, so the parent can widen the
   *  panel for editing markup. */
  onViewChange?: (view: 'visual' | 'code') => void;
}

/** Rows at depth < this start expanded so the tree isn't a single chevron. */
const AUTO_EXPAND_DEPTH = 3;

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

/** One tree row's label: the element's tag, its first class, and any text snippet. */
function RowLabel({ node }: { node: ElementTreeNode }) {
  const firstClass = node.cls.split(/\s+/)[0] ?? '';
  return (
    <>
      <span className="ss-tree-tag">{node.tag}</span>
      {firstClass && <span className="ss-tree-class">.{firstClass}</span>}
      {node.text && <span className="ss-tree-text">{node.text}</span>}
    </>
  );
}

/**
 * The visual editor's element-tree panel: a searchable, keyboard-navigable tree
 * of the previewed page's elements with a Visual/Code view toggle. Typing in the
 * search box filters to matching nodes plus their ancestor path; Arrow
 * Up/Down/Left/Right move the selection across siblings, to the parent, and into
 * the first child.
 */
export function ElementTreePanel({
  tree,
  truncated,
  selectedId,
  onSelect,
  onHover,
  projectPath,
  selectedSignature,
  onViewChange,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'visual' | 'code'>('visual');
  const selectView = (next: 'visual' | 'code') => {
    setView(next);
    onViewChange?.(next);
  };
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useCommands(
    () => [
      {
        id: 'elementTree.focusSearch',
        title: 'Search elements',
        icon: <SearchIcon size={14} />,
        category: 'action',
        when: 'project',
        keywords: ['find', 'filter', 'tree', 'element', 'search'],
        run: () => {
          if (view !== 'visual') {
            setView('visual');
            onViewChange?.('visual');
          }
          requestAnimationFrame(() => searchRef.current?.focus());
        },
      },
    ],
    [view, onViewChange]
  );

  // When a query is active, render a pruned copy of the tree (matches plus their
  // ancestor paths) via the borrowed Meno filter; a blank query is identity, so
  // selection, reveal, and keyboard nav are unchanged in the common case.
  const filtering = isTreeQueryActive(query);
  const displayTree = useMemo(() => filterElementTree(tree, query), [tree, query]);

  // Built from the FULL tree (not displayTree) so a canvas selection the active
  // query prunes out still has its ancestor chain available to reveal; otherwise
  // ancestors.get(selectedId) is undefined for the filtered-out node and the
  // reveal state goes stale once the query clears.
  const ancestors = useMemo(() => (tree ? buildAncestors(tree) : null), [tree]);

  // Flat lookups for keyboard navigation: each node by id, and each node's
  // parent id (null for the root). Built from the displayed (possibly filtered)
  // tree so arrow nav stays consistent with what's on screen.
  const navIndex = useMemo(() => {
    const nodeById = new Map<number, ElementTreeNode>();
    const parentById = new Map<number, number | null>();
    if (displayTree) {
      const walk = (node: ElementTreeNode, parent: number | null) => {
        nodeById.set(node.id, node);
        parentById.set(node.id, parent);
        for (const child of node.children) walk(child, node.id);
      };
      walk(displayTree, null);
    }
    return { nodeById, parentById };
  }, [displayTree]);

  // Selecting on the canvas should reveal the row: expand its ancestor chain
  // (presence in `collapsed` is depth-inverted — see collapsedState). Done as
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

  // Arrow-key navigation from the selected element: Up/Down move between
  // siblings (no wrap), Left selects the parent, Right dives into the first
  // child. `onSelect` runs the same path as a click, so the canvas + edit panel
  // follow and the target row auto-reveals + scrolls into view. The listener is
  // document-level (the tree rows aren't focusable), but it never steals arrows
  // from a focused text field or arrow-driven control in the edit panel.
  useEffect(() => {
    const NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    const onKeyDown = (e: KeyboardEvent) => {
      if (selectedId == null || !NAV_KEYS.includes(e.key)) return;

      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (el instanceof HTMLElement && el.isContentEditable) return;
      const role = el?.getAttribute('role');
      if (
        role &&
        ['combobox', 'listbox', 'menu', 'menuitem', 'slider', 'spinbutton', 'textbox'].includes(
          role
        )
      ) {
        return;
      }

      // While filtering, the selected element may have been pruned out of the
      // visible tree (selection comes from the canvas/iframe, independent of the
      // query). Nav would otherwise be dead, so re-enter the filtered view at
      // its root and let the user navigate the matches from there.
      if (filtering && !navIndex.nodeById.has(selectedId)) {
        if (displayTree) {
          e.preventDefault();
          onSelect(displayTree.id);
        }
        return;
      }

      const parentId = navIndex.parentById.get(selectedId) ?? null;

      if (e.key === 'ArrowRight') {
        const first = navIndex.nodeById.get(selectedId)?.children[0];
        if (first) {
          e.preventDefault();
          onSelect(first.id);
        }
        return;
      }
      if (e.key === 'ArrowLeft') {
        if (parentId != null) {
          e.preventDefault();
          onSelect(parentId);
        }
        return;
      }

      // Up/Down: previous/next sibling. Root has no siblings; ends don't wrap.
      if (parentId == null) return;
      const siblings = navIndex.nodeById.get(parentId)?.children ?? [];
      const idx = siblings.findIndex((s) => s.id === selectedId);
      if (idx === -1) return;
      const target = siblings[e.key === 'ArrowUp' ? idx - 1 : idx + 1];
      if (target) {
        e.preventDefault();
        onSelect(target.id);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedId, navIndex, onSelect, displayTree, filtering]);

  const toggle = (id: number) => {
    // During search the tree is force-expanded (see collapsedState), so a chevron
    // click would mutate `collapsed` invisibly and surface as stale state once the
    // query clears. Ignore toggles while filtering.
    if (filtering) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Presence in `collapsed` flips the depth-based default: shallow nodes
  // default open (presence = collapsed), deep nodes default closed
  // (presence = expanded).
  const collapsedState = (id: number, depth: number) => {
    if (filtering) return false; // a filtered view stays fully expanded so every match shows
    return depth < AUTO_EXPAND_DEPTH ? collapsed.has(id) : !collapsed.has(id);
  };

  const renderNode = (node: ElementTreeNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    // Collapsed = explicitly collapsed, or deep and never explicitly expanded.
    // The `collapsed` set tracks explicit toggles both ways via presence.
    const isCollapsed = hasChildren && collapsedState(node.id, depth);
    return (
      <div key={node.id}>
        <div
          className={`ss-tree-row${node.id === selectedId ? ' selected' : ''}`}
          style={{ paddingLeft: depth * 14 + 6 }}
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
              title={isCollapsed ? 'Expand' : 'Collapse'}
              aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            >
              <ChevronRightIcon size={10} />
            </button>
          ) : (
            <span className="ss-tree-chevron-spacer" />
          )}
          <RowLabel node={node} />
        </div>
        {hasChildren && !isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  const sigKey = selectedSignature
    ? `${selectedSignature.tagName}|${selectedSignature.className}|${(selectedSignature.text ?? '').slice(0, 60)}`
    : '';

  return (
    <div className="ss-tree-panel" data-testid="element-tree-panel">
      <div className="ss-tree-panel__header">
        <span className="ss-tree-panel__title">Elements</span>
        {view === 'visual' && (
          <input
            ref={searchRef}
            type="search"
            className="ss-tree-panel__search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search elements"
          />
        )}
        <div className="ss-tree-panel__modes" role="group" aria-label="Elements view">
          <button
            type="button"
            className={`ss-tree-panel__mode${view === 'visual' ? ' is-active' : ''}`}
            aria-pressed={view === 'visual'}
            onClick={() => selectView('visual')}
          >
            Visual
          </button>
          <button
            type="button"
            className={`ss-tree-panel__mode${view === 'code' ? ' is-active' : ''}`}
            aria-pressed={view === 'code'}
            onClick={() => selectView('code')}
          >
            Code
          </button>
        </div>
      </div>
      {view === 'visual' ? (
        <div className="ss-tree-panel__body" ref={bodyRef} onMouseLeave={() => onHover(null)}>
          {!tree && <div className="ss-tree-panel__empty">Loading elements…</div>}
          {tree && displayTree && renderNode(displayTree, 0)}
          {tree && !displayTree && (
            <div className="ss-tree-panel__empty">
              {truncated
                ? 'No matches in the loaded part of this large page.'
                : 'No matching elements'}
            </div>
          )}
          {truncated && displayTree && (
            <div className="ss-tree-panel__note">
              {filtering
                ? 'Large page — searched only the first part; some matches may be hidden.'
                : 'Large page — showing the first part of the tree.'}
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
    </div>
  );
}
