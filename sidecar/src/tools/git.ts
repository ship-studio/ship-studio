/**
 * Git operation tools scoped to the project directory.
 *
 * Provides safe git operations for the deep agent.
 *
 * @module tools/git
 */

import { execSync } from "node:child_process";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { debug } from "../rpc.js";

function gitExec(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (err) {
    const execErr = err as { stderr?: string; message?: string };
    throw new Error(String(execErr.stderr ?? execErr.message ?? "git command failed"));
  }
}

export function createGitTools(projectPath: string) {
  const gitStatus = tool(
    async () => {
      debug("Running git status");
      const status = gitExec("status --porcelain", projectPath);
      const branch = gitExec("branch --show-current", projectPath);
      return JSON.stringify({ branch, changes: status || "(clean)" });
    },
    {
      name: "git_status",
      description: "Get the current git status including branch name and changed files.",
      schema: z.object({}),
    },
  );

  const gitDiff = tool(
    async ({ file, staged }) => {
      debug("Running git diff", { file, staged });
      const stagedFlag = staged ? "--staged" : "";
      const fileArg = file ? `-- "${file}"` : "";
      const diff = gitExec(`diff ${stagedFlag} ${fileArg}`.trim(), projectPath);
      return diff || "(no changes)";
    },
    {
      name: "git_diff",
      description: "Show git diff for unstaged or staged changes, optionally for a specific file.",
      schema: z.object({
        file: z.string().optional().describe("Specific file path to diff (optional)"),
        staged: z.boolean().optional().describe("Show staged changes instead of unstaged"),
      }),
    },
  );

  const gitLog = tool(
    async ({ count }) => {
      debug("Running git log", { count });
      const n = Math.min(count ?? 10, 50);
      const log = gitExec(
        `log --oneline --no-decorate -n ${n}`,
        projectPath,
      );
      return log || "(no commits)";
    },
    {
      name: "git_log",
      description: "Show recent git commit history.",
      schema: z.object({
        count: z.number().optional().describe("Number of commits to show (default: 10, max: 50)"),
      }),
    },
  );

  const gitAdd = tool(
    async ({ files }) => {
      debug("Running git add", { files });
      const fileArgs = files.map((f) => `"${f}"`).join(" ");
      gitExec(`add ${fileArgs}`, projectPath);
      return `Staged: ${files.join(", ")}`;
    },
    {
      name: "git_add",
      description: "Stage files for commit.",
      schema: z.object({
        files: z.array(z.string()).describe("File paths to stage"),
      }),
    },
  );

  const gitCommit = tool(
    async ({ message }) => {
      debug("Running git commit", { message });
      const result = gitExec(`commit -m "${message.replace(/"/g, '\\"')}"`, projectPath);
      return result;
    },
    {
      name: "git_commit",
      description: "Create a git commit with the staged changes.",
      schema: z.object({
        message: z.string().describe("Commit message"),
      }),
    },
  );

  return [gitStatus, gitDiff, gitLog, gitAdd, gitCommit];
}
