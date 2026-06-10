/**
 * Element tree (read-only navigator) for the visual editor.
 *
 * Talks to the proxy-injected select script over the same postMessage
 * protocol the editor uses: requests a lightweight DOM snapshot
 * (`ss:requestTree` → `ss:tree`), refetches when the page mutates
 * (`ss:treeDirty`, debounced iframe-side), and selects/hovers elements by
 * ephemeral node id (`ss:selectNode` / `ss:hoverNode`). Selecting a node runs
 * the exact same selection path as clicking it on the canvas, so the edit
 * panel populates identically; canvas clicks carry a `nodeId` back so the
 * tree row highlights in sync.
 *
 * @module hooks/useElementTree
 */

import { useCallback, useEffect, useState, type RefObject } from 'react';

/** One element in the snapshot, mapped from the compact wire format. */
export interface ElementTreeNode {
  id: number;
  tag: string;
  /** The element's class attribute (truncated iframe-side). */
  cls: string;
  /** Direct text content snippet (children's text not included). */
  text: string;
  children: ElementTreeNode[];
}

interface WireNode {
  i: number;
  t: string;
  c: string;
  x: string;
  k: WireNode[];
}

function mapNode(n: WireNode): ElementTreeNode {
  return {
    id: n.i,
    tag: n.t,
    cls: n.c,
    text: n.x,
    children: (n.k ?? []).map(mapNode),
  };
}

interface UseElementTreeParams {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** Fetch + track the tree only while the navigator is visible. */
  enabled: boolean;
}

export function useElementTree({ iframeRef, enabled }: UseElementTreeParams) {
  const [tree, setTree] = useState<ElementTreeNode | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  useEffect(() => {
    if (!enabled) return;

    post({ type: 'ss:requestTree' });

    const onMessage = (e: MessageEvent) => {
      const d = e.data as
        | { type?: string; tree?: WireNode; truncated?: boolean; nodeId?: number }
        | undefined;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'ss:tree' && d.tree) {
        setTree(mapNode(d.tree));
        setTruncated(!!d.truncated);
      } else if (d.type === 'ss:treeDirty') {
        post({ type: 'ss:requestTree' });
      } else if (d.type === 'ss:select') {
        setSelectedId(typeof d.nodeId === 'number' ? d.nodeId : null);
      }
    };
    window.addEventListener('message', onMessage);

    // A full page reload re-initializes the injected script (treeOn resets),
    // so re-request on iframe load to keep the navigator alive across HMR
    // full-reloads and manual refreshes.
    const iframe = iframeRef.current;
    const onLoad = () => post({ type: 'ss:requestTree' });
    iframe?.addEventListener('load', onLoad);

    return () => {
      post({ type: 'ss:treeOff' });
      window.removeEventListener('message', onMessage);
      iframe?.removeEventListener('load', onLoad);
    };
  }, [enabled, post, iframeRef]);

  const selectNode = useCallback((id: number) => post({ type: 'ss:selectNode', id }), [post]);
  const hoverNode = useCallback((id: number | null) => post({ type: 'ss:hoverNode', id }), [post]);

  // Stale data is kept while disabled (cheap) but never exposed.
  return {
    tree: enabled ? tree : null,
    truncated,
    selectedId: enabled ? selectedId : null,
    selectNode,
    hoverNode,
  };
}
