/**
 * Ship Studio AI Sidecar — Anthropic Agent SDK bridge.
 *
 * Thin Node.js layer that receives JSON-RPC 2.0 messages over stdin/stdout
 * and delegates to the Agent SDK's query() function. Claude Code handles
 * the agent loop, tools, context management, and compaction internally.
 *
 * @module sidecar
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import {
  parseMessage,
  sendResponse,
  sendError,
  sendNotification,
  debug,
  RPC_METHOD_NOT_FOUND,
  RPC_INTERNAL_ERROR,
  RPC_AGENT_ERROR,
} from "./rpc.js";
import { createGitMcpServer } from "./tools/git.js";

// ============ State ============

let sessionId: string | null = null;
let currentQuery: Query | null = null;
let projectPath: string | null = null;
let hitlEnabled = false;
let spendingLimit: number | undefined;

// HITL approval gate — when a tool needs permission, we pause iteration
// and wait for the resume RPC to resolve this promise.
type PermissionAllow = { behavior: "allow"; updatedInput: Record<string, unknown> };
type PermissionDeny = { behavior: "deny"; message: string };
let approvalResolver: ((result: PermissionAllow | PermissionDeny) => void) | null = null;
let pendingToolInput: Record<string, unknown> | null = null;

// Cumulative token totals across all queries in this session.
// Reset only on clearHistory. This prevents the frontend counter
// from dropping to 0 between user messages.
let cumulativeInput = 0;
let cumulativeOutput = 0;
let cumulativeCacheRead = 0;
let cumulativeCacheCreate = 0;
let cumulativeCostUsd = 0;

function waitForApproval(input: Record<string, unknown>): Promise<PermissionAllow | PermissionDeny> {
  pendingToolInput = input;
  return new Promise((resolve) => {
    approvalResolver = resolve;
  });
}

// ============ RPC Method Handlers ============

async function handleInitialize(id: number, params: Record<string, unknown>): Promise<void> {
  projectPath = params.projectPath as string;
  hitlEnabled = (params.hitlEnabled as boolean) ?? false;
  spendingLimit = (params.spendingLimit as number) ?? undefined;
  sessionId = null;

  debug("Initialized", {
    projectPath,
    hitlEnabled,
    spendingLimit,
    modelEnv: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "(not set)",
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? "(not set)",
  });
  sendResponse(id, { ok: true });
}

// ============ System Prompt & Project Context ============

/** Build a concise project context string from the project directory. */
function buildProjectContext(dir: string): string {
  const parts: string[] = [];

  // Detect framework from package.json
  try {
    const pkgRaw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    const allDeps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    const frameworks: string[] = [];
    if (allDeps["@sveltejs/kit"]) frameworks.push("SvelteKit");
    else if (allDeps["svelte"]) frameworks.push("Svelte");
    if (allDeps["next"]) frameworks.push("Next.js");
    if (allDeps["nuxt"]) frameworks.push("Nuxt");
    if (allDeps["react"]) frameworks.push("React");
    if (allDeps["vue"]) frameworks.push("Vue");
    if (allDeps["astro"]) frameworks.push("Astro");
    if (allDeps["tailwindcss"]) frameworks.push("Tailwind CSS");
    if (allDeps["typescript"]) frameworks.push("TypeScript");
    if (frameworks.length > 0) parts.push(`Tech stack: ${frameworks.join(", ")}`);
    if (pkg.name) parts.push(`Project: ${pkg.name}`);
  } catch {
    // No package.json — skip framework detection
  }

  // Shallow file tree (top-level + src/ if it exists)
  try {
    const topLevel = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== ".git")
      .map(e => e.isDirectory() ? `${e.name}/` : e.name)
      .slice(0, 25);
    if (topLevel.length > 0) parts.push(`Root files: ${topLevel.join(", ")}`);

    const srcDir = path.join(dir, "src");
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      const srcFiles = fs.readdirSync(srcDir, { withFileTypes: true })
        .map(e => e.isDirectory() ? `${e.name}/` : e.name)
        .slice(0, 20);
      if (srcFiles.length > 0) parts.push(`src/: ${srcFiles.join(", ")}`);
    }
  } catch {
    // Permission or read errors — skip
  }

  return parts.join("\n");
}

