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

import * as fs from "node:fs";
import * as path from "node:path";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createDeepAgent, LocalShellBackend } from "deepagents";
import { debug, sendNotification } from "./rpc.js";
import { createGitTools } from "./tools/git.js";

// ============ Types ============

export interface AgentSessionOptions {
  apiKey: string;
  model: string;
  projectPath: string;
  systemPrompt?: string;
  maxTokens?: number;
  hitlEnabled?: boolean;
  spendingLimit?: number;
}

export interface ChatCallbacks {
  signal: AbortSignal;
  onToken: (token: string) => void;
  onToolStart: (name: string, input: unknown, stepTokens: number) => void;
  onToolEnd: (name: string, output: unknown) => void;
  onPlanUpdate: (todos: unknown) => void;
  onError: (error: string) => void;
  onInterrupt: (toolName: string, toolInput: unknown) => void;
}

export interface TokenUsage {
  input: number;
  output: number;
}

// ============ Model Configuration ============

/** Sub-agent model assignments — specialized models for each role. */
const SUB_AGENT_MODELS = {
  explorer: "z-ai/glm-4.7-flash",
  coder: "xiaomi/mimo-v2-flash",
  tester: "minimax/minimax-m2.1",
} as const;

/** Sentinel model ID — when received, use smart routing instead of a single model. */
const TUNED_MODEL_ID = "tuned";
/** Sentinel model ID for Google-tuned routing mode. */
const GOOGLE_TUNED_MODEL_ID = "google-tuned";
/** Sentinel model ID for Claude-tuned routing mode. */
const CLAUDE_TUNED_MODEL_ID = "claude-tuned";

/** Default orchestrator model for tuned routing mode. */
const TUNED_ORCHESTRATOR = "minimax/minimax-m2.5";

/** Google sub-agent model assignments. */
const GOOGLE_SUB_AGENT_MODELS = {
  orchestrator: "google/gemini-3-flash-preview",
  explorer: "google/gemini-3.1-flash-lite-preview",
  coder: "google/gemini-3.1-flash-lite-preview",
  tester: "google/gemini-3.1-flash-lite-preview",
} as const;

/** Claude sub-agent model assignments. */
const CLAUDE_SUB_AGENT_MODELS = {
  orchestrator: "anthropic/claude-opus-4.6",
  explorer: "anthropic/claude-sonnet-4.6",
  coder: "anthropic/claude-sonnet-4.6",
  tester: "anthropic/claude-sonnet-4.6",
} as const;

/** Pricing per 1M tokens (USD) for cost tracking. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "z-ai/glm-4.7": { input: 0.30, output: 1.40 },
  "z-ai/glm-4.7-flash": { input: 0.06, output: 0.40 },
  "xiaomi/mimo-v2-flash": { input: 0.09, output: 0.29 },
  "deepseek/deepseek-v3.2": { input: 0.30, output: 0.88 },
  "minimax/minimax-m2.5": { input: 0.50, output: 1.10 },
  "minimax/minimax-m2.1": { input: 0.28, output: 1.20 },
  "google/gemini-3-flash-preview": { input: 0.15, output: 0.60 },
  "google/gemini-3.1-flash-lite-preview": { input: 0.25, output: 1.50 },
  "anthropic/claude-opus-4.6": { input: 5.00, output: 25.00 },
  "anthropic/claude-sonnet-4.6": { input: 3.00, output: 15.00 },
};

/** Tools that require user approval when HITL is enabled. */
const DESTRUCTIVE_TOOLS = ["write_file", "edit_file", "execute", "git_commit"];

/** Max history messages before compaction triggers. */
const MAX_HISTORY_MESSAGES = 20;
/** Number of recent messages to keep after compaction. */
const KEEP_RECENT_MESSAGES = 10;

/** Max consecutive calls to the same tool before circuit breaker trips. */
const MAX_CONSECUTIVE_SAME_TOOL = 10;
/** Max times the same tool can return the same output (even non-consecutively). */
const MAX_REPEATED_OUTPUTS = 5;

// ============ Project Scanning ============

/** Directories to skip during project scan. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".svelte-kit", ".next",
  ".nuxt", ".output", ".vercel", ".turbo", "__pycache__", ".cache",
  "coverage", ".shipstudio", ".DS_Store",
]);

/** Detect project framework from dependencies. */
function detectFramework(deps: Record<string, string>): string {
  if ("@sveltejs/kit" in deps) return "SvelteKit";
  if ("svelte" in deps) return "Svelte";
  if ("next" in deps) return "Next.js";
  if ("nuxt" in deps) return "Nuxt";
  if ("astro" in deps) return "Astro";
  if ("react" in deps) return "React";
  if ("vue" in deps) return "Vue";
  if ("express" in deps) return "Express";
  return "Node.js";
}

/** Build a concise file tree string (depth-limited, filtered). */
function buildFileTree(rootDir: string, maxDepth: number, maxEntries: number): string[] {
  const result: string[] = [];

  function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth || result.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (result.length >= maxEntries) break;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        result.push(`${prefix}${entry.name}/`);
        walk(path.join(dir, entry.name), prefix + "  ", depth + 1);
      } else {
        result.push(`${prefix}${entry.name}`);
      }
    }
  }

  walk(rootDir, "", 0);
  return result;
}

