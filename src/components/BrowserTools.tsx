/**
 * In-panel browser inspector. Subscribes to the module-level `inspectStore`
 * (which captures messages from the inspector shim injected by Tauri's
 * `initialization_script_for_all_frames`).
 *
 * v1 covers Console, Network, and Elements. Data lives in the store, not
 * component state, so frequent re-renders or transient unmounts of this
 * component never drop captured data.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  inspectStore,
  type ConsoleEntry,
  type NetworkEntry,
  type DomNode,
  type DomSnapshot,
} from '../lib/inspectStore';
import { trackEvent } from '../lib/analytics';

type InnerTab = 'console' | 'network' | 'elements';

interface BrowserToolsProps {
  /** Pipe the currently active tab's serialized content into the agent terminal. */
  onSendToAgent?: (text: string) => void;
}

export function BrowserTools({ onSendToAgent }: BrowserToolsProps) {
  const [tab, setTabRaw] = useState<InnerTab>('console');
  const setTab = (next: InnerTab) => {
    if (next !== tab) {
      void trackEvent('browser_tools_subtab_switched', { from_tab: tab, to_tab: next });
    }
    setTabRaw(next);
  };

  const consoleEntries = useSyncExternalStore(
    inspectStore.subscribe,
    inspectStore.getConsoleEntries
  );
  const networkEntries = useSyncExternalStore(
    inspectStore.subscribe,
    inspectStore.getNetworkEntries
  );
  const domSnapshot = useSyncExternalStore(inspectStore.subscribe, inspectStore.getDomSnapshot);

  // Refresh DOM whenever the Elements tab activates so the user always sees
  // current state (auto-refresh from the shim is debounced at 300ms).
  useEffect(() => {
    if (tab === 'elements') inspectStore.refreshDom();
  }, [tab]);

  const handleClear = () => {
    if (tab === 'console') {
      void trackEvent('browser_tools_cleared', { tab: 'console' });
      inspectStore.clearConsole();
    } else if (tab === 'network') {
      void trackEvent('browser_tools_cleared', { tab: 'network' });
      inspectStore.clearNetwork();
    } else if (tab === 'elements') {
      void trackEvent('browser_tools_dom_refreshed');
      inspectStore.refreshDom();
    }
  };

  const handleSendToAgent = () => {
    if (!onSendToAgent) return;
    let prompt: string;
    // entry_count only makes sense for the list-shaped tabs. For elements we
    // emit it as null so PostHog doesn't average a fake "1 vs 0" boolean
    // alongside real list lengths from console/network.
    let entryCount: number | null = null;
    if (tab === 'console') {
      prompt = formatConsoleForAgent(consoleEntries);
      entryCount = consoleEntries.length;
    } else if (tab === 'network') {
      prompt = formatNetworkForAgent(networkEntries);
      entryCount = networkEntries.length;
    } else {
      prompt = formatElementsForAgent(domSnapshot);
    }
    void trackEvent('browser_tools_sent_to_agent', {
      tab,
      entry_count: entryCount,
      had_data: tab === 'elements' ? domSnapshot !== null : (entryCount ?? 0) > 0,
      char_count: prompt.length,
    });
    onSendToAgent(prompt);
  };

  const sendDisabled =
    !onSendToAgent ||
    (tab === 'console' && consoleEntries.length === 0) ||
    (tab === 'network' && networkEntries.length === 0) ||
    (tab === 'elements' && !domSnapshot);

  return (
    <div className="browser-tools">
      <div className="browser-tools-tabs" role="tablist">
        <TabButton
          label="Console"
          count={consoleEntries.length}
          active={tab === 'console'}
          onClick={() => setTab('console')}
        />
        <TabButton
          label="Network"
          count={networkEntries.length}
          active={tab === 'network'}
          onClick={() => setTab('network')}
        />
        <TabButton
          label="Elements"
          active={tab === 'elements'}
          onClick={() => setTab('elements')}
        />
        <div className="browser-tools-tabs-spacer" />
        <div className="browser-tools-actions">
          {onSendToAgent && (
            <button
              type="button"
              className="browser-tools-send"
              onClick={handleSendToAgent}
              disabled={sendDisabled}
              title={`Send current ${tab} contents to the active agent`}
            >
              Send to agent
            </button>
          )}
          <button
            type="button"
            className="browser-tools-clear"
            onClick={handleClear}
            title={tab === 'elements' ? 'Refresh DOM' : `Clear ${tab}`}
          >
            {tab === 'elements' ? 'Refresh' : 'Clear'}
          </button>
        </div>
      </div>
      {/* All three views stay mounted and stack in the same grid cell.
          Swapping `is-active` via opacity preserves scroll position and
          state; `inert` on inactive slots blocks focus + pointer events. */}
      <div className="browser-tools-body">
        <div className={`browser-tools-slot ${tab === 'console' ? 'is-active' : ''}`}>
          <ConsoleView entries={consoleEntries} />
        </div>
        <div className={`browser-tools-slot ${tab === 'network' ? 'is-active' : ''}`}>
          <NetworkView entries={networkEntries} />
        </div>
        <div className={`browser-tools-slot ${tab === 'elements' ? 'is-active' : ''}`}>
          <ElementsView snapshot={domSnapshot} />
        </div>
      </div>
    </div>
  );
}