/** Behavioral rules appended to Claude Code's default system prompt. */
function buildAppendPrompt(dir: string): string {
  const context = buildProjectContext(dir);
  const contextBlock = context
    ? `\n\n# Project Context\n${context}`
    : "";

  return `
# Ship Studio Agent Rules

You are an AI coding agent inside Ship Studio, a desktop app for web developers.
The user is a web developer working on their project in a visual IDE with a live preview.

## Communication
- Be concise. Lead with the action or answer, not reasoning.
- Do NOT output code as text in chat. Always use Write, Edit, or Bash tools to modify files.
- After completing work, give a brief summary of what you did (not what you would do).
- Do NOT use filler phrases like "Sure!", "Let me help you with that", "I'd be happy to".
- When multiple files need changes, make all changes — don't stop after one file.

## File Operations
- Always use Write/Edit tools to create or modify files. Never output file contents as chat text.
- Use relative paths from the project root when possible.
- Read files before editing them to understand existing code.
- Prefer Edit over Write for existing files (less destructive).

## Tool Preferences
- ALWAYS prefer reading files (Read, Glob, Grep) over using browser/Playwright tools to understand a project.
- When asked about a site, page, or component: read the source code first. Only use browser tools if the user explicitly asks to see visual output or test runtime behavior.
- For questions about structure, styling, content, or code quality — file reading is sufficient. Do not launch a browser.
- Use Bash for running build commands, git operations, or scripts — not for viewing pages.

## Quality
- Match the existing code style, conventions, and patterns in the project.
- Don't add unnecessary comments, docstrings, or type annotations to code you didn't change.
- Keep changes minimal and focused on what was requested.${contextBlock}`;
}

