/**
 * Deep Agent session management.
 *
 * Creates and manages a deepagents instance configured with OpenRouter
 * and project-scoped tools. Uses smart model routing:
 *   - Main orchestrator: GLM-4.7 (strong reasoning + agent execution)
 *   - Explorer sub-agent: GLM-4.7 Flash (cheap, fast codebase search)
 *   - Coder sub-agent: MiMo-V2-Flash (SWE-bench #1, writes code)
 *   - Tester sub-agent: MiniMax M2.1 (lightweight, runs/fixes tests)
 *
 * @module agent
 */

import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent, LocalShellBackend } from "deepagents";
import { debug } from "./rpc.js";
import { createGitTools } from "./tools/git.js";

// ============ Types ============

export interface AgentSessionOptions {
  apiKey: string;
  model: string;
  projectPath: string;
  systemPrompt?: string;
}

export interface ChatCallbacks {
  signal: AbortSignal;
  onToken: (token: string) => void;
  onToolStart: (name: string, input: unknown) => void;
  onToolEnd: (name: string, output: unknown) => void;
  onPlanUpdate: (todos: unknown) => void;
  onError: (error: string) => void;
}

// ============ Model Routing ============

/** Sub-agent model assignments — specialized models for each role. */
const SUB_AGENT_MODELS = {
  explorer: "z-ai/glm-4.7-flash",
  coder: "xiaomi/mimo-v2-flash",
  tester: "minimax/minimax-m2.1",
} as const;

// ============ System Prompt ============

/** Sentinel model ID — when received, use smart routing instead of a single model. */
const TUNED_MODEL_ID = "tuned";

/** Default orchestrator model for tuned routing mode. */
const TUNED_ORCHESTRATOR = "z-ai/glm-4.7";

const DEFAULT_SYSTEM_PROMPT = `You are an expert coding assistant running inside Ship Studio, a desktop app for web developers. You help users build, debug, and improve their web projects.

## Communication Style
- Be direct and concise. No filler phrases ("Great question!", "I'd be happy to help!", "Absolutely!").
- Don't use emojis unless the user uses them first.
- Don't start responses with "Sure!", "Of course!", or similar. Just do the thing.
- Explain what you're doing, not how excited you are to do it.
- Don't add unnecessary caveats or disclaimers.
- Write like a senior engineer talking to a peer, not a chatbot.

## Capabilities
- Read, write, and edit files in the project directory
- Execute shell commands (npm, git, build tools, etc.)
- Search files with glob and grep patterns
- Plan complex tasks with a todo list
- Delegate to specialized sub-agents:
  - **explorer**: Fast codebase search and research
  - **coder**: Writing and editing code
  - **tester**: Running and fixing tests

## Guidelines
- Always read files before modifying them
- Prefer editing existing files over creating new ones
- Run tests after making changes when test scripts exist
- Use git to track changes (commit after completing tasks)
- Keep changes focused and minimal — don't over-engineer
- Explain what you're doing and why
- If unsure, ask the user before making destructive changes
- Delegate complex sub-tasks to the appropriate sub-agent

## Critical: edit_file Whitespace Rules
When using edit_file, the \`old_string\` must EXACTLY match the file content byte-for-byte:
- Copy the exact indentation from read_file output — count tabs carefully
- If the file uses tabs, use the same number of tabs (do NOT convert to spaces)
- If the file uses spaces, use the same number of spaces
- When in doubt, use write_file to replace the entire file instead of edit_file
- If edit_file fails with "String not found", re-read the file and try again with exact whitespace

## Project Context
Working directory: {{PROJECT_PATH}}
`;

// ============ Helpers ============

/** Timeout (ms) for waiting between events during streaming. */
const EVENT_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Wraps an async iterable so that each `.next()` call is raced against a
 * timeout. If no event arrives within `timeoutMs`, yields a sentinel
 * `{ __timeout: true }` event so the caller can decide what to do.
 */
async function* withTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
): AsyncGenerator<T | { __timeout: true }> {
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: { __timeout: true } }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: { __timeout: true } }), timeoutMs),
      ),
    ]);
    if ("__timeout" in (result.value ?? {})) {
      yield { __timeout: true };
      return;
    }
    if (result.done) return;
    yield result.value as T;
  }
}

// ============ Session ============

