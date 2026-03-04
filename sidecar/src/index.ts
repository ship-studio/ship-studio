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

// ============ Helpers ============

/** Extract a short summary from tool input for debug logging. */
function summarizeToolInput(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const data = input as Record<string, unknown>;
  switch (name) {
    case "ls":
      return String(data.path ?? data.directory ?? data.dir ?? ".");
    case "glob":
      return String(data.pattern ?? data.glob ?? "");
    case "grep":
      return String(data.pattern ?? data.query ?? "");
    case "read_file":
    case "write_file":
      return String(data.path ?? data.file_path ?? data.filePath ?? "");
    case "edit_file": {
      const filePath = String(data.path ?? data.file_path ?? data.filePath ?? "");
      const oldStr = String(data.old_string ?? data.oldString ?? "");
      const preview = oldStr.length > 40 ? oldStr.slice(0, 37) + "..." : oldStr;
      return preview ? `${filePath} (old: "${preview}")` : filePath;
    }
    case "execute": {
      const cmd = String(data.command ?? data.cmd ?? "");
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    case "task":
      return String(data.description ?? data.task ?? data.name ?? "").slice(0, 80);
    default:
      return null;
  }
}

/** Extract a short summary from tool output for debug logging. */
function summarizeToolOutput(name: string, output: unknown): string | null {
  if (output === null || output === undefined) return null;

  // Stringify if needed
  let str: string;
  if (typeof output === "string") {
    str = output;
  } else {
    try { str = JSON.stringify(output); } catch { return null; }
  }

  // For ls/glob/grep — show entry count and first few entries
  if (name === "ls" || name === "glob" || name === "grep") {
    // Try to parse as JSON array or newline-separated list
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        const preview = parsed.slice(0, 3).join(", ");
        return `${parsed.length} results: ${preview}${parsed.length > 3 ? ", ..." : ""}`;
      }
    } catch { /* not JSON array */ }
    const lines = str.split("\n").filter(Boolean);
    if (lines.length > 1) {
      const preview = lines.slice(0, 3).join(", ");
      return `${lines.length} lines: ${preview}${lines.length > 3 ? ", ..." : ""}`;
    }
  }

  // For edit_file — show success/error status
  if (name === "edit_file") {
    // Common error patterns from deepagents edit_file
    if (str.includes("not found") || str.includes("No match") || str.includes("error") || str.includes("Error")) {
      return `ERROR: ${str.length > 150 ? str.slice(0, 147) + "..." : str}`;
    }
    return `OK (${str.length} chars)`;
  }

  // For task (sub-agent) — show truncated result
  if (name === "task") {
    return str.length > 120 ? str.slice(0, 117) + "..." : str;
  }

  // For read_file — show line count
  if (name === "read_file") {
    const lines = str.split("\n").length;
    return `${lines} lines`;
  }

  // Generic: show length
  if (str.length > 200) return `${str.length} chars`;
  return null;
}

// ============ State ============

let session: AgentSession | null = null;
let currentAbortController: AbortController | null = null;

// ============ Shared Callbacks ============

/** Build the standard streaming callback set for chat/resume. */
function createStreamCallbacks(signal: AbortSignal) {
  const toolStartTimes = new Map<string, number>();

  return {
    signal,
    onToken(token: string) {
      sendNotification("stream/token", { token });
    },
    onToolStart(name: string, input: unknown, stepTokens: number) {
      toolStartTimes.set(name, Date.now());
      // Log tool name + summarized input for debugging (e.g., ls path, glob pattern)
      const inputSummary = summarizeToolInput(name, input);
      debug("Tool start", { name, ...(inputSummary ? { input: inputSummary } : {}) });
      sendNotification("stream/toolStart", { name, input, stepTokens });
    },
    onToolEnd(name: string, output: unknown) {
      const startTime = toolStartTimes.get(name);
      const durationMs = startTime ? Date.now() - startTime : undefined;
      toolStartTimes.delete(name);
      const outputSummary = summarizeToolOutput(name, output);
      debug("Tool end", { name, durationMs, ...(outputSummary ? { output: outputSummary } : {}) });
      sendNotification("stream/toolEnd", { name, output, durationMs });
    },
    onPlanUpdate(todos: unknown) {
      sendNotification("stream/planUpdate", { todos });
    },
    onError(error: string) {
      debug("Stream error", { error });
      sendNotification("stream/error", { error });
    },
    onInterrupt(toolName: string, toolInput: unknown) {
      debug("HITL interrupt", { toolName });
      sendNotification("stream/interrupt", { toolName, toolInput });
    },
  };
}

// ============ Method Handlers ============

type MethodHandler = (id: number, params: Record<string, unknown>) => Promise<void>;

const methods: Record<string, MethodHandler> = {
  async initialize(id, params) {
    const apiKey = params.apiKey as string | undefined;
    const model = params.model as string | undefined;
    const projectPath = params.projectPath as string | undefined;
    const systemPrompt = params.systemPrompt as string | undefined;
    const maxTokens = params.maxTokens as number | undefined;
    const hitlEnabled = params.hitlEnabled as boolean | undefined;
    const spendingLimit = params.spendingLimit as number | undefined;

    if (!apiKey || !model || !projectPath) {
      sendError(id, RPC_INVALID_PARAMS, "Missing required params: apiKey, model, projectPath");
      return;
    }

    try {
      session = new AgentSession({
        apiKey,
        model,
        projectPath,
        systemPrompt,
        maxTokens,
        hitlEnabled,
        spendingLimit,
      });
      await session.initialize();
      sendResponse(id, { ok: true });
      debug("Agent initialized", { model, projectPath, hitlEnabled, spendingLimit });
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

    try {
      debug("Starting chat", { message: message.slice(0, 100) });
      await session.chat(message, createStreamCallbacks(signal));

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

  async resume(id, params) {
    const approved = params.approved as boolean | undefined;
    if (approved === undefined) {
      sendError(id, RPC_INVALID_PARAMS, "Missing required param: approved");
      return;
    }

    if (!session) {
      sendError(id, RPC_AGENT_ERROR, "Agent not initialized. Call initialize first.");
      return;
    }

    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    try {
      debug("Resuming after HITL", { approved });
      await session.resume(approved, createStreamCallbacks(signal));

      debug("Resume complete");
      sendNotification("stream/done", {});
      sendResponse(id, { ok: true });
    } catch (err) {
      if (signal.aborted) {
        sendError(id, RPC_CANCELLED, "Generation cancelled");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        sendError(id, RPC_AGENT_ERROR, `Resume error: ${message}`);
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
      await session.setModel(model);
      sendResponse(id, { ok: true });
      debug("Model changed", { model });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(id, RPC_AGENT_ERROR, `Failed to set model: ${message}`);
    }
  },

  async getTokenUsage(id) {
    if (!session) {
      sendError(id, RPC_AGENT_ERROR, "Agent not initialized.");
      return;
    }
    sendResponse(id, session.getTokenUsage());
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