interface TabButtonProps {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}

function TabButton({ label, count, active, onClick }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`browser-tools-tab ${active ? 'is-active' : ''}`}
      onClick={onClick}
    >
      {label}
      {count !== undefined && count > 0 && <span className="browser-tools-tab-count">{count}</span>}
    </button>
  );
}

// ============================================================================
// Console
// ============================================================================

function ConsoleView({ entries }: { entries: ConsoleEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  if (entries.length === 0) {
    return <div className="browser-tools-empty">No console output yet.</div>;
  }

  return (
    <div
      ref={scrollRef}
      className="browser-tools-console"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
      }}
    >
      {entries.map((entry) => (
        <div key={entry.id} className={`console-row console-row-${entry.level}`}>
          <span className="console-row-level">{entry.level}</span>
          <pre className="console-row-args">{entry.args.join(' ')}</pre>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Network
// ============================================================================

function NetworkView({ entries }: { entries: NetworkEntry[] }) {
  if (entries.length === 0) {
    return <div className="browser-tools-empty">No network requests yet.</div>;
  }

  return (
    <div className="browser-tools-network">
      <div className="network-header">
        <span className="network-col-method">Method</span>
        <span className="network-col-status">Status</span>
        <span className="network-col-url">URL</span>
        <span className="network-col-time">Time</span>
      </div>
      <div className="network-rows">
        {entries.map((entry) => {
          const statusClass = entry.pending
            ? 'pending'
            : entry.ok
              ? 'ok'
              : entry.status === 0
                ? 'err'
                : 'bad';
          return (
            <div key={entry.id} className={`network-row status-${statusClass}`}>
              <span className="network-col-method">{entry.method}</span>
              <span className="network-col-status">
                {entry.pending ? '…' : entry.status === 0 ? 'ERR' : entry.status}
              </span>
              <span className="network-col-url" title={entry.url}>
                {entry.url}
              </span>
              <span className="network-col-time">
                {entry.pending ? '' : entry.duration != null ? `${entry.duration}ms` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Elements
// ============================================================================

function ElementsView({ snapshot }: { snapshot: DomSnapshot | null }) {
  if (!snapshot) {
    return <div className="browser-tools-empty">Waiting for DOM snapshot from preview…</div>;
  }
  return (
    <div className="browser-tools-elements">
      {snapshot.truncated && (
        <div className="elements-truncated-banner">
          Tree truncated — page exceeds the 1500-node snapshot cap.
        </div>
      )}
      <div className="elements-tree">
        <ElementsNode node={snapshot.tree} depth={0} />
      </div>
    </div>
  );
}

function ElementsNode({ node, depth }: { node: DomNode; depth: number }) {
  // Default: expand top-level nodes, collapse deeper ones for readability.
  const [expanded, setExpanded] = useState(depth < 2);

  if (node.kind === 'text') {
    return (
      <div className="el-row el-row-text" style={{ paddingLeft: indent(depth) }}>
        <span className="el-text">{node.text}</span>
      </div>
    );
  }

  if (node.kind === 'comment') {
    return (
      <div className="el-row el-row-comment" style={{ paddingLeft: indent(depth) }}>
        <span className="el-comment">&lt;!-- {node.text} --&gt;</span>
      </div>
    );
  }

  const hasChildren = node.children.length > 0;
  const isVoid = VOID_ELEMENTS.has(node.tag);

  return (
    <div className="el-block">
      <div
        className={`el-row el-row-tag ${hasChildren ? 'has-children' : ''}`}
        style={{ paddingLeft: indent(depth) }}
        onClick={hasChildren ? () => setExpanded((e) => !e) : undefined}
      >
        {hasChildren ? (
          <span className={`el-toggle ${expanded ? 'is-open' : ''}`}>▶</span>
        ) : (
          <span className="el-toggle el-toggle-empty" />
        )}
        <span className="el-bracket">&lt;</span>
        <span className="el-tag">{node.tag}</span>
        <NodeAttrs attrs={node.attrs} />
        {isVoid ? (
          <span className="el-bracket">&nbsp;/&gt;</span>
        ) : hasChildren && !expanded ? (
          <>
            <span className="el-bracket">&gt;</span>
            <span className="el-ellipsis">…</span>
            <span className="el-bracket">&lt;/</span>
            <span className="el-tag">{node.tag}</span>
            <span className="el-bracket">&gt;</span>
          </>
        ) : (
          <span className="el-bracket">&gt;</span>
        )}
      </div>
      {expanded && hasChildren && (
        <>
          {node.children.map((c, i) => (
            <ElementsNode key={i} node={c} depth={depth + 1} />
          ))}
          <div className="el-row el-row-close" style={{ paddingLeft: indent(depth) }}>
            <span className="el-toggle el-toggle-empty" />
            <span className="el-bracket">&lt;/</span>
            <span className="el-tag">{node.tag}</span>
            <span className="el-bracket">&gt;</span>
          </div>
        </>
      )}
    </div>
  );
}

function NodeAttrs({ attrs }: { attrs: Record<string, string> }) {
  const keys = Object.keys(attrs);
  if (keys.length === 0) return null;
  return (
    <>
      {keys.map((k) => (
        <span key={k} className="el-attr">
          {' '}
          <span className="el-attr-name">{k}</span>
          {attrs[k] !== '' && (
            <>
              <span className="el-attr-eq">=</span>
              <span className="el-attr-value">"{attrs[k]}"</span>
            </>
          )}
        </span>
      ))}
    </>
  );
}

const indent = (depth: number) => `${depth * 14 + 6}px`;

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// ============================================================================
// Agent-send serializers
// ============================================================================

function formatConsoleForAgent(entries: ConsoleEntry[]): string {
  if (entries.length === 0) return 'Here is the current browser console (empty).';
  const lines = entries.map((e) => `[${e.level}] ${e.args.join(' ')}`);
  return (
    "Here's the current browser console from the preview:\n\n```\n" + lines.join('\n') + '\n```'
  );
}

function formatNetworkForAgent(entries: NetworkEntry[]): string {
  if (entries.length === 0) return 'Here are the preview network requests (none yet).';
  const rows = entries.map((e) => {
    const status = e.pending ? 'pending' : e.status === 0 ? 'ERR' : String(e.status);
    const duration = e.duration != null ? `${e.duration}ms` : '-';
    const err = e.error ? ` [${e.error}]` : '';
    return `${e.method.padEnd(6)} ${status.padEnd(7)} ${duration.padEnd(7)} ${e.url}${err}`;
  });
  return (
    "Here's the current network activity from the preview:\n\n```\n" +
    'METHOD STATUS  TIME    URL\n' +
    rows.join('\n') +
    '\n```'
  );
}

function formatElementsForAgent(snapshot: DomSnapshot | null): string {
  if (!snapshot) return 'The preview DOM snapshot is not available yet.';
  const buf: string[] = [];
  serializeDomForAgent(snapshot.tree, 0, buf);
  const header = snapshot.truncated
    ? "Here's the current preview DOM (truncated at 1500 nodes):"
    : "Here's the current preview DOM:";
  return `${header}\n\n\`\`\`html\n${buf.join('\n')}\n\`\`\``;
}

/* Escape for HTML text context: & < > so a literal `<script>` or
   `a && b` in page content doesn't produce invalid markup when the
   agent re-parses what we send. */
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Escape for HTML attribute-value context (double-quoted). & and "
   are required by spec; < is belt-and-suspenders. */
function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function serializeDomForAgent(node: DomNode, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  if (node.kind === 'text') {
    if (node.text.trim()) out.push(pad + escapeHtmlText(node.text));
    return;
  }
  if (node.kind === 'comment') {
    // `-->` inside a comment would terminate it prematurely; neutralize.
    const safe = node.text.replace(/-->/g, '-- >');
    out.push(`${pad}<!-- ${safe} -->`);
    return;
  }
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => `${k}="${escapeHtmlAttr(v)}"`)
    .join(' ');
  const open = attrs ? `<${node.tag} ${attrs}>` : `<${node.tag}>`;
  if (VOID_ELEMENTS.has(node.tag)) {
    out.push(pad + open.replace('>', ' />'));
    return;
  }
  if (node.children.length === 0) {
    out.push(`${pad}${open}</${node.tag}>`);
    return;
  }
  out.push(pad + open);
  for (const c of node.children) serializeDomForAgent(c, depth + 1, out);
  out.push(`${pad}</${node.tag}>`);
}
