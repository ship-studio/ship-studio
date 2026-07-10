/**
 * Agent-facing serializers for browser-inspector data (console, network,
 * DOM). Shared by the BrowserTools "send to agent" button and the agent
 * preview bridge's MCP tools, so both paths hand the agent identical text.
 */

import type { ConsoleEntry, NetworkEntry, DomNode, DomSnapshot } from './inspectStore';

export const VOID_ELEMENTS = new Set([
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

export function formatConsoleForAgent(entries: ConsoleEntry[]): string {
  if (entries.length === 0) return 'Here is the current browser console (empty).';
  const lines = entries.map((e) => `[${e.level}] ${e.args.join(' ')}`);
  return (
    "Here's the current browser console from the preview:\n\n```\n" + lines.join('\n') + '\n```'
  );
}

export function formatNetworkForAgent(entries: NetworkEntry[]): string {
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

export function formatElementsForAgent(snapshot: DomSnapshot | null): string {
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
    // Rewrite the CLOSING bracket — .replace('>') would hit a '>' inside an
    // attribute value first (escapeHtmlAttr doesn't escape '>').
    out.push(`${pad}${open.slice(0, -1)} />`);
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
