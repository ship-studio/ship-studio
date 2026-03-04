/**
 * Sandboxed shell execution tool.
 *
 * Executes commands scoped to the project directory with a timeout.
 * Blocks dangerous patterns for safety.
 *
 * @module tools/shell
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { debug } from "../rpc.js";

const SHELL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 50_000;

/** Patterns that are too dangerous to execute. */
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~/,
  /mkfs\./,
  /dd\s+if=/,
  /:(){ :\|:& };:/,
  />\s*\/dev\/sd/,
  /chmod\s+-R\s+777\s+\//,
  /\bsudo\b/,
  /curl\b.*\|\s*\b(bash|sh)\b/,
  /wget\b.*\|\s*\b(bash|sh)\b/,
  /\bnpm\s+publish\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
];

function isDangerous(command: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
}

function truncateOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return { text: output, truncated: false };
  }
  return {
    text: output.slice(0, MAX_OUTPUT_LENGTH) + "\n... (output truncated)",
    truncated: true,
  };
}

export function createShellTool(projectPath: string) {
  return tool(
    async ({ command }) => {
      if (isDangerous(command)) {
        return JSON.stringify({
          exitCode: 1,
          stdout: "",
          stderr: "Command blocked: potentially destructive operation",
          truncated: false,
        });
      }

      debug("Executing shell command", { command, cwd: projectPath });

      try {
        const stdout = execSync(command, {
          cwd: projectPath,
          timeout: SHELL_TIMEOUT_MS,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024, // 1MB
          env: {
            ...process.env,
            // Ensure consistent locale
            LANG: "en_US.UTF-8",
            LC_ALL: "en_US.UTF-8",
          },
        });

        const result = truncateOutput(stdout);
        return JSON.stringify({
          exitCode: 0,
          stdout: result.text,
          stderr: "",
          truncated: result.truncated,
        });
      } catch (err) {
        const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
        const stdout = truncateOutput(String(execErr.stdout ?? ""));
        const stderr = truncateOutput(String(execErr.stderr ?? execErr.message ?? ""));

        return JSON.stringify({
          exitCode: execErr.status ?? 1,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: stdout.truncated || stderr.truncated,
        });
      }
    },
    {
      name: "execute",
      description:
        "Execute a shell command in the project directory. Returns stdout, stderr, exit code. " +
        "ONLY use for: npm/pnpm/yarn, git, build tools, dev servers, and CLI operations with no built-in equivalent. " +
        "Do NOT use for file operations — use read_file (not cat/head/tail), ls (not ls command), glob (not find), grep (not grep/rg).",
      schema: z.object({
        command: z.string().describe("The shell command to execute"),
      }),
    },
  );
}
