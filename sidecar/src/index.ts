/**
 * Ship Studio Sidecar — Node.js process for the Client AI agent.
 *
 * Communicates with the Tauri backend over stdio using JSON-RPC 2.0.
 * Runs the deepagents harness with OpenRouter for multi-model LLM access.
 *
 * @module index
 */

import * as readline from "node:readline";
import {
  parseMessage,
  sendResponse,
  sendError,
  sendNotification,
  debug,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_CANCELLED,
  RPC_AGENT_ERROR,
} from "./rpc.js";
import { AgentSession } from "./agent.js";

// ============ State ============

let session: AgentSession | null = null;
let currentAbortController: AbortController | null = null;

// ============ Method Handlers ============

type MethodHandler = (id: number, params: Record<string, unknown>) => Promise<void>;

const methods: Record<string, MethodHandler> = {
  async initialize(id, params) {
    const apiKey = params.apiKey as string | undefined;
    const model = params.model as string | undefined;
    const projectPath = params.projectPath as string | undefined;
    const systemPrompt = params.systemPrompt as string | undefined;

    if (!apiKey || !model || !projectPath) {
      sendError(id, RPC_INVALID_PARAMS, "Missing required params: apiKey, model, projectPath");
      return;
    }

    try {
      session = new AgentSession({ apiKey, model, projectPath, systemPrompt });
      await session.initialize();
      sendResponse(id, { ok: true });
      debug("Agent initialized", { model, projectPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(id, RPC_AGENT_ERROR, `Failed to initialize agent: ${message}`);
    }
  },

  async chat(id, params) {
    const message = params.message as string | undefined;
    if (!message) {
      sendError(id, RPC_INVALID_PARAMS, "Missing required param: message");
      return;
    }

    if (!session) {
      sendError(id, RPC_AGENT_ERROR, "Agent not initialized. Call initialize first.");
      return;
    }

    // Create abort controller for this generation
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    // Track tool start times to compute accurate durations
    const toolStartTimes = new Map<string, number>();

    try {
      debug("Starting chat", { message: message.slice(0, 100) });
      await session.chat(message, {
        signal,
        onToken(token: string) {
          sendNotification("stream/token", { token });
        },
        onToolStart(name: string, input: unknown) {
          toolStartTimes.set(name, Date.now());
          debug("Tool start", { name });
          sendNotification("stream/toolStart", { name, input });
        },
        onToolEnd(name: string, output: unknown) {
          const startTime = toolStartTimes.get(name);
          const durationMs = startTime ? Date.now() - startTime : undefined;
          toolStartTimes.delete(name);
          debug("Tool end", { name, durationMs });
          sendNotification("stream/toolEnd", { name, output, durationMs });
        },
        onPlanUpdate(todos: unknown) {
          sendNotification("stream/planUpdate", { todos });
        },
        onError(error: string) {
          debug("Stream error", { error });
          sendNotification("stream/error", { error });
        },
      });

      debug("Chat complete");
      sendNotification("stream/done", {});
      sendResponse(id, { ok: true });
    } catch (err) {
      if (signal.aborted) {
        sendError(id, RPC_CANCELLED, "Generation cancelled");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        sendError(id, RPC_AGENT_ERROR, `Chat error: ${message}`);
      }
    } finally {
      currentAbortController = null;
    }
  },

  async cancel(id) {
    if (currentAbortController) {
      currentAbortController.abort();
      sendResponse(id, { ok: true });
    } else {
      sendResponse(id, { ok: false, reason: "No active generation" });
    }
  },

  async clearHistory(id) {
    if (session) {
      session.clearHistory();
    }
    sendResponse(id, { ok: true });
  },

  async setModel(id, params) {
    const model = params.model as string | undefined;
    if (!model) {
      sendError(id, RPC_INVALID_PARAMS, "Missing required param: model");
      return;
    }

    if (!session) {
      sendError(id, RPC_AGENT_ERROR, "Agent not initialized. Call initialize first.");
      return;
    }

    try {
      session.setModel(model);
      sendResponse(id, { ok: true });
      debug("Model changed", { model });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(id, RPC_AGENT_ERROR, `Failed to set model: ${message}`);
    }
  },

  async healthCheck(id) {
    sendResponse(id, {
      ok: true,
      initialized: session !== null,
      generating: currentAbortController !== null,
    });
  },
};

// ============ Main Loop ============

async function main(): Promise<void> {
  debug("Sidecar starting...");

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const request = parseMessage(trimmed);
    if (!request) {
      debug("Invalid JSON-RPC message", { line: trimmed });
      return;
    }

    const handler = methods[request.method];
    if (!handler) {
      sendError(request.id, RPC_METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
      return;
    }

    try {
      await handler(request.id, request.params ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(request.id, RPC_INTERNAL_ERROR, `Unexpected error: ${message}`);
    }
  });

  rl.on("close", () => {
    debug("Stdin closed, shutting down");
    process.exit(0);
  });

  // Handle signals
  process.on("SIGTERM", () => {
    debug("SIGTERM received, shutting down");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    debug("SIGINT received, shutting down");
    process.exit(0);
  });

  // Notify parent that we're ready
  sendNotification("ready", {});
  debug("Sidecar ready, waiting for commands...");
}

main().catch((err) => {
  debug("Fatal error", { error: String(err) });
  process.exit(1);
});
