/**
 * Branch graph visual.
 *
 * Branch names live in a left gutter (HTML, so they truncate cleanly at any
 * length); rails, fork elbows, and green "PR" markers are an SVG layer to the
 * right. Fork lineage comes from `get_branch_graph` (recorded at branch
 * creation, with a `git merge-base` fallback); PR arrows are overlaid from the
 * workspace-scoped open-PR list the workspace already holds.
 *
 * @module components/BranchGraph
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  BranchInfo,
  BranchGraphNode,
  PullRequestInfo,
  getBranchGraph,
  getDefaultBaseBranch,
  setDefaultBaseBranch,
} from '../../lib/branches';
import { Spinner } from '../primitives/Spinner';
import { ResetIcon } from '../icons';
import { logger } from '../../lib/logger';

interface BranchGraphProps {
  /** Project path for graph data */
  projectPath: string;
  /** Current branch list — drives a refetch when branches change */
  branches: BranchInfo[];
  /** Currently checked out branch */
  currentBranch: string;
  /** Open pull requests, used to draw PR arrows to their target branch */
  openPRs: PullRequestInfo[];
  /** Called when a branch in the graph is clicked (to switch to it) */
  onSelectBranch?: (name: string) => void;
  /** Refresh the branch list (e.g. after git changes made outside the app). */
  onRefresh?: () => void;
}

interface LaidBranch {
  node: BranchGraphNode;
  depth: number;
  row: number;
  pr: PullRequestInfo | null;
}

// Layout constants (pixel coordinates; the component is sized to its container).
const ROW_H = 46;
const TOP_PAD = 14;
const BOTTOM_PAD = 14;
const INDENT = 18; // graph-area node indent per fork depth
const GRAPH_LEFT_PAD = 16; // gap between the label gutter and the first node
const LABEL_PAD = 10; // gutter left padding
const LABEL_INDENT = 12; // gutter indent per depth (hierarchy hint)
const NODE_R = 5;
const CHIP_W = 32;
const CHIP_H = 18;
const CORNER = 8;
const MIN_WIDTH = 320;

/**
 * Order branches into rows (parents above their children, roots first) and
 * assign each a fork depth. Cycles/danglers are appended defensively at depth 0.
 */
function layoutBranches(nodes: BranchGraphNode[], openPRs: PullRequestInfo[]): LaidBranch[] {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const childrenOf = new Map<string, BranchGraphNode[]>();
  const roots: BranchGraphNode[] = [];

  for (const n of nodes) {
    const base = n.base && byName.has(n.base) && n.base !== n.name ? n.base : null;
    if (base) {
      const arr = childrenOf.get(base) ?? [];
      arr.push(n);
      childrenOf.set(base, arr);
    } else {
      roots.push(n);
    }
  }

  // Default/base branches first, then most-recently-committed.
  const sortFn = (a: BranchGraphNode, b: BranchGraphNode) =>
    Number(b.isDefault) - Number(a.isDefault) || b.lastCommitDate - a.lastCommitDate;
  roots.sort(sortFn);

  const prByHead = new Map<string, PullRequestInfo>();
  for (const pr of openPRs) {
    if (!prByHead.has(pr.headRef)) prByHead.set(pr.headRef, pr);
  }

  const laid: LaidBranch[] = [];
  const visited = new Set<string>();
  let row = 0;

  const walk = (n: BranchGraphNode, depth: number) => {
    if (visited.has(n.name)) return;
    visited.add(n.name);
    laid.push({ node: n, depth, row: row++, pr: prByHead.get(n.name) ?? null });
    const kids = (childrenOf.get(n.name) ?? []).slice().sort(sortFn);
    for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const n of nodes) {
    if (!visited.has(n.name)) {
      visited.add(n.name);
      laid.push({ node: n, depth: 0, row: row++, pr: prByHead.get(n.name) ?? null });
    }
  }

  return laid;
}

/** ahead/behind summary of a branch relative to its base. */
function metaFor(node: BranchGraphNode): string {
  if (node.isDefault) return 'base branch';
  if (!node.base) return '';
  if (node.ahead > 0 || node.behind > 0) {
    return `↑${node.ahead} ↓${node.behind} · from ${node.base}`;
  }
  return `up to date with ${node.base}`;
}

