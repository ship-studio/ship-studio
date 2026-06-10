/**
 * Element tree panel — a read-only, Webflow-style navigator for the preview.
 *
 * Shows the rendered DOM as a collapsible tree; clicking a row selects the
 * element through the same path as clicking it on the canvas, so the visual
 * editor panel picks it up. No editing or renaming here by design.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRightIcon } from '../icons';
import type { ElementTreeNode } from '../../hooks/useElementTree';

interface Props {
  tree: ElementTreeNode | null;
  truncated: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
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

export function ElementTreePanel({ tree, truncated, selectedId, onSelect, onHover }: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
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

  return (
    <div className="ss-tree-panel" data-testid="element-tree-panel">
      <div className="ss-tree-panel__header">
        <span className="ss-tree-panel__title">Elements</span>
      </div>
      <div className="ss-tree-panel__body" ref={bodyRef} onMouseLeave={() => onHover(null)}>
        {tree ? renderNode(tree, 0) : <div className="ss-tree-panel__empty">Loading elements…</div>}
        {truncated && (
          <div className="ss-tree-panel__note">
            Large page — showing the first part of the tree.
          </div>
        )}
      </div>
    </div>
  );
}
