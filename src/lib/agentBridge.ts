/**
 * Agent preview bridge — frontend half.
 *
 * The Rust side (`src-tauri/src/agent_bridge.rs`) runs a loopback MCP server
 * the workspace agent connects to. Every `tools/call` is forwarded to this
 * window as an `agent-bridge-request` event; `executeBridgeTool` produces the
 * MCP result (reading the inspect store, driving the preview, capturing
 * screenshots) and `respondToBridgeRequest` hands it back to Rust.
 *
 * The useAgentBridge hook (src/hooks/useAgentBridge.ts) owns the wiring.
 */

import { invoke } from '@tauri-apps/api/core';
import { inspectStore, type ConsoleEntry, type NetworkEntry } from './inspectStore';
import {
  formatConsoleForAgent,
  formatNetworkForAgent,
  formatElementsForAgent,
} from './inspectFormat';
import { addMcpServer, removeMcpServer } from './mcp';
import { asCommandError, formatCommandError } from './errors';
import { execPreviewAction, type PreviewActionResult } from './previewActions';
import { agentCursorAt } from './agentActivityStore';
import { logger } from './logger';

/** Tool call forwarded from the Rust MCP server. */
export interface BridgeRequest {
  requestId: number;
  tool: string;
  arguments?: Record<string, unknown>;
}

type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** MCP CallToolResult — passed back to the agent verbatim. */
export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export type ViewportPreset = 'mobile' | 'tablet' | 'laptop' | 'desktop' | 'full';

export const VIEWPORT_PRESETS: ViewportPreset[] = ['mobile', 'tablet', 'laptop', 'desktop', 'full'];

/** What the bridge needs from the preview to execute tools. */
export interface BridgeToolContext {
  projectPath: string;
  /** Full URL of the page the preview is showing, or null if not running. */
  getCurrentUrl: () => string | null;
  /** Whether the dev server is up and the preview is rendering. */
  serverReady: boolean;
  /** In-app path the preview is currently on (e.g. '/about'). */
  currentPath: string;
  /** Known routes of the app (from the pages dropdown detection). */
  pages: string[];
  navigate: (route: string) => void;
  reload: () => void;
  /** Resize the preview viewport (device preset or exact px width). */
  setViewport: (value: number | ViewportPreset) => void;
  /** Current custom viewport width in px, or null = full pane width. */
  getViewportWidth: () => number | null;
}

export const PREVIEW_MCP_SERVER_NAME = 'shipstudio-preview';

/** Base64 payloads above this are returned as a file path instead of inline
 *  image content — huge inline images blow up the agent's context. */
const MAX_INLINE_IMAGE_BASE64_CHARS = 2_000_000;

const DEFAULT_ENTRY_LIMIT = 50;

/**
 * The project's MCP URL (stable across app runs: persistent token + port,
 * project path encoded in the path for routing). Starts the global bridge
 * server if it isn't running yet.
 */
export async function getAgentBridgeUrl(projectPath: string): Promise<string> {
  return invoke<string>('get_agent_bridge_url', { projectPath });
}

/**
 * Tell the backend whether this project's preview listener is live. Detached
 * projects fail tool calls instantly with an honest "preview isn't active"
 * message instead of a long timeout.
 */
export async function setAgentBridgeAttached(
  projectPath: string,
  attached: boolean
): Promise<void> {
  return invoke('agent_bridge_attach', { projectPath, attached });
}

export async function respondToBridgeRequest(
  requestId: number,
  result: McpToolResult
): Promise<void> {
  return invoke('agent_bridge_respond', { requestId, result });
}

/** localStorage record of which URL each registration target holds. */
const REGISTRATION_CACHE_KEY = 'shipstudio.agentBridgeRegistrations';

function readRegistrationCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(REGISTRATION_CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeRegistrationCache(key: string, url: string): void {
  try {
    localStorage.setItem(
      REGISTRATION_CACHE_KEY,
      JSON.stringify({ ...readRegistrationCache(), [key]: url })
    );
  } catch {
    // Cache is an optimization; the registration itself succeeded.
  }
}

/**
 * Register the bridge as an MCP server in the agent's config for this
 * project. The URL is stable across app runs (persistent token + port), so
 * this is effectively install-once: a localStorage cache skips the agent-CLI
 * round-trips when the project is already registered with the same URL, and
 * a changed URL (e.g. the stable port was taken) self-corrects here.
 *
 * Local scope: the config stays in the user's own agent settings and never
 * lands in the repo (the URL embeds a secret and must not be committed).
 */
export function registerPreviewMcpServer(url: string, projectPath: string): Promise<void> {
  // Serialize per project: the remove-then-add cycle is not atomic, so two
  // concurrent registrations (e.g. a re-attach racing the first attach) could
  // interleave and fail with "already exists" on the losing add (issue #292).
  const existing = inFlightRegistrations.get(projectPath);
  if (existing) return existing;
  const run = doRegisterPreviewMcpServer(url, projectPath).finally(() => {
    inFlightRegistrations.delete(projectPath);
  });
  inFlightRegistrations.set(projectPath, run);
  return run;
}

/** In-flight preview registrations keyed by project path (see above). */
const inFlightRegistrations = new Map<string, Promise<void>>();

async function doRegisterPreviewMcpServer(url: string, projectPath: string): Promise<void> {
  const agentId = 'claude-code';
  const cache = readRegistrationCache();
  if (cache[projectPath] === url) return;

  try {
    await removeMcpServer(PREVIEW_MCP_SERVER_NAME, 'local', projectPath, agentId);
  } catch {
    // Not registered yet — the normal case on first registration.
  }
  try {
    await addMcpServer(
      `--transport http ${PREVIEW_MCP_SERVER_NAME} ${url}`,
      'local',
      projectPath,
      agentId
    );
  } catch (err) {
    // "Already exists" means a concurrent writer (another window, a manual
    // add) recreated the entry between our remove and add — the goal state
    // (server registered, same stable URL) is reached, so don't fail (#292).
    if (!/already exists/i.test(formatCommandError(asCommandError(err)))) throw err;
    logger.info('[AgentBridge] MCP entry already present — treating as registered');
  }
  writeRegistrationCache(projectPath, url);
}

/**
 * Register the bridge for the agents whose MCP configs are GLOBAL rather
 * than per-project: Codex and Opencode (via their CLIs) and Cursor (via
 * ~/.cursor/mcp.json). They all get the "active" URL, which routes each tool
 * call to the focused Ship Studio project at call time.
 *
 * Best-effort per agent: an agent that isn't installed just logs and skips.
 * The registration cache makes this a no-op after the first success.
 */
export async function registerSharedPreviewMcpServers(): Promise<void> {
  let url: string;
  try {
    url = await invoke<string>('get_agent_bridge_active_url');
  } catch (err) {
    logger.warn('[AgentBridge] Could not get active bridge URL', { error: String(err) });
    return;
  }
  const cache = readRegistrationCache();

  for (const agentId of ['codex', 'opencode'] as const) {
    const key = `shared|${agentId}`;
    if (cache[key] === url) continue;
    try {
      if (cache[key]) {
        // URL changed (rare: the stable port was taken) — replace the entry.
        // Opencode has no `mcp remove`; its add overwrites by name.
        if (agentId === 'codex') {
          await removeMcpServer(PREVIEW_MCP_SERVER_NAME, undefined, undefined, agentId).catch(
            () => {}
          );
        }
      }
      await addMcpServer(`${PREVIEW_MCP_SERVER_NAME} --url ${url}`, undefined, undefined, agentId);
      writeRegistrationCache(key, url);
      logger.info('[AgentBridge] Registered preview MCP server', { agent: agentId });
    } catch (err) {
      // Agent not installed, or the entry already exists — both fine.
      logger.info('[AgentBridge] Skipped MCP registration', {
        agent: agentId,
        reason: String(err),
      });
    }
  }

  const cursorKey = 'shared|cursor';
  if (cache[cursorKey] !== url) {
    try {
      const registered = await invoke<boolean>('register_cursor_mcp', { url });
      if (registered) {
        writeRegistrationCache(cursorKey, url);
        logger.info('[AgentBridge] Registered preview MCP server', { agent: 'cursor' });
      }
    } catch (err) {
      logger.warn('[AgentBridge] Cursor MCP registration failed', { error: String(err) });
    }
  }
}

/** Text-only convenience result. */
const text = (t: string): McpToolResult => ({ content: [{ type: 'text', text: t }] });
const errorResult = (t: string): McpToolResult => ({
  content: [{ type: 'text', text: t }],
  isError: true,
});

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_ENTRY_LIMIT;
  return Math.min(Math.max(n, 1), 500);
}

function filterConsole(entries: ConsoleEntry[], level: unknown): ConsoleEntry[] {
  if (level === 'error') return entries.filter((e) => e.level === 'error');
  if (level === 'warn') return entries.filter((e) => e.level === 'error' || e.level === 'warn');
  return entries;
}

function filterNetwork(entries: NetworkEntry[], failedOnly: unknown): NetworkEntry[] {
  if (failedOnly !== true) return entries;
  return entries.filter(
    (e) =>
      !e.pending && (e.error != null || e.ok === false || (e.status != null && e.status >= 400))
  );
}

/**
 * Ask the preview for a fresh DOM tree and wait for it to arrive. Falls back
 * to whatever snapshot exists (possibly null) after the timeout — the shim
 * only answers while a preview document is actually loaded.
 */