/** Scan project directory and return concise context for the system prompt. */
function scanProjectContext(projectPath: string): string {
  const sections: string[] = [];

  // package.json → framework, scripts, dependencies
  try {
    const raw = fs.readFileSync(path.join(projectPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const framework = detectFramework(allDeps);
    const scripts = Object.keys(pkg.scripts || {}).join(", ");
    sections.push(
      `Framework: ${framework}`,
      `Scripts: ${scripts}`,
      `Key dependencies: ${Object.keys(allDeps).sort().join(", ")}`,
    );
  } catch { /* no package.json */ }

  // File tree (depth 3, max 100 entries)
  const tree = buildFileTree(projectPath, 3, 100);
  if (tree.length > 0) {
    sections.push(`\nProject files:\n${tree.join("\n")}`);
  }

  return sections.join("\n");
}

// ============ System Prompt ============

const DEFAULT_SYSTEM_PROMPT = `You are an expert coding assistant inside Ship Studio, a desktop app for building web projects.

## Communication Rules
- Talk TO the user, not to yourself. Never narrate your internal process.
- NO thinking aloud: never write "Let me think...", "I'll start by...", "First I need to...", "Looking at the code...".
- NO filler: never write "Sure!", "Of course!", "Great question!".
- Keep text responses SHORT — 2-3 sentences max for status updates, 1 paragraph max for explanations.
- No emojis.

## How to Handle Requests
- **Questions** ("how can we improve X?"): Answer with 2-4 specific suggestions. Do NOT make changes until the user picks one.
- **Actions** ("add a contact form"): State what you'll do in ONE sentence, then do it. No step-by-step narration.
- **Broad/vague actions** ("add micro interactions", "make it better"): Pick the 2-3 highest-impact changes. Tell the user what you chose and why in 1-2 sentences, then do it. Do NOT try to change everything.

## Workflow
- Delegate ALL code changes to the coder sub-agent. Don't manually call read_file + edit_file yourself.
- NEVER output code in your text response. The user cannot copy/paste from chat. All code must be written to files via sub-agents.
- If you need to show the user what changed, describe it in words — don't paste the code.
- Minimize tool calls. Prefer glob patterns over multiple ls calls.

## After Completing Work
Write a brief summary (2-4 lines):
- What changed (file paths)
- What the changes do
- Anything remaining

## edit_file Safety
If edit_file fails with "String not found" twice on the same file, STOP and use write_file to replace the entire file instead. Never retry edit_file more than 2 times per file.

## File Paths
CRITICAL: ALWAYS use RELATIVE paths from the project root for ALL file operations (read_file, write_file, edit_file, glob, grep). For example, use "app/page.tsx" NOT "/Users/.../app/page.tsx". Absolute paths will fail.

## Project Context
Working directory: {{PROJECT_PATH}}

{{PROJECT_CONTEXT}}
`;

// ============ Helpers ============

/** Timeout (ms) for waiting between events during streaming.
 * Users run long sessions (like Claude Code), so this must be generous.
 * 5 minutes handles slow model responses and complex multi-step reasoning. */
const EVENT_TIMEOUT_MS = 300_000; // 5 minutes

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

/** Compute estimated cost in USD from token counts and model. */
function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? { input: 0.50, output: 1.50 };
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/** Ensure .shipstudio directory and AGENTS.md exist in the project. */
function ensureMemoryFile(projectPath: string): string {
  const shipStudioDir = path.join(projectPath, ".shipstudio");
  const agentsPath = path.join(shipStudioDir, "AGENTS.md");

  if (!fs.existsSync(shipStudioDir)) {
    fs.mkdirSync(shipStudioDir, { recursive: true });
  }

  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(
      agentsPath,
      "# Project Memory\n\nThis file is maintained by the Ship Studio AI agent.\nIt stores project context, patterns, and decisions that persist across sessions.\n",
      "utf-8",
    );
  }

  return agentsPath;
}

// ============ Session ============

export class AgentSession {
  private options: AgentSessionOptions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private agent: any = null;
  private model: ChatOpenRouter;
  private history: Array<{ role: string; content: string }> = [];
  private cumulativeTokens: TokenUsage = { input: 0, output: 0 };
  private cumulativeCost = 0;
  /** Tokens from the most recent LLM call — included with tool starts for UI display. */
  private lastStepTokens = 0;

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.model = this.createModel(options.model, options.apiKey);
  }

  private createModel(modelName: string, apiKey: string): ChatOpenRouter {
    return new ChatOpenRouter({
      model: modelName,
      apiKey,
      temperature: 0,
      streamUsage: true,
    });
  }

  async initialize(): Promise<void> {
    const isTuned = this.options.model === TUNED_MODEL_ID;
    const isGoogleTuned = this.options.model === GOOGLE_TUNED_MODEL_ID;
    const isClaudeTuned = this.options.model === CLAUDE_TUNED_MODEL_ID;
    const isRouted = isTuned || isGoogleTuned || isClaudeTuned;

    const orchestratorModelId = isClaudeTuned
      ? CLAUDE_SUB_AGENT_MODELS.orchestrator
      : isGoogleTuned
        ? GOOGLE_SUB_AGENT_MODELS.orchestrator
        : isTuned
          ? TUNED_ORCHESTRATOR
          : this.options.model;

    // Update the model instance for the orchestrator
    this.model = this.createModel(orchestratorModelId, this.options.apiKey);

    // Scan project upfront so the agent starts with context
    const projectContext = scanProjectContext(this.options.projectPath);
    debug("Project context scanned", { length: projectContext.length });

    const systemPrompt = (this.options.systemPrompt || DEFAULT_SYSTEM_PROMPT)
      .replace("{{PROJECT_PATH}}", this.options.projectPath)
      .replace("{{PROJECT_CONTEXT}}", projectContext);

    // Log the system prompt we're passing (before middleware adds its sections)
    debug("=== OUR SYSTEM PROMPT ===\n" + systemPrompt + "\n=== END SYSTEM PROMPT ===");

    // LocalShellBackend provides built-in tools via deepagents middleware:
    // read_file, write_file, edit_file, ls, glob, grep, execute (shell)
    const backend = await LocalShellBackend.create({
      rootDir: this.options.projectPath,
      inheritEnv: true,
      timeout: 30,
      virtualMode: true, // Restrict file ops to project directory
    });

    // Git tools are additional convenience tools on top of the built-in ones
    const gitTools = createGitTools(this.options.projectPath);

    // Ensure memory file exists and get its path
    const agentsMemoryPath = ensureMemoryFile(this.options.projectPath);
    const relativeMemoryPath = path.relative(this.options.projectPath, agentsMemoryPath);

    // Sub-agent models: routed modes use specialized models per role,
    // unified mode uses the same model for everything.
    const explorerModel = this.createModel(
      isClaudeTuned ? CLAUDE_SUB_AGENT_MODELS.explorer
        : isGoogleTuned ? GOOGLE_SUB_AGENT_MODELS.explorer
        : isTuned ? SUB_AGENT_MODELS.explorer
        : this.options.model,
      this.options.apiKey,
    );
    const coderModel = this.createModel(
      isClaudeTuned ? CLAUDE_SUB_AGENT_MODELS.coder
        : isGoogleTuned ? GOOGLE_SUB_AGENT_MODELS.coder
        : isTuned ? SUB_AGENT_MODELS.coder
        : this.options.model,
      this.options.apiKey,
    );
    const testerModel = this.createModel(
      isClaudeTuned ? CLAUDE_SUB_AGENT_MODELS.tester
        : isGoogleTuned ? GOOGLE_SUB_AGENT_MODELS.tester
        : isTuned ? SUB_AGENT_MODELS.tester
        : this.options.model,
      this.options.apiKey,
    );

    // Build sub-agent context suffix (project structure so they don't need to explore)
    const subAgentContext = projectContext
      ? `\n\nProject context (pre-scanned, no need to explore):\n${projectContext}`
      : "";

    // HITL: build interruptOn config for destructive tools
    const interruptOn = this.options.hitlEnabled
      ? Object.fromEntries(DESTRUCTIVE_TOOLS.map((t) => [t, true]))
      : undefined;

    try {
      // Use `as any` to bypass excessively deep type instantiation
      // from LangChain's heavily generic types. Runtime types are correct.
      // Note: deepagents includes SummarizationMiddleware by default —
      // it auto-compresses context when it grows too large (based on model profile).
      // Our manual compactHistory() handles the messages we pass between calls.
      // Note: deepagents always adds a built-in "general-purpose" sub-agent alongside our
      // custom ones. The generalPurposeAgent option is not exposed via CreateDeepAgentParams
      // (hardcoded to true internally). Our custom sub-agents still take priority when their
      // descriptions match the task, but the orchestrator has a 4th option it can delegate to.
      this.agent = createDeepAgent({
        model: this.model as any,
        systemPrompt,
        backend,
        tools: gitTools as any[],
        memory: [relativeMemoryPath],
        ...(this.options.hitlEnabled ? { checkpointer: true } : {}),
        ...(interruptOn ? { interruptOn } : {}),
        subagents: [
          {
            name: "explorer",
            description:
              "PREFERRED for all codebase exploration. Use INSTEAD of manually calling ls, glob, grep, read_file yourself. " +
              "Give it a question like 'find the main page component and its layout structure' and it returns a concise summary. " +
              "One explorer call replaces 10+ manual tool calls. Use for: finding files, reading code, understanding structure, " +
              "checking dependencies, investigating bugs.",
            systemPrompt:
              "You are a fast codebase explorer. Your job: find files, read code, summarize what you find.\n\n" +
              "IMPORTANT RULES:\n" +
              "- ALWAYS use RELATIVE paths for all file operations (e.g. 'app/page.tsx', NOT absolute paths). Absolute paths WILL FAIL.\n" +
              "- The project structure is already provided below — use it to identify files to read.\n" +
              "- Use read_file to inspect specific files. Use grep to search for strings.\n" +
              "- Only use glob if you need files not visible in the provided tree.\n" +
              "- Do NOT use ls — the file tree is already provided.\n" +
              "- Total tool calls: aim for UNDER 8. read key files → summarize.\n\n" +
              "Return a concise summary (under 300 words): file paths, key patterns, and relevant code snippets. " +
              "Don't include full file contents.\n" +
              `Working directory: ${this.options.projectPath}` +
              subAgentContext,
            model: explorerModel as any,
          },
          {
            name: "coder",
            description:
              "PREFERRED for all code changes. Use INSTEAD of manually calling read_file + edit_file/write_file yourself. " +
              "Give it clear instructions like 'add a meeting locator section to src/routes/+page.svelte with a map and search form'. " +
              "It reads the files, writes the code, and handles whitespace/formatting correctly.",
            systemPrompt:
              "You are an expert code writer. Write clean, correct, minimal code.\n\n" +
              "CRITICAL: You MUST use write_file or edit_file tools to make ALL code changes. " +
              "NEVER output code in your text response — the user cannot copy/paste from chat. " +
              "Your text output should ONLY contain brief summaries of what you changed, not code.\n\n" +
              "RULES:\n" +
              "- ALWAYS use RELATIVE paths for all file operations (e.g. 'app/page.tsx', NOT absolute paths). Absolute paths WILL FAIL.\n" +
              "- read_file FIRST before editing any file.\n" +
              "- Use edit_file for small changes, write_file for new files or full rewrites.\n" +
              "- **edit_file failures**: If edit_file returns 'String not found', do NOT retry with the same old_string. " +
              "Either re-read the file and copy the EXACT text (including whitespace/tabs), or use write_file to replace the entire file. " +
              "NEVER call edit_file more than 2 times on the same file — use write_file instead.\n" +
              "- Match existing code style. Don't over-engineer.\n" +
              "- Do NOT use ls or glob — file paths are provided in your instructions and project context below.\n" +
              "- After writing, briefly state what you changed (file path + summary). Do NOT include code in your summary.\n" +
              `Working directory: ${this.options.projectPath}` +
              subAgentContext,
            model: coderModel as any,
          },
          {
            name: "tester",
            description:
              "PREFERRED for running tests, builds, linters, and dev servers. Use INSTEAD of manually calling execute yourself. " +
              "Give it instructions like 'run the dev build and check for errors' or 'run tests for the auth module'. " +
              "It runs commands, reads error output, and fixes issues.",
            systemPrompt:
              "You are a testing specialist. Run tests, builds, and linters using the execute tool. " +
              "Analyze failures, read relevant source files, and fix issues. " +
              "ALWAYS use RELATIVE paths for all file operations (e.g. 'app/page.tsx', NOT absolute paths). Absolute paths WILL FAIL. " +
              "Common commands: npm test, npm run build, npx tsc --noEmit, npm run lint. " +
              "Report results concisely: what passed, what failed, what you fixed. " +
              `Working directory: ${this.options.projectPath}` +
              subAgentContext,
            model: testerModel as any,
          },
        ] as any[],
      });
      debug("Deep agent created successfully", {
        mode: isClaudeTuned ? "claude-tuned" : isGoogleTuned ? "google-tuned" : isTuned ? "tuned" : "unified",
        orchestrator: orchestratorModelId,
        subAgents: isClaudeTuned ? CLAUDE_SUB_AGENT_MODELS
          : isGoogleTuned ? GOOGLE_SUB_AGENT_MODELS
          : isTuned ? SUB_AGENT_MODELS
          : { all: this.options.model },
        hitl: this.options.hitlEnabled ?? false,
        memory: relativeMemoryPath,
      });
    } catch (err) {
      debug("Failed to create deep agent", { error: String(err) });
      throw err;
    }
  }

  /**
   * Compact conversation history when it grows too long.
   * Summarizes old messages using a cheap model, keeps recent ones.
   */
  private async compactHistory(): Promise<void> {
    if (this.history.length <= MAX_HISTORY_MESSAGES) return;

    const recentMessages = this.history.slice(-KEEP_RECENT_MESSAGES);
    const oldMessages = this.history.slice(0, this.history.length - KEEP_RECENT_MESSAGES);

    debug("Compacting history", {
      total: this.history.length,
      dropping: oldMessages.length,
      keeping: recentMessages.length,
    });

    try {
      const summaryModel = this.createModel(
        SUB_AGENT_MODELS.explorer, // Always use cheapest model
        this.options.apiKey,
      );

      const conversationText = oldMessages
        .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
        .join("\n\n");

      const response = await summaryModel.invoke([
        {
          role: "user",
          content:
            "Summarize this conversation concisely (under 500 words). " +
            "Focus on: what the user asked for, what was built/changed, key decisions, " +
            "and current state of the work.\n\n" +
            conversationText,
        },
      ]);

      const summary =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

      this.history = [
        {
          role: "user",
          content: `[Context from earlier in this conversation]\n${summary}`,
        },
        {
          role: "assistant",
          content: "Got it — I have the context from our earlier conversation.",
        },
        ...recentMessages,
      ];

      debug("History compacted", { newLength: this.history.length });
    } catch (err) {
      // If summarization fails, just trim
      debug("Summarization failed, trimming history", { error: String(err) });
      this.history = recentMessages;
    }
  }

  async chat(message: string, callbacks: ChatCallbacks): Promise<void> {
    if (!this.agent) {
      throw new Error("Agent not initialized");
    }

    // Enforce spending limit before starting
    if (this.options.spendingLimit && this.cumulativeCost >= this.options.spendingLimit) {
      throw new Error(
        `Session spending limit of $${this.options.spendingLimit.toFixed(2)} reached. ` +
        `Clear chat to start a new session.`,
      );
    }

    this.history.push({ role: "user", content: message });

    // Compact history if it's grown too long (prevents context explosion between calls)
    await this.compactHistory();

    try {
      // Use streamEvents("v2") to get granular token/tool events.
      // agent.stream() only returns LangGraph state updates (node-level chunks),
      // NOT individual streaming events — so tokens/tool calls would never appear.
      debug("Starting streamEvents", { historyLength: this.history.length });
      const eventStream = this.agent.streamEvents(
        { messages: this.history.map(m => ({ role: m.role, content: m.content })) },
        { signal: callbacks.signal, version: "v2" },
      );

      let assistantContent = "";
      let eventCount = 0;
      let toolCallCount = 0;
      // Track file operations for synthetic summary when model produces no text
      const fileOps: { action: string; path: string }[] = [];
      // Circuit breaker: detect degenerate tool loops
      let lastToolName = "";
      let consecutiveToolCount = 0;
      // Repeated-output tracker: detect tools returning the same result (e.g., edit_file errors)
      const toolOutputCounts = new Map<string, number>();
      // Per-file edit_file failure tracker (catches loops faster than generic breaker)
      const editFileFailures = new Map<string, number>();
      // One-time flag to log the assembled system prompt (with middleware additions)
      let loggedSystemPrompt = false;

      for await (const event of withTimeout(eventStream, EVENT_TIMEOUT_MS)) {
        eventCount++;
        if (callbacks.signal.aborted) {
          debug("Chat aborted by signal", { eventCount });
          break;
        }

        // Check for inactivity timeout
        if (typeof event === "object" && event !== null && "__timeout" in event) {
          callbacks.onError("Model response timed out (no activity for 5 minutes). Try sending your message again.");
          debug("Chat timed out — no events for 5 minutes", { eventCount });
          break;
        }

        const evt = event as Record<string, unknown>;
        const eventType = evt.event as string | undefined;

        // Log the FULL assembled system prompt on the first model call
        // This shows our prompt + all middleware-injected sections (filesystem, execute, task, memory, etc.)
        if (!loggedSystemPrompt && eventType === "on_chat_model_start") {
          loggedSystemPrompt = true;
          try {
            const data = evt.data as Record<string, unknown> | undefined;
            const input = data?.input as Record<string, unknown> | undefined;
            const messages = input?.messages as unknown[] | undefined;

            // Dump raw structure keys so we can see what's actually there
            debug("on_chat_model_start structure", {
              dataKeys: data ? Object.keys(data) : "null",
              inputKeys: input ? Object.keys(input) : "null",
              messagesType: messages ? (Array.isArray(messages[0]) ? "nested-array" : typeof messages[0]) : "null",
              messagesLength: messages?.length ?? 0,
            });

            if (messages && messages.length > 0) {
              // Messages might be a flat array [SystemMsg, HumanMsg, ...] or nested [[SystemMsg, HumanMsg, ...]]
              let flatMessages = messages;
              if (Array.isArray(messages[0])) {
                flatMessages = messages[0] as unknown[];
              }

              // Extract content from each message, looking for system message
              let systemContent = "";
              for (let i = 0; i < Math.min(flatMessages.length, 3); i++) {
                const msg = flatMessages[i] as Record<string, unknown>;
                // LangChain messages can have content directly or in kwargs
                const kwargs = msg?.kwargs as Record<string, unknown> | undefined;
                const msgType = msg?.type ?? msg?.lc_id ?? kwargs?.type ?? "unknown";
                const rawContent = msg?.content ?? kwargs?.content;
                let text = "";
                if (typeof rawContent === "string") {
                  text = rawContent;
                } else if (Array.isArray(rawContent)) {
                  text = rawContent
                    .map((block: unknown) => {
                      if (typeof block === "string") return block;
                      if (typeof block === "object" && block !== null) {
                        return (block as Record<string, unknown>).text ?? "";
                      }
                      return "";
                    })
                    .join("\n");
                }

                debug(`Message[${i}] type=${String(msgType)}, contentLen=${text.length}, keys=${Object.keys(msg).join(",")}`);

                // System message is typically first (type "system" or id includes "SystemMessage")
                if (i === 0 && text.length > 0) {
                  systemContent = text;
                }
              }

              if (systemContent.length > 0) {
                const truncated = systemContent.length > 8000
                  ? systemContent.slice(0, 8000) + `\n... (truncated, ${systemContent.length} total chars)`
                  : systemContent;
                debug(`=== FULL ASSEMBLED SYSTEM PROMPT (with middleware) ===\n${truncated}\n=== END FULL SYSTEM PROMPT ===`);
              } else {
                debug("System prompt content was empty — may be in a different event structure");
              }
              debug(`System prompt stats`, {
                totalChars: systemContent.length,
                messageCount: flatMessages.length,
              });
            }
          } catch (e) {
            debug("Could not extract system prompt from on_chat_model_start", { error: String(e) });
          }
        }

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

        // Token usage from LLM responses (emitted at end of each model call)
        if (eventType === "on_chat_model_end") {
          const data = evt.data as Record<string, unknown> | undefined;
          const output = data?.output as Record<string, unknown> | undefined;

          // Try multiple paths to find usage metadata.
          // OpenRouter + LangChain can put token counts in different places:
          //   1. output.usage_metadata (standard LangChain path)
          //   2. output.response_metadata.usage (OpenRouter wraps here)
          //   3. data.usage_metadata (fallback)
          const rawUsage = output?.usage_metadata as Record<string, number> | undefined;
          const responseMetadata = (output as any)?.response_metadata as Record<string, unknown> | undefined;
          const rmUsage = responseMetadata?.usage as Record<string, number> | undefined;
          const fallbackUsage = (data as any)?.usage_metadata as Record<string, number> | undefined;

          // Pick the first non-empty source
          const isNonEmpty = (obj: Record<string, unknown> | undefined) =>
            obj && Object.keys(obj).length > 0;
          const usageMetadata = (
            isNonEmpty(rawUsage) ? rawUsage
            : isNonEmpty(rmUsage) ? rmUsage
            : isNonEmpty(fallbackUsage) ? fallbackUsage
            : undefined
          ) as Record<string, number> | undefined;

          if (usageMetadata) {
            const inputTokens = usageMetadata.input_tokens ?? usageMetadata.prompt_tokens ?? 0;
            const outputTokens = usageMetadata.output_tokens ?? usageMetadata.completion_tokens ?? 0;
            this.cumulativeTokens.input += inputTokens;
            this.cumulativeTokens.output += outputTokens;
            this.lastStepTokens = inputTokens + outputTokens;

            // Track cost
            const activeModel = (evt.name as string) || this.options.model;
            const messageCost = computeCost(activeModel, inputTokens, outputTokens);
            this.cumulativeCost += messageCost;

            sendNotification("stream/tokenUsage", {
              inputTokens,
              outputTokens,
              cumulativeInput: this.cumulativeTokens.input,
              cumulativeOutput: this.cumulativeTokens.output,
              cumulativeCost: this.cumulativeCost,
            });

            // Cost warning at 80% of spending limit
            if (
              this.options.spendingLimit &&
              this.cumulativeCost >= this.options.spendingLimit * 0.8
            ) {
              sendNotification("stream/costWarning", {
                currentCost: this.cumulativeCost,
                limit: this.options.spendingLimit,
                percentUsed: Math.round((this.cumulativeCost / this.options.spendingLimit) * 100),
              });
            }
          }
        }

        // Tool execution start
        if (eventType === "on_tool_start") {
          const toolName = (evt.name ?? "unknown") as string;
          const toolInput = (evt.data as Record<string, unknown>)?.input ?? {};
          toolCallCount++;

          // Circuit breaker: abort if same tool called too many times in a row
          if (toolName === lastToolName) {
            consecutiveToolCount++;
          } else {
            lastToolName = toolName;
            consecutiveToolCount = 1;
          }
          if (consecutiveToolCount >= MAX_CONSECUTIVE_SAME_TOOL) {
            const msg = `Stopped: "${toolName}" was called ${consecutiveToolCount} times in a row — likely stuck in a loop. Try rephrasing your request.`;
            debug("Consecutive-tool circuit breaker", { tool: toolName, count: consecutiveToolCount });
            callbacks.onError(msg);
            break;
          }

          // Log full tool input so we can see what the AI is requesting
          const inputStr = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput, null, 2);
          const truncatedInput = inputStr.length > 1500
            ? inputStr.slice(0, 1500) + `\n... (truncated, ${inputStr.length} total chars)`
            : inputStr;
          debug(`=== TOOL CALL: ${toolName} ===\n${truncatedInput}\n=== END CALL ===`);

          callbacks.onToolStart(toolName, toolInput, this.lastStepTokens);

          // Track file operations for synthetic summary
          if (toolName === "write_file" || toolName === "edit_file") {
            let parsed = toolInput;
            if (typeof parsed === "string") {
              try { parsed = JSON.parse(parsed); } catch { /* keep as-is */ }
            }
            const obj = (typeof parsed === "object" && parsed !== null) ? parsed as Record<string, unknown> : {};
            const filePath = String(obj.file_path ?? obj.path ?? obj.filePath ?? "unknown");
            const action = toolName === "write_file" ? "created/wrote" : "edited";
            // Deduplicate — only record each file+action once
            if (!fileOps.some(op => op.path === filePath && op.action === action)) {
              fileOps.push({ action, path: filePath });
            }
          }

          // write_todos → plan update (extract todos from tool input)
          if (toolName === "write_todos") {
            // Tool input may arrive as stringified JSON from the event stream
            let parsed = toolInput;
            if (typeof parsed === "string") {
              try { parsed = JSON.parse(parsed); } catch { /* keep as-is */ }
            }
            if (typeof parsed === "object" && parsed !== null) {
              const obj = parsed as Record<string, unknown>;
              callbacks.onPlanUpdate(obj.todos ?? obj);
            }
          }
        }

        // Tool execution end
        if (eventType === "on_tool_end") {
          const toolName = (evt.name ?? "unknown") as string;
          const toolOutput = (evt.data as Record<string, unknown>)?.output ?? {};
          const outputStr = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);

          // Log full tool output (truncated at 2000 chars) so we can see what the AI gets
          const truncatedOutput = outputStr.length > 2000
            ? outputStr.slice(0, 2000) + `\n... (truncated, ${outputStr.length} total chars)`
            : outputStr;
          debug(`=== TOOL OUTPUT: ${toolName} ===\n${truncatedOutput}\n=== END ${toolName} ===`);

          // === edit_file-specific circuit breaker ===
          // Track per-file edit_file failures. After 3 failures on the same file, abort.
          // This fires faster than the generic breaker and gives a clearer error.
          if (toolName === "edit_file" && outputStr.includes("String not found")) {
            // Extract file path from the error or from the tool input (last seen)
            const fileMatch = outputStr.match(/in file[:\s]*'?([^'"\n]+)/i);
            const fileKey = fileMatch?.[1] ?? "unknown-file";
            const failCount = (editFileFailures.get(fileKey) ?? 0) + 1;
            editFileFailures.set(fileKey, failCount);
            if (failCount >= 3) {
              const msg = `Stopped: edit_file failed ${failCount} times on the same file. The model couldn't match the file content. Try asking again with simpler instructions.`;
              debug("edit_file circuit breaker", { file: fileKey, failures: failCount });
              callbacks.onError(msg);
              break;
            }
          }

          // Generic repeated-output circuit breaker: hash tool name + output length
          const outputKey = `${toolName}:${outputStr.length}`;
          const count = (toolOutputCounts.get(outputKey) ?? 0) + 1;
          toolOutputCounts.set(outputKey, count);
          if (count >= MAX_REPEATED_OUTPUTS) {
            const msg = `Stopped: "${toolName}" kept returning the same result (${count} times) — likely stuck in a loop. Try rephrasing your request.`;
            debug("Repeated-output circuit breaker", { tool: toolName, count, outputPreview: outputStr.slice(0, 200) });
            callbacks.onError(msg);
            break;
          }

          callbacks.onToolEnd(toolName, toolOutput);
        }

        // Custom events (plan updates — fallback for non-tool plan events)
        if (eventType === "on_custom_event" && evt.name === "plan_update") {
          callbacks.onPlanUpdate(evt.data);
        }

        // HITL interrupt — agent paused waiting for approval
        if (eventType === "on_custom_event" && evt.name === "__interrupt") {
          const data = evt.data as Record<string, unknown> | undefined;
          callbacks.onInterrupt(
            (data?.tool_name as string) ?? "unknown",
            data?.tool_input ?? {},
          );
        }
      }

      debug("Event loop exited", { eventCount, contentLength: assistantContent.length, toolCallCount });

      // If the model made tool calls but produced no text summary, emit a synthetic summary.
      // This happens with Gemini models that stop after tool calls without summarizing.
      if (assistantContent.length === 0 && toolCallCount > 0 && !callbacks.signal.aborted) {
        debug("No text output after tool calls — emitting synthetic summary", { fileOps: fileOps.length });

        let summary = "";
        if (fileOps.length > 0) {
          summary = "Done. Changes made:\n";
          for (const op of fileOps) {
            summary += `- ${op.action} \`${op.path}\`\n`;
          }
        } else {
          summary = "Done. Task completed.";
        }

        // Stream the synthetic summary as tokens so the UI displays it
        assistantContent = summary;
        callbacks.onToken(summary);
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

  /**
   * Resume after a HITL interrupt. Sends approval/rejection to the agent
   * and continues streaming the response.
   */
  async resume(approved: boolean, callbacks: ChatCallbacks): Promise<void> {
    if (!this.agent) {
      throw new Error("Agent not initialized");
    }

    try {
      // LangGraph Command to resume from interrupt
      const { Command } = await import("@langchain/langgraph");
      const resumeValue = approved ? { type: "approve" } : { type: "reject" };
      const command = new Command({ resume: resumeValue });

      debug("Starting resume streamEvents");
      const eventStream = this.agent.streamEvents(
        command,
        { signal: callbacks.signal, version: "v2" },
      );

      let assistantContent = "";
      let eventCount = 0;
      let lastToolName = "";
      let consecutiveToolCount = 0;
      const toolOutputCounts = new Map<string, number>();

      for await (const event of withTimeout(eventStream, EVENT_TIMEOUT_MS)) {
        eventCount++;
        if (callbacks.signal.aborted) {
          debug("Resume aborted by signal", { eventCount });
          break;
        }

        if (typeof event === "object" && event !== null && "__timeout" in event) {
          callbacks.onError("Model response timed out after resume.");
          debug("Resume timed out", { eventCount });
          break;
        }

        const evt = event as Record<string, unknown>;
        const eventType = evt.event as string | undefined;

        if (eventType === "on_chat_model_stream") {
          const data = evt.data as Record<string, unknown> | undefined;
          const chunk = data?.chunk as Record<string, unknown> | undefined;
          if (chunk) {
            const content = chunk.content;
            let token = "";
            if (typeof content === "string") {
              token = content;
            } else if (Array.isArray(content)) {
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

        if (eventType === "on_chat_model_end") {
          const data = evt.data as Record<string, unknown> | undefined;
          const output = data?.output as Record<string, unknown> | undefined;
          const rawUsage = output?.usage_metadata as Record<string, number> | undefined;
          const responseMetadata = (output as any)?.response_metadata as Record<string, unknown> | undefined;
          const rmUsage = responseMetadata?.usage as Record<string, number> | undefined;
          const fallbackUsage = (data as any)?.usage_metadata as Record<string, number> | undefined;
          const isNonEmpty = (obj: Record<string, unknown> | undefined) =>
            obj && Object.keys(obj).length > 0;
          const usageMetadata = (
            isNonEmpty(rawUsage) ? rawUsage
            : isNonEmpty(rmUsage) ? rmUsage
            : isNonEmpty(fallbackUsage) ? fallbackUsage
            : undefined
          ) as Record<string, number> | undefined;

          if (usageMetadata) {
            const inputTokens = usageMetadata.input_tokens ?? usageMetadata.prompt_tokens ?? 0;
            const outputTokens = usageMetadata.output_tokens ?? usageMetadata.completion_tokens ?? 0;
            this.cumulativeTokens.input += inputTokens;
            this.cumulativeTokens.output += outputTokens;
            this.lastStepTokens = inputTokens + outputTokens;
            const activeModel = (evt.name as string) || this.options.model;
            this.cumulativeCost += computeCost(activeModel, inputTokens, outputTokens);
            sendNotification("stream/tokenUsage", {
              inputTokens,
              outputTokens,
              cumulativeInput: this.cumulativeTokens.input,
              cumulativeOutput: this.cumulativeTokens.output,
              cumulativeCost: this.cumulativeCost,
            });
          }
        }

        if (eventType === "on_tool_start") {
          const toolName = (evt.name ?? "unknown") as string;
          const toolInput = (evt.data as Record<string, unknown>)?.input ?? {};

          // Circuit breaker
          if (toolName === lastToolName) {
            consecutiveToolCount++;
          } else {
            lastToolName = toolName;
            consecutiveToolCount = 1;
          }
          if (consecutiveToolCount >= MAX_CONSECUTIVE_SAME_TOOL) {
            const msg = `Circuit breaker: "${toolName}" called ${consecutiveToolCount} times in a row — aborting.`;
            debug(msg);
            callbacks.onError(msg);
            break;
          }

          callbacks.onToolStart(toolName, toolInput, this.lastStepTokens);

          if (toolName === "write_todos") {
            let parsed = toolInput;
            if (typeof parsed === "string") {
              try { parsed = JSON.parse(parsed); } catch { /* keep as-is */ }
            }
            if (typeof parsed === "object" && parsed !== null) {
              const obj = parsed as Record<string, unknown>;
              callbacks.onPlanUpdate(obj.todos ?? obj);
            }
          }
        }

        if (eventType === "on_tool_end") {
          const toolName = (evt.name ?? "unknown") as string;
          const toolOutput = (evt.data as Record<string, unknown>)?.output ?? {};

          // Repeated-output circuit breaker
          const outputStr = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);
          const outputKey = `${toolName}:${outputStr.length}`;
          const count = (toolOutputCounts.get(outputKey) ?? 0) + 1;
          toolOutputCounts.set(outputKey, count);
          if (count >= MAX_REPEATED_OUTPUTS) {
            const msg = `Circuit breaker: "${toolName}" returned the same output ${count} times — likely a retry loop. Aborting.`;
            debug(msg, { outputPreview: outputStr.slice(0, 200) });
            callbacks.onError(msg);
            break;
          }

          callbacks.onToolEnd(toolName, toolOutput);
        }

        if (eventType === "on_custom_event" && evt.name === "plan_update") {
          callbacks.onPlanUpdate(evt.data);
        }

        if (eventType === "on_custom_event" && evt.name === "__interrupt") {
          const data = evt.data as Record<string, unknown> | undefined;
          callbacks.onInterrupt(
            (data?.tool_name as string) ?? "unknown",
            data?.tool_input ?? {},
          );
        }
      }

      debug("Resume event loop exited", { eventCount, contentLength: assistantContent.length });

      if (assistantContent) {
        this.history.push({ role: "assistant", content: assistantContent });
      }
    } catch (err) {
      if (callbacks.signal.aborted) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      callbacks.onError(errMsg);
      debug("Resume error", { error: errMsg });
      throw err;
    }
  }

  getTokenUsage(): { cumulative: TokenUsage; cost: number } {
    return {
      cumulative: { ...this.cumulativeTokens },
      cost: this.cumulativeCost,
    };
  }

  clearHistory(): void {
    this.history = [];
    this.cumulativeTokens = { input: 0, output: 0 };
    this.cumulativeCost = 0;
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
