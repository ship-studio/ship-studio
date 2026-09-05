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
import { usePolling } from './usePolling';

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
  const [affectedIds, setAffectedIds] = useState<number[]>([]);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  /** A request is out and the iframe hasn't answered with a snapshot yet. */
  const [awaitingTree, setAwaitingTree] = useState(enabled);
  // Re-opening the navigator always refetches — the page has moved on since the
  // snapshot we're holding. Adjusted during render rather than in an effect so the
  // first request goes out in the same commit the panel becomes visible.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (enabled) {
      setAwaitingTree(true);
      setHoveredId(null);
    }
  }

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  /** Ask for a snapshot: the poll below owns the actual posting, so a request that
   *  goes unanswered is retried on one schedule instead of several. */
  const requestTree = useCallback(() => setAwaitingTree(true), []);

  // The injected script may not be listening yet (first paint, a full HMR reload),
  // so a request can land before anyone can answer it. Retry until a snapshot
  // arrives — every unanswered attempt backs the interval off (0.5s → 4s) instead
  // of hammering the iframe at a fixed 500ms for as long as the panel is open.
  usePolling(
    () => {
      post({ type: 'ss:requestTree' });
      // Rejecting is what drives the backoff: the request is only "answered" by an
      // `ss:tree` message, which stops the poll by clearing `awaitingTree`.
      return Promise.reject(new Error('No element tree snapshot yet'));
    },
    {
      intervalMs: 500,
      maxIntervalMs: 4000,
      enabled: enabled && awaitingTree,
      name: 'elementTree',
    }
  );

  useEffect(() => {
    if (!enabled) return;

    const onMessage = (e: MessageEvent) => {
      // SECURITY: only trust messages from the actual preview iframe (untrusted
      // project content runs inside it).
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as
        | {
            type?: string;
            tree?: WireNode;
            truncated?: boolean;
            nodeId?: number | null;
            affectedNodeIds?: number[];
          }
        | undefined;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'ss:tree' && d.tree) {
        setAwaitingTree(false);
        setTree(mapNode(d.tree));
        setTruncated(!!d.truncated);
      } else if (d.type === 'ss:treeDirty') {
        requestTree();
      } else if (d.type === 'ss:hover') {
        setHoveredId(typeof d.nodeId === 'number' ? d.nodeId : null);
      } else if (d.type === 'ss:select') {
        setSelectedId(typeof d.nodeId === 'number' ? d.nodeId : null);
        setAffectedIds(
          Array.isArray(d.affectedNodeIds)
            ? d.affectedNodeIds.filter((id): id is number => typeof id === 'number')
            : []
        );
      }
    };
    window.addEventListener('message', onMessage);

    // A full page reload re-initializes the injected script (treeOn resets),
    // so re-request on iframe load to keep the navigator alive across HMR
    // full-reloads and manual refreshes.
    const iframe = iframeRef.current;
    const onLoad = () => {
      setHoveredId(null);
      requestTree();
    };
    iframe?.addEventListener('load', onLoad);

    return () => {
      post({ type: 'ss:treeOff' });
      window.removeEventListener('message', onMessage);
      iframe?.removeEventListener('load', onLoad);
    };
  }, [enabled, post, requestTree, iframeRef]);

  const selectNode = useCallback((id: number) => post({ type: 'ss:selectNode', id }), [post]);
  const hoverNode = useCallback(
    (id: number | null) => {
      // The pointer is over the Elements pane, so a previous page-side hover is
      // no longer the active visual target.
      setHoveredId(null);
      post({ type: 'ss:hoverNode', id });
    },
    [post]
  );

  // Stale data is kept while disabled (cheap) but never exposed.
  return {
    tree: enabled ? tree : null,
    truncated,
    selectedId: enabled ? selectedId : null,
    affectedIds: enabled ? affectedIds : [],
    hoveredId: enabled ? hoveredId : null,
    selectNode,
    hoverNode,
  };
}