function freshDomSnapshot(
  timeoutMs = 3000
): Promise<ReturnType<typeof inspectStore.getDomSnapshot>> {
  return new Promise((resolve) => {
    const before = inspectStore.getDomSnapshot();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(inspectStore.getDomSnapshot());
    };
    const unsubscribe = inspectStore.subscribe(() => {
      const now = inspectStore.getDomSnapshot();
      if (now && now !== before) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
    inspectStore.refreshDom();
  });
}

/**
 * Convert a shim action result into an MCP result. On success, fly the agent
 * cursor to the real element position so the user sees exactly where the
 * agent acted.
 */
function actionToolResult(
  result: PreviewActionResult,
  describe: (data: Record<string, unknown>) => string
): McpToolResult {
  if (!result.ok) return errorResult(result.error ?? 'The action failed for an unknown reason.');
  if (result.rect) agentCursorAt(result.rect.fx, result.rect.fy);
  return text(describe(result.data ?? {}));
}

/** One-call situational summary so the agent can diagnose instead of guess. */
function buildStatusReport(ctx: BridgeToolContext): string {
  const lines: string[] = [];
  if (!ctx.serverReady) {
    lines.push(
      'Dev server: NOT running (or still starting). The preview has nothing to show yet — ask the user to start the dev server or open the preview panel.'
    );
  } else {
    lines.push('Dev server: running, preview connected.');
    lines.push(`Current page: ${ctx.currentPath || '/'} (${ctx.getCurrentUrl() ?? 'URL unknown'})`);
    const width = ctx.getViewportWidth();
    lines.push(
      width === null
        ? 'Viewport: full pane width (use preview_set_viewport to test breakpoints).'
        : `Viewport: ${width}px (custom — preview_set_viewport preset 'full' resets it).`
    );
  }
  if (ctx.pages.length > 0) {
    lines.push(`Available pages (${ctx.pages.length}): ${ctx.pages.join(', ')}`);
  }
  const consoleEntries = inspectStore.getConsoleEntries();
  const errorCount = consoleEntries.filter((e) => e.level === 'error').length;
  const warnCount = consoleEntries.filter((e) => e.level === 'warn').length;
  lines.push(
    `Console: ${consoleEntries.length} entries captured (${errorCount} errors, ${warnCount} warnings).` +
      (errorCount > 0 ? " Call preview_console with level 'error' to read them." : '')
  );
  const failedRequests = filterNetwork(inspectStore.getNetworkEntries(), true).length;
  lines.push(
    `Network: ${inspectStore.getNetworkEntries().length} requests captured, ${failedRequests} failed.`
  );
  return lines.join('\n');
}

/** Validate a preview_navigate path: in-app absolute path, not a full URL. */
export function isValidPreviewPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.includes('://')
  );
}

async function captureScreenshot(
  ctx: BridgeToolContext,
  fullPage: boolean
): Promise<McpToolResult> {
  const url = ctx.getCurrentUrl();
  if (!url) {
    return errorResult(
      'The preview is not running yet (no dev server URL). Ask the user to open the preview panel, or start the dev server first.'
    );
  }
  // The URL can be stale (server crashed or restarted on another port) while
  // serverReady is false — capturing anyway makes Playwright fail with
  // ERR_CONNECTION_REFUSED (issue #348).
  if (!ctx.serverReady) {
    return errorResult(
      'The dev server is not ready yet. Wait for the preview to finish loading, then try again.'
    );
  }
  const command = fullPage ? 'capture_fullpage_playwright' : 'capture_viewport_playwright';
  const path = await invoke<string>(command, {
    projectPath: ctx.projectPath,
    url,
    // Capture at the preview's current viewport so responsive checks
    // (preview_set_viewport → preview_screenshot) show the real layout.
    width: ctx.getViewportWidth() ?? undefined,
  });
  const dataUrl = await invoke<string>('get_screenshot_base64', { filePath: path });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  if (base64.length > MAX_INLINE_IMAGE_BASE64_CHARS) {
    return text(
      `Screenshot captured but too large to return inline. It was saved to: ${path} — read that file to view it.`
    );
  }
  return {
    content: [
      { type: 'image', data: base64, mimeType: 'image/png' },
      { type: 'text', text: `Screenshot of ${url} (saved to ${path}).` },
    ],
  };
}

/**
 * Execute one bridge tool call. Never throws — failures come back as
 * `isError` results so the agent can read what went wrong.
 */
