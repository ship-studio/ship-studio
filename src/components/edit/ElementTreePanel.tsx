/**
 * Element tree panel — a Webflow-style navigator for the preview.
 *
 * Shows the rendered DOM as a collapsible tree; clicking a row selects the
 * element through the same path as clicking it on the canvas, so the visual
 * editor panel picks it up. Structural edits (insert / duplicate / delete)
 * live in the row context menu; each action selects its row first
 * (`selectAndRun`) so it operates on the element the user aimed at.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRightIcon } from '../icons';
import { ElementHtmlEditor } from './ElementHtmlEditor';
import { ElementTreeContextMenu } from './ElementTreeContextMenu';
import { InsertMenu } from './InsertMenu';
import type { ElementTreeNode } from '../../hooks/useElementTree';
import type { ElementSignature } from '../../lib/edit';
import {
  STRUCTURAL_ELEMENTS,
  VOID_ELEMENTS,
  type ElementKind,
  type InsertPosition,
} from '../../lib/edit-structure';

/** The structural-edit actions the panel's context menu drives
 *  (from `useElementStructure`). */
export interface TreeStructureActions {
  selectAndRun: (nodeId: number, action: () => void) => void;
  insert: (position: InsertPosition, kind: ElementKind) => void;
  duplicate: () => void;
  remove: () => void;
}

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
  /** When provided, rows get an insert/duplicate/delete context menu. */
  structure?: TreeStructureActions;
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

export function ElementTreePanel({
  tree,
  truncated,
  selectedId,
  onSelect,
  onHover,
  projectPath,
  selectedSignature,
  onViewChange,
  structure,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [view, setView] = useState<'visual' | 'code'>('visual');
  // Context menu + insert palette, both anchored to the right-clicked row.
  const [ctxMenu, setCtxMenu] = useState<{
    nodeId: number;
    tag: string;
    x: number;
    y: number;
  } | null>(null);
  const [insertFor, setInsertFor] = useState<{
    nodeId: number;
    tag: string;
    anchor: { left: number; top: number; bottom: number };
  } | null>(null);
  const selectView = (next: 'visual' | 'code') => {
    setView(next);
    onViewChange?.(next);
  };
  const bodyRef = useRef<HTMLDivElement>(null);

  const ancestors = useMemo(() => (tree ? buildAncestors(tree) : null), [tree]);

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

  const toggle = (id: number) => {
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
  const collapsedState = (id: number, depth: number) =>
    depth < AUTO_EXPAND_DEPTH ? collapsed.has(id) : !collapsed.has(id);

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
          onContextMenu={
            structure &&
            ((e) => {
              e.preventDefault();
              onSelect(node.id); // select first, so the canvas shows the target
              setCtxMenu({ nodeId: node.id, tag: node.tag, x: e.clientX, y: e.clientY });
            })
          }
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
          {tree ? (
            renderNode(tree, 0)
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
      {structure && (
        <>
          <ElementTreeContextMenu
            pos={ctxMenu ? { x: ctxMenu.x, y: ctxMenu.y } : null}
            onInsert={() => {
              if (!ctxMenu) return;
              setInsertFor({
                nodeId: ctxMenu.nodeId,
                tag: ctxMenu.tag,
                anchor: { left: ctxMenu.x, top: ctxMenu.y, bottom: ctxMenu.y },
              });
            }}
            onDuplicate={() => {
              if (ctxMenu) structure.selectAndRun(ctxMenu.nodeId, structure.duplicate);
            }}
            onDelete={() => {
              if (ctxMenu) structure.selectAndRun(ctxMenu.nodeId, structure.remove);
            }}
            onClose={() => setCtxMenu(null)}
          />
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
