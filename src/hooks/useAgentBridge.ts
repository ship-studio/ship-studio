/**
 * Wires the agent preview bridge into the preview: starts the per-window MCP
 * server, registers it in the agent's config for this project, and answers
 * the tool calls Rust forwards as `agent-bridge-request` events.
 *
 * Mounted from Preview (which owns the connection state the tools need).
 * Context values go through refs so the event listener binds once.
 */

import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  executeBridgeTool,
  getAgentBridgeUrl,
  registerPreviewMcpServer,
  registerSharedPreviewMcpServers,
  respondToBridgeRequest,
  setAgentBridgeAttached,
  type BridgeRequest,
  type ViewportPreset,
} from '../lib/agentBridge';
import { beginAgentActivity } from '../lib/agentActivityStore';
import { logger } from '../lib/logger';
import { trackEvent } from '../lib/analytics';

interface UseAgentBridgeParams {
  projectPath: string;
  /** Full URL of the page the preview is currently showing (null = not running). */
  currentUrl: string | null;
  /** Whether the dev server is up and the preview is rendering. */
  serverReady: boolean;
  /** In-app path the preview is currently on. */
  currentPath: string;
  /** Known routes of the app (pages dropdown detection). */
  pages: string[];
  navigate: (route: string) => void;
  reload: () => void;
  /** Resize the preview viewport (device preset or exact px width). */
  setViewport: (value: number | ViewportPreset) => void;
  /** Current custom viewport width in px, or null = full pane width. */
  getViewportWidth: () => number | null;
}

export function useAgentBridge({
  projectPath,
  currentUrl,
  serverReady,
  currentPath,
  pages,
  navigate,
  reload,
  setViewport,
  getViewportWidth,
}: UseAgentBridgeParams) {
  // Live values for the long-lived listener — rebinding the Tauri listener on
  // every URL change would race in-flight requests.
  const ctxRef = useRef({
    projectPath,
    currentUrl,
    serverReady,
    currentPath,
    pages,
    navigate,
    reload,
    setViewport,
    getViewportWidth,
  });
  useEffect(() => {
    ctxRef.current = {
      projectPath,
      currentUrl,
      serverReady,
      currentPath,
      pages,
      navigate,
      reload,
      setViewport,
      getViewportWidth,
    };
  });

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const setUp = async () => {
      let url: string;
      try {
        url = await getAgentBridgeUrl(projectPath);
      } catch (err) {
        logger.error('[AgentBridge] Failed to get bridge URL', { error: String(err) });
        return;
      }
      if (cancelled) return;

      // Register with the agent CLIs (best-effort: an agent may not be
      // installed, and the preview works fine without the bridge). URLs are
      // stable across runs, so these are no-ops after the first registration:
      // Claude Code gets a per-project entry; Codex/Opencode/Cursor have
      // global configs and share the focused-project "active" URL.
      registerPreviewMcpServer(url, projectPath).then(
        () => logger.info('[AgentBridge] Preview MCP server registration ensured', { projectPath }),
        (err) => {
          logger.warn('[AgentBridge] Could not register preview MCP server', {
            error: String(err),
          });
        }
      );
      void registerSharedPreviewMcpServers();

      unlisten = await listen<BridgeRequest>('agent-bridge-request', (event) => {
        const request = event.payload;
        void (async () => {
          const live = ctxRef.current;
          // Light up the preview overlay (glow/cursor/chip) for the call's
          // duration so it's obvious this is the agent acting, not the user.
          const endActivity = beginAgentActivity(request.tool, request.arguments);
          const result = await executeBridgeTool(request, {
            projectPath: live.projectPath,
            getCurrentUrl: () => live.currentUrl,
            serverReady: live.serverReady,
            currentPath: live.currentPath,
            pages: live.pages,
            navigate: live.navigate,
            reload: live.reload,
            setViewport: live.setViewport,
            getViewportWidth: live.getViewportWidth,
          });
          endActivity();
          void trackEvent('agent_bridge_tool_used', {
            tool: request.tool,
            is_error: result.isError === true,
          });
          try {
            await respondToBridgeRequest(request.requestId, result);
          } catch (err) {
            logger.error('[AgentBridge] Failed to deliver tool response', {
              error: String(err),
            });
          }
        })();
      });
      // The effect was cleaned up while `listen` was in flight.
      if (cancelled) {
        unlisten();
        unlisten = null;
        return;
      }
      // Listener is live — let tool calls route here instead of failing fast.
      setAgentBridgeAttached(projectPath, true).catch((err: unknown) => {
        logger.warn('[AgentBridge] Failed to mark preview attached', { error: String(err) });
      });
    };

    void setUp();

    return () => {
      cancelled = true;
      unlisten?.();
      // The bridge server stays up for the app's lifetime; detaching makes
      // tool calls fail fast with "preview isn't active" instead of waiting
      // out the timeout.
      setAgentBridgeAttached(projectPath, false).catch(() => {});
    };
  }, [projectPath]);
}