export function BranchGraph({
  projectPath,
  branches,
  currentBranch,
  openPRs,
  onSelectBranch,
  onRefresh,
}: BranchGraphProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [nodes, setNodes] = useState<BranchGraphNode[] | null>(null);
  const [defaultBase, setDefaultBase] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(MIN_WIDTH, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const load = useCallback(async () => {
    try {
      const [graph, base] = await Promise.all([
        getBranchGraph(projectPath),
        getDefaultBaseBranch(projectPath),
      ]);
      setNodes(graph);
      setDefaultBase(base);
    } catch (e) {
      logger.error('Failed to load branch graph', { error: e });
      setNodes([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  const branchesKey = useMemo(
    () => branches.map((b) => `${b.name}:${b.isCurrent ? 1 : 0}`).join('|'),
    [branches]
  );
  useEffect(() => {
    setLoading(true);
    void load();
  }, [load, branchesKey]);

  const handleDefaultBaseChange = async (value: string) => {
    const branch = value || null;
    setDefaultBase(branch);
    try {
      await setDefaultBaseBranch(projectPath, branch);
      await load();
    } catch (e) {
      logger.error('Failed to set default base branch', { error: e });
    }
  };

  // Manual refresh: re-fetch the graph and ask the parent to refresh the branch
  // list, so git changes made outside the app (e.g. in the agent terminal) show up.
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      onRefresh?.();
      await load();
    } finally {
      setIsRefreshing(false);
    }
  };

  const laid = useMemo(() => (nodes ? layoutBranches(nodes, openPRs) : []), [nodes, openPRs]);
  const laidByName = useMemo(() => new Map(laid.map((l) => [l.node.name, l])), [laid]);

  // Gutter takes ~a third of the width, clamped so labels get room but rails
  // never vanish.
  const gutterW = Math.min(Math.max(Math.round(width * 0.32), 150), 300);
  const graphLeft = gutterW + GRAPH_LEFT_PAD;

  const nodeX = (depth: number) => graphLeft + depth * INDENT;
  const rowY = (row: number) => TOP_PAD + row * ROW_H + ROW_H / 2;
  const rightX = width - CHIP_W - 12;
  const height = TOP_PAD + BOTTOM_PAD + Math.max(1, laid.length) * ROW_H;

  const baseOptions = useMemo(() => Array.from(new Set(branches.map((b) => b.name))), [branches]);

  return (
    <div className="branch-graph" ref={wrapRef}>
      <div className="branch-graph-header">
        <span className="branch-graph-title">Branch graph</span>
        <div className="branch-graph-header-actions">
          <button
            type="button"
            className={`branch-graph-refresh${isRefreshing ? ' spinning' : ''}`}
            onClick={() => void handleRefresh()}
            disabled={isRefreshing}
            title="Refresh branches"
            aria-label="Refresh branches"
          >
            <ResetIcon size={14} />
          </button>
          {baseOptions.length > 0 && (
            <label className="branch-graph-default-base">
              <span>Default base</span>
              <select
                className="branch-graph-default-base-select"
                value={defaultBase ?? ''}
                onChange={(e) => void handleDefaultBaseChange(e.target.value)}
              >
                {defaultBase && !baseOptions.includes(defaultBase) && (
                  <option value={defaultBase}>{defaultBase}</option>
                )}
                {baseOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {loading && !nodes ? (
        <div className="branch-graph-loading">
          <Spinner size="sm" />
        </div>
      ) : laid.length === 0 ? (
        <div className="branch-graph-empty">No branches to display</div>
      ) : (
        <div className="branch-graph-body" style={{ height }}>
          {/* SVG graphics layer: rails, nodes, elbows, PR markers */}
          <svg className="branch-graph-svg" width={width} height={height}>
            <defs>
              <marker
                id="branch-graph-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="5"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L7,4 L0,8 Z" className="branch-graph-arrowhead" />
              </marker>
            </defs>

            {/* Fork elbows (under rails) */}
            {laid.map((l) => {
              const base = l.node.base ? laidByName.get(l.node.base) : null;
              if (!base) return null;
              const x = nodeX(l.depth);
              const yParent = rowY(base.row);
              const yChild = rowY(l.row);
              const d =
                yChild > yParent
                  ? `M ${x} ${yParent} L ${x} ${yChild - CORNER} Q ${x} ${yChild} ${x + CORNER} ${yChild}`
                  : `M ${x} ${yParent} L ${x} ${yChild + CORNER} Q ${x} ${yChild} ${x + CORNER} ${yChild}`;
              return <path key={`elbow-${l.node.name}`} className="branch-graph-elbow" d={d} />;
            })}

            {/* Rails, nodes, PR markers */}
            {laid.map((l) => {
              const x = nodeX(l.depth);
              const y = rowY(l.row);
              const isCurrent = l.node.name === currentBranch;
              const hasParent = !!(l.node.base && laidByName.get(l.node.base));
              const railStart = hasParent ? x + CORNER : x;
              const railClass = `branch-graph-rail${isCurrent ? ' is-current' : ''}${
                l.node.isDefault ? ' is-default' : ''
              }`;
              const nodeClass = `branch-graph-node${isCurrent ? ' is-current' : ''}`;
              // Fork node sits on the parent rail; a root's node caps its own rail.
              const nodeY = hasParent ? rowY(laidByName.get(l.node.base!)!.row) : y;

              const pr = l.pr;
              const chipCx = rightX + CHIP_W / 2;
              const target = pr ? laidByName.get(pr.baseRef) : null;

              return (
                <g key={`row-${l.node.name}`}>
                  <line className={railClass} x1={railStart} y1={y} x2={rightX} y2={y} />
                  <circle className={nodeClass} cx={x} cy={nodeY} r={NODE_R} />

                  {pr && (
                    <g
                      className="branch-graph-pr"
                      onClick={() => void openUrl(pr.url)}
                      role="button"
                      tabIndex={0}
                    >
                      {target &&
                        (() => {
                          const ty = rowY(target.row);
                          const up = ty < y;
                          return (
                            <line
                              className="branch-graph-pr-arrow"
                              x1={chipCx}
                              y1={up ? y - CHIP_H / 2 - 1 : y + CHIP_H / 2 + 1}
                              x2={chipCx}
                              y2={up ? ty + NODE_R + 2 : ty - NODE_R - 2}
                              markerEnd="url(#branch-graph-arrow)"
                            />
                          );
                        })()}
                      <rect
                        className="branch-graph-pr-chip"
                        x={chipCx - CHIP_W / 2}
                        y={y - CHIP_H / 2}
                        width={CHIP_W}
                        height={CHIP_H}
                        rx={4}
                      />
                      <text className="branch-graph-pr-text" x={chipCx} y={y + 4}>
                        PR
                      </text>
                      <title>{`#${pr.number} ${pr.headRef} → ${pr.baseRef}: ${pr.title}`}</title>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Label gutter (HTML, so names truncate with an ellipsis) */}
          {laid.map((l) => {
            const isCurrent = l.node.name === currentBranch;
            const left = LABEL_PAD + l.depth * LABEL_INDENT;
            const meta = metaFor(l.node);
            return (
              <div
                key={`label-${l.node.name}`}
                className="branch-graph-row-label"
                style={{
                  top: TOP_PAD + l.row * ROW_H,
                  height: ROW_H,
                  left,
                  width: Math.max(60, gutterW - left - 6),
                }}
                onClick={() => onSelectBranch?.(l.node.name)}
                role={onSelectBranch ? 'button' : undefined}
                tabIndex={onSelectBranch ? 0 : undefined}
                title={l.node.name}
              >
                <span className={`branch-graph-row-name${isCurrent ? ' is-current' : ''}`}>
                  {l.node.name}
                  {isCurrent && <span className="branch-graph-row-here"> ●</span>}
                </span>
                <span className="branch-graph-row-meta">
                  {!l.node.pushed && <span className="branch-graph-row-local">local only</span>}
                  {!l.node.pushed && meta && ' · '}
                  {meta}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