async function handleChat(id: number, params: Record<string, unknown>, retryWithoutResume = false): Promise<void> {
  const message = params.message as string;
  if (!projectPath) {
    sendError(id, RPC_AGENT_ERROR, "Not initialized — call initialize first");
    return;
  }

  const abortController = new AbortController();
  const gitServer = createGitMcpServer(projectPath);

  try {
    // Read-only tools that never need user approval (skip canUseTool entirely)
    const autoApprovedTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"];

    const resolvedModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "claude-sonnet-4.6";
    // On retry, clear the session so we don't try to resume a dead process
    const useResume = !retryWithoutResume && sessionId ? sessionId : undefined;
    debug("Starting query", {
      model: "sonnet",
      resolvedModel,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      hasAuthToken: !!process.env.ANTHROPIC_AUTH_TOKEN,
      resumeSession: useResume ?? "(none)",
      isRetry: retryWithoutResume,
    });

    currentQuery = query({
      prompt: message,
      options: {
        // Use "sonnet" alias — resolved via ANTHROPIC_DEFAULT_SONNET_MODEL env var.
        // This lets the Rust backend route to any OpenRouter model.
        model: "sonnet",
        cwd: projectPath,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildAppendPrompt(projectPath),
        },
        // allowedTools = pre-approved tools (skip canUseTool callback).
        // When HITL is off, don't set allowedTools — bypassPermissions handles it.
        ...(hitlEnabled ? { allowedTools: autoApprovedTools } : {}),
        settingSources: ["project"],
        maxBudgetUsd: spendingLimit,
        permissionMode: hitlEnabled ? "default" : "bypassPermissions",
        ...(hitlEnabled ? {} : { allowDangerouslySkipPermissions: true }),
        ...(useResume ? { resume: useResume } : {}),
        mcpServers: { "ship-studio-git": gitServer },
        abortController,
        includePartialMessages: true,
        // Extended thinking only works with Anthropic models. For non-Anthropic
        // models via OpenRouter, omit the thinking option entirely.
        ...(resolvedModel.startsWith("claude") || resolvedModel.startsWith("anthropic/")
          ? { thinking: { type: "enabled" as const, budgetTokens: 2048 } }
          : {}),
        canUseTool: hitlEnabled
          ? async (toolName, input) => {
              const toolInput = input as Record<string, unknown>;

              // Auto-approve read-only tools (safety net for tools not in allowedTools)
              const readOnlyTools = new Set([
                "Read", "Glob", "Grep", "WebSearch", "WebFetch",
                "Agent",
                "git_status", "git_diff", "git_log",
              ]);
              if (readOnlyTools.has(toolName)) {
                return { behavior: "allow" as const, updatedInput: toolInput };
              }

              // Auto-approve MCP tools — analysis/linting tools from Claude Code's
              // MCP servers. They don't write files directly.
              if (toolName.startsWith("mcp__")) {
                return { behavior: "allow" as const, updatedInput: toolInput };
              }

              // Auto-approve internal Claude Code tools that don't write to filesystem
              const internalTools = new Set([
                "TodoWrite", "Skill", "AskUserQuestion",
                "EnterPlanMode", "ExitPlanMode",
              ]);
              if (internalTools.has(toolName)) {
                return { behavior: "allow" as const, updatedInput: toolInput };
              }

              // Destructive/write tools — pause and ask the user
              debug(`HITL interrupt: ${toolName}`, { input: typeof input === 'object' ? Object.keys(input as object) : input });
              sendNotification("stream/interrupt", {
                toolName,
                toolInput: input,
              });
              // Wait for the resume RPC to approve or deny
              return waitForApproval(input as Record<string, unknown>);
            }
          : undefined,
      },
    });

    // Track tool_use_id → tool_name so we can send proper names on toolEnd
    const toolUseIdToName = new Map<string, string>();

    // Per-query token deltas — accumulated into cumulative totals
    let queryInput = 0;
    let queryOutput = 0;
    let queryCacheRead = 0;
    let queryCacheCreate = 0;

    // Consume the async generator
    for await (const msg of currentQuery) {
      // System init message — capture session ID
      if (msg.type === "system" && "session_id" in msg) {
        sessionId = msg.session_id as string;
        debug("Session started", { sessionId });
        continue;
      }

      // Assistant message — stream text and tool use
      if (msg.type === "assistant") {
        const inner = (msg as any).message;
        const content = inner?.content;

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              sendNotification("stream/token", { token: block.text });
            }
            if (block.type === "tool_use") {
              // Remember the mapping for when the tool result comes back
              toolUseIdToName.set(block.id, block.name);
              debug(`Tool start: ${block.name}`, { toolUseId: block.id });
              sendNotification("stream/toolStart", {
                name: block.name,
                input: block.input,
                toolUseId: block.id,
              });
            }
          }
        }

        // Live token usage from per-message usage field
        const msgUsage = inner?.usage as {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        } | undefined;
        if (msgUsage) {
          queryInput += msgUsage.input_tokens ?? 0;
          queryOutput += msgUsage.output_tokens ?? 0;
          queryCacheRead += msgUsage.cache_read_input_tokens ?? 0;
          queryCacheCreate += msgUsage.cache_creation_input_tokens ?? 0;
          sendNotification("stream/tokenUsage", {
            inputTokens: cumulativeInput + queryInput,
            outputTokens: cumulativeOutput + queryOutput,
            cacheReadTokens: cumulativeCacheRead + queryCacheRead,
            cacheCreationTokens: cumulativeCacheCreate + queryCacheCreate,
          });
        }
      }

      // Tool result message — tool finished
      if (msg.type === "user") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const toolName = toolUseIdToName.get(block.tool_use_id) ?? block.tool_use_id;
              // Log error content for debugging HITL approval issues
              const errorDetail = block.is_error ? { errorContent: typeof block.content === 'string' ? block.content.slice(0, 200) : JSON.stringify(block.content)?.slice(0, 200) } : {};
              debug(`Tool end: ${toolName}`, { toolUseId: block.tool_use_id, isError: block.is_error, ...errorDetail });
              sendNotification("stream/toolEnd", {
                name: toolName,
                toolUseId: block.tool_use_id,
                output: block.content,
                isError: block.is_error ?? false,
              });
            }
          }
        }
      }

      // Result message — query complete with authoritative cost and token usage
      if (msg.type === "result") {
        const totalCost = (msg as any).total_cost_usd ?? 0;
        const resultUsage = (msg as any).usage as {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        } | undefined;

        // modelUsage gives per-model token breakdowns (camelCase keys)
        const modelUsage = (msg as any).modelUsage as Record<string, {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
        }> | undefined;

        // Sum up modelUsage across all models (most reliable source)
        let muInput = 0, muOutput = 0, muCacheRead = 0, muCacheCreate = 0;
        if (modelUsage) {
          for (const mu of Object.values(modelUsage)) {
            muInput += mu.inputTokens ?? 0;
            muOutput += mu.outputTokens ?? 0;
            muCacheRead += mu.cacheReadInputTokens ?? 0;
            muCacheCreate += mu.cacheCreationInputTokens ?? 0;
          }
        }

        // Prefer modelUsage, fall back to result.usage
        const finalInput = muInput || (resultUsage?.input_tokens ?? 0);
        const finalOutput = muOutput || (resultUsage?.output_tokens ?? 0);
        const finalCacheRead = muCacheRead || (resultUsage?.cache_read_input_tokens ?? 0);
        const finalCacheCreate = muCacheCreate || (resultUsage?.cache_creation_input_tokens ?? 0);

        // Accumulate into session-level cumulative totals
        cumulativeInput += finalInput;
        cumulativeOutput += finalOutput;
        cumulativeCacheRead += finalCacheRead;
        cumulativeCacheCreate += finalCacheCreate;
        cumulativeCostUsd += totalCost;

        // Send final authoritative usage with cost (cumulative across all queries)
        sendNotification("stream/tokenUsage", {
          inputTokens: cumulativeInput,
          outputTokens: cumulativeOutput,
          cacheReadTokens: cumulativeCacheRead,
          cacheCreationTokens: cumulativeCacheCreate,
          cumulativeCost: cumulativeCostUsd,
        });

        if ((msg as any).subtype === "success") {
          debug("Query complete", {
            totalCost,
            modelUsage: modelUsage ? Object.entries(modelUsage).map(([k, v]) => `${k}: ${v.inputTokens}in/${v.outputTokens}out`) : "none",
            resultUsage: resultUsage ? `${resultUsage.input_tokens}in/${resultUsage.output_tokens}out` : "none",
            final: `${finalInput}in/${finalOutput}out`,
          });
        }
        if ((msg as any).subtype === "error") {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
          const errorText = String((msg as any).error ?? "Agent returned an error");
          debug("Query error", { error: errorText, totalCost });

          // Detect budget exceeded — Agent SDK returns this when maxBudgetUsd is hit
          const isBudgetError = /budget|spend|cost.*limit/i.test(errorText);
          if (isBudgetError && spendingLimit) {
            sendNotification("stream/error", {
              message: `Spending limit reached ($${spendingLimit.toFixed(2)}). Increase your limit or start a new conversation.`,
            });
          } else {
            sendNotification("stream/error", {
              message: errorText,
            });
          }
        }
      }
    }

    sendNotification("stream/done", {});
    sendResponse(id, { ok: true });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (abortController.signal.aborted) {
      sendNotification("stream/done", { cancelled: true });
      sendResponse(id, { ok: true, cancelled: true });
    } else {
      // Auto-recovery: if the Claude Code process crashed during a session
      // resume (common with non-Anthropic models via OpenRouter), clear the
      // session and retry once without resume.
      const isProcessCrash = /exited with code|process.*exit/i.test(errorMsg);
      if (isProcessCrash && sessionId && !retryWithoutResume) {
        debug("Process crashed during resume — retrying without session", { error: errorMsg });
        sessionId = null;
        currentQuery = null;
        return handleChat(id, params, true);
      }
      debug("Chat error", errorMsg);
      sendNotification("stream/error", { message: errorMsg });
      sendError(id, RPC_AGENT_ERROR, errorMsg);
    }
  } finally {
    currentQuery = null;
  }
}

