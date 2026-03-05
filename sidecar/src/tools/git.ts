/**
 * Git MCP tools for the Agent SDK.
 *
 * Provides git operations as custom tools via createSdkMcpServer.
 * These are passed to query() so the agent can interact with git.
 *
 * @module tools/git
 */

import { execSync } from "node:child_process";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 30_000 }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err as any).stderr?.toString() || err.message : String(err);
    return `Error: ${msg}`;
  }
}

/**
 * Create an MCP server with all git tools, scoped to a project directory.
 * Tools capture projectPath via closure.
 */
export function createGitMcpServer(projectPath: string) {
  const gitStatus = tool(
    "git_status",
    "Get current git status including branch, staged/unstaged changes, and untracked files",
    {},
    async () => {
      const branch = exec("git branch --show-current", projectPath);
      const status = exec("git status --porcelain", projectPath);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ branch, changes: status.split("\n").filter(Boolean) }) }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  const gitDiff = tool(
    "git_diff",
    "Show git diff of changes. Use staged=true for staged changes, or provide a specific path",
    { staged: z.boolean().optional().describe("Show staged changes only"), path: z.string().optional().describe("Specific file path") },
    async (args) => {
      const cmd = `git diff${args.staged ? " --cached" : ""}${args.path ? ` -- ${args.path}` : ""}`;
      const diff = exec(cmd, projectPath);
      return { content: [{ type: "text" as const, text: diff || "No changes" }] };
    },
    { annotations: { readOnlyHint: true } },
  );

  const gitLog = tool(
    "git_log",
    "Show recent git commit history",
    { count: z.number().optional().describe("Number of commits (default 10)") },
    async (args) => {
      const n = args.count ?? 10;
      const log = exec(`git log --oneline -${n}`, projectPath);
      return { content: [{ type: "text" as const, text: log }] };
    },
    { annotations: { readOnlyHint: true } },
  );

  const gitAdd = tool(
    "git_add",
    "Stage files for commit",
    { paths: z.array(z.string()).describe("File paths to stage (use ['.'] for all)") },
    async (args) => {
      const result = exec(`git add ${args.paths.join(" ")}`, projectPath);
      return { content: [{ type: "text" as const, text: result || "Files staged" }] };
    },
  );

  const gitCommit = tool(
    "git_commit",
    "Create a git commit with the given message",
    { message: z.string().describe("Commit message") },
    async (args) => {
      const result = exec(`git commit -m "${args.message.replace(/"/g, '\\"')}"`, projectPath);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  return createSdkMcpServer({
    name: "ship-studio-git",
    tools: [gitStatus, gitDiff, gitLog, gitAdd, gitCommit],
  });
}