export async function executeBridgeTool(
  request: BridgeRequest,
  ctx: BridgeToolContext
): Promise<McpToolResult> {
  const args = request.arguments ?? {};
  try {
    switch (request.tool) {
      case 'preview_console': {
        const filtered = filterConsole(inspectStore.getConsoleEntries(), args.level);
        return text(formatConsoleForAgent(filtered.slice(-clampLimit(args.limit))));
      }
      case 'preview_network': {
        const filtered = filterNetwork(inspectStore.getNetworkEntries(), args.failed_only);
        return text(formatNetworkForAgent(filtered.slice(-clampLimit(args.limit))));
      }
      case 'preview_dom': {
        return text(formatElementsForAgent(await freshDomSnapshot()));
      }
      case 'preview_navigate': {
        if (!isValidPreviewPath(args.path)) {
          return errorResult(
            `Invalid path: ${JSON.stringify(args.path)}. Pass an in-app absolute path starting with '/', e.g. '/about' — not a full URL.`
          );
        }
        ctx.navigate(args.path);
        return text(`Preview navigated to ${args.path}. The user can see this change.`);
      }
      case 'preview_reload': {
        ctx.reload();
        return text('Preview reloaded.');
      }
      case 'preview_screenshot': {
        return await captureScreenshot(ctx, args.full_page === true);
      }
      case 'preview_set_viewport': {
        if (typeof args.width === 'number' && Number.isFinite(args.width)) {
          const width = Math.round(Math.min(Math.max(args.width, 200), 3000));
          ctx.setViewport(width);
          return text(
            `Preview viewport set to ${width}px — the page re-laid-out at that true width. Screenshots now capture at ${width}px too.`
          );
        }
        if (VIEWPORT_PRESETS.includes(args.preset as ViewportPreset)) {
          ctx.setViewport(args.preset as ViewportPreset);
          return text(
            args.preset === 'full'
              ? 'Preview viewport reset to full pane width.'
              : `Preview viewport set to the ${String(args.preset)} preset.`
          );
        }
        return errorResult(
          "preview_set_viewport needs either 'width' (px, 200-3000) or 'preset' (mobile|tablet|laptop|desktop|full)."
        );
      }
      case 'preview_status': {
        return text(buildStatusReport(ctx));
      }
      case 'preview_click': {
        if (typeof args.selector !== 'string' || !args.selector) {
          return errorResult("preview_click requires a 'selector' (CSS selector string).");
        }
        const result = await execPreviewAction({
          action: 'click',
          selector: args.selector,
          text: typeof args.text === 'string' ? args.text : undefined,
          index: typeof args.index === 'number' ? args.index : undefined,
        });
        return actionToolResult(result, (data) => {
          const matches =
            typeof data.matches === 'number' && data.matches > 1
              ? ` (${data.matches} elements matched — clicked the first; pass 'index' or narrow the selector to target another)`
              : '';
          return `Clicked ${String(data.clicked)}${matches}. Check preview_console or the DOM to see what happened.`;
        });
      }
      case 'preview_type': {
        if (typeof args.selector !== 'string' || !args.selector) {
          return errorResult("preview_type requires a 'selector' (CSS selector string).");
        }
        if (typeof args.value !== 'string') {
          return errorResult("preview_type requires a 'value' (the text to enter).");
        }
        const result = await execPreviewAction({
          action: 'type',
          selector: args.selector,
          value: args.value,
          text: typeof args.text === 'string' ? args.text : undefined,
          index: typeof args.index === 'number' ? args.index : undefined,
          submit: args.submit === true,
        });
        return actionToolResult(
          result,
          (data) =>
            `Entered ${String(data.valueLength)} characters into ${String(data.typedInto)}${args.submit === true ? ' and submitted' : ''}.`
        );
      }
      case 'preview_scroll': {
        const result = await execPreviewAction({
          action: 'scroll',
          selector: typeof args.selector === 'string' ? args.selector : undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
          to: args.to === 'top' || args.to === 'bottom' ? args.to : undefined,
          y: typeof args.y === 'number' ? args.y : undefined,
        });
        return actionToolResult(result, (data) => `Scrolled to ${String(data.scrolledTo)}.`);
      }
      case 'preview_query': {
        if (typeof args.selector !== 'string' || !args.selector) {
          return errorResult("preview_query requires a 'selector' (CSS selector string).");
        }
        const result = await execPreviewAction({
          action: 'query',
          selector: args.selector,
          text: typeof args.text === 'string' ? args.text : undefined,
        });
        if (!result.ok) return errorResult(result.error ?? 'Query failed for an unknown reason.');
        return text(JSON.stringify(result.data, null, 2));
      }
      default:
        return errorResult(`Unknown tool: ${request.tool}`);
    }
  } catch (err) {
    // Backend rejections are CommandError objects — String() would swallow
    // the detail as "[object Object]". Surface the real message to both the
    // agent and the logs.
    const detail = err instanceof Error ? err.message : formatCommandError(asCommandError(err));
    logger.error('[AgentBridge] Tool execution failed', {
      tool: request.tool,
      error: detail,
    });
    return errorResult(`Tool '${request.tool}' failed: ${detail}`);
  }
}