async function handleResume(id: number, params: Record<string, unknown>): Promise<void> {
  const approved = params.approved as boolean;
  debug(`Resume received`, { approved, hasResolver: !!approvalResolver, hasInput: !!pendingToolInput });
  if (approvalResolver) {
    if (approved) {
      debug("Resolving approval: ALLOW (with updatedInput)");
      approvalResolver({ behavior: "allow", updatedInput: pendingToolInput ?? {} });
    } else {
      debug("Resolving approval: DENY");
      approvalResolver({ behavior: "deny", message: "User denied the tool call" });
    }
    approvalResolver = null;
    pendingToolInput = null;
  } else {
    debug("WARNING: No approval resolver found — resume ignored");
  }
  sendResponse(id, { ok: true });
}

async function handleCancel(id: number): Promise<void> {
  if (currentQuery) {
    try {
      currentQuery.close();
    } catch {
      // Ignore errors from closing
    }
    currentQuery = null;
  }
  // Also resolve any pending HITL approval so the generator can exit
  if (approvalResolver) {
    approvalResolver({ behavior: "deny", message: "Cancelled" });
    approvalResolver = null;
  }
  sendResponse(id, { ok: true });
}

async function handleClearHistory(id: number): Promise<void> {
  sessionId = null;
  cumulativeInput = 0;
  cumulativeOutput = 0;
  cumulativeCacheRead = 0;
  cumulativeCacheCreate = 0;
  cumulativeCostUsd = 0;
  debug("Session cleared");
  sendResponse(id, { ok: true });
}

async function handleHealthCheck(id: number): Promise<void> {
  sendResponse(id, { ok: true, sessionId });
}

// ============ Main RPC Loop ============

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const request = parseMessage(line);
  if (!request) return;

  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        await handleInitialize(id, params);
        break;
      case "chat":
        await handleChat(id, params);
        break;
      case "resume":
        await handleResume(id, params);
        break;
      case "cancel":
        await handleCancel(id);
        break;
      case "clearHistory":
        await handleClearHistory(id);
        break;
      case "healthCheck":
        await handleHealthCheck(id);
        break;
      default:
        sendError(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    debug(`RPC handler error for ${method}`, errorMsg);
    sendError(id, RPC_INTERNAL_ERROR, errorMsg);
  }
});

// Signal readiness
sendNotification("ready", {});
debug("Sidecar started (Anthropic Agent SDK)");