export class AgentSession {
  private options: AgentSessionOptions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private agent: any = null;
  private model: ChatOpenAI;
  private history: Array<{ role: string; content: string }> = [];

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.model = this.createModel(options.model, options.apiKey);
  }

  private createModel(modelName: string, apiKey: string): ChatOpenAI {
    return new ChatOpenAI({
      model: modelName,
      configuration: {
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
      },
      streaming: true,
      temperature: 0,
      maxTokens: 4096,
    });
  }

  async initialize(): Promise<void> {
    const isTuned = this.options.model === TUNED_MODEL_ID;
    const orchestratorModelId = isTuned ? TUNED_ORCHESTRATOR : this.options.model;

    // Update the model instance for the orchestrator
    this.model = this.createModel(orchestratorModelId, this.options.apiKey);

    const systemPrompt = (this.options.systemPrompt || DEFAULT_SYSTEM_PROMPT)
      .replace("{{PROJECT_PATH}}", this.options.projectPath);

    // LocalShellBackend provides built-in tools via deepagents middleware:
    // read_file, write_file, edit_file, ls, glob, grep, execute (shell)
    const backend = await LocalShellBackend.create({
      rootDir: this.options.projectPath,
      inheritEnv: true,
      timeout: 30,
    });

    // Git tools are additional convenience tools on top of the built-in ones
    const gitTools = createGitTools(this.options.projectPath);

    // Sub-agent models: tuned mode uses specialized models per role,
    // unified mode uses the same model for everything.
    const explorerModel = this.createModel(
      isTuned ? SUB_AGENT_MODELS.explorer : this.options.model,
      this.options.apiKey,
    );
    const coderModel = this.createModel(
      isTuned ? SUB_AGENT_MODELS.coder : this.options.model,
      this.options.apiKey,
    );
    const testerModel = this.createModel(
      isTuned ? SUB_AGENT_MODELS.tester : this.options.model,
      this.options.apiKey,
    );

    try {
      // Use `as any` to bypass excessively deep type instantiation
      // from LangChain's heavily generic types. Runtime types are correct.
      this.agent = createDeepAgent({
        model: this.model as any,
        systemPrompt,
        backend,
        tools: gitTools as any[],
        subagents: [
          {
            name: "explorer",
            description:
              "Fast codebase explorer for searching files, reading code, and researching patterns. " +
              "Use when you need to understand code structure, find specific files, or gather context " +
              "before making changes. Cheap and fast — use liberally for exploration.",
            systemPrompt:
              "You are a codebase explorer. Your job is to quickly search, read, and understand code. " +
              "Use glob, grep, and read_file extensively. Summarize your findings concisely for the main agent. " +
              `Working directory: ${this.options.projectPath}`,
            model: explorerModel as any,
          },
          {
            name: "coder",
            description:
              "Expert code writer and editor. Use for writing new code, editing existing files, " +
              "implementing features, and fixing bugs. Specialized in producing correct, clean code.",
            systemPrompt:
              "You are an expert code writer. Write clean, correct, minimal code. " +
              "Always read files before editing them. Use edit_file for surgical changes, " +
              "write_file for new files. Follow existing patterns in the codebase. " +
              `Working directory: ${this.options.projectPath}`,
            model: coderModel as any,
          },
          {
            name: "tester",
            description:
              "Test runner and fixer. Use for running test suites, analyzing failures, " +
              "and fixing broken tests. Also good for running build commands and linters.",
            systemPrompt:
              "You are a testing specialist. Run tests, analyze failures, and fix them. " +
              "Use the execute tool to run test commands (npm test, vitest, jest, etc.). " +
              "Read test files and source files to understand failures. Fix issues surgically. " +
              `Working directory: ${this.options.projectPath}`,
            model: testerModel as any,
          },
        ] as any[],
      });
      debug("Deep agent created successfully", {
        mode: isTuned ? "tuned" : "unified",
        orchestrator: orchestratorModelId,
        subAgents: isTuned ? SUB_AGENT_MODELS : { all: this.options.model },
      });
    } catch (err) {
      debug("Failed to create deep agent", { error: String(err) });
      throw err;
    }
  }

  async chat(message: string, callbacks: ChatCallbacks): Promise<void> {
    if (!this.agent) {
      throw new Error("Agent not initialized");
    }

    this.history.push({ role: "user", content: message });

    try {
      // Use streamEvents("v2") to get granular token/tool events.
      // agent.stream() only returns LangGraph state updates (node-level chunks),
      // NOT individual streaming events — so tokens/tool calls would never appear.
      const eventStream = this.agent.streamEvents(
        { messages: this.history.map(m => ({ role: m.role, content: m.content })) },
        { signal: callbacks.signal, version: "v2" },
      );

      let assistantContent = "";

      for await (const event of withTimeout(eventStream, EVENT_TIMEOUT_MS)) {
        if (callbacks.signal.aborted) break;

        // Check for inactivity timeout
        if (typeof event === "object" && event !== null && "__timeout" in event) {
          callbacks.onError("Model response timed out (no activity for 2 minutes). Try sending your message again.");
          debug("Chat timed out — no events for 2 minutes");
          break;
        }

        const evt = event as Record<string, unknown>;
        const eventType = evt.event as string | undefined;

        // Token streaming from the LLM
        if (eventType === "on_chat_model_stream") {
          const data = evt.data as Record<string, unknown> | undefined;
          const chunk = data?.chunk as Record<string, unknown> | undefined;
          if (chunk) {
            // AIMessageChunk.content can be a string or array of content blocks
            const content = chunk.content;
            let token = "";
            if (typeof content === "string") {
              token = content;
            } else if (Array.isArray(content)) {
              // Extract text from content blocks (e.g., [{ type: "text", text: "..." }])
              for (const block of content) {
                if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
                  token += ((block as Record<string, unknown>).text as string) || "";
                }
              }
            }
            if (token) {
              assistantContent += token;
              callbacks.onToken(token);
            }
          }
        }

        // Tool execution start
        if (eventType === "on_tool_start") {
          callbacks.onToolStart(
            (evt.name ?? "unknown") as string,
            (evt.data as Record<string, unknown>)?.input ?? {},
          );
        }

        // Tool execution end
        if (eventType === "on_tool_end") {
          callbacks.onToolEnd(
            (evt.name ?? "unknown") as string,
            (evt.data as Record<string, unknown>)?.output ?? {},
          );
        }

        // Custom events (plan updates from todo middleware)
        if (eventType === "on_custom_event" && evt.name === "plan_update") {
          callbacks.onPlanUpdate(evt.data);
        }
      }

      // Store assistant response in history
      if (assistantContent) {
        this.history.push({ role: "assistant", content: assistantContent });
      }
    } catch (err) {
      if (callbacks.signal.aborted) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      callbacks.onError(errMsg);
      debug("Chat error", { error: errMsg });
      throw err;
    }
  }

  clearHistory(): void {
    this.history = [];
    debug("Chat history cleared");
  }

  setModel(modelName: string): void {
    this.options.model = modelName;
    // Reinitialize agent with new model (handles tuned vs unified routing)
    if (this.agent) {
      void this.initialize();
    }
    debug("Model updated", { model: modelName });
  }
}
