/**
 * MCP Server management utilities.
 *
 * Provides functions for:
 * - Listing MCP servers configured for an agent
 * - Adding new MCP servers via the agent's CLI
 * - Removing MCP servers
 *
 * @module lib/mcp
 */

import { invoke } from '@tauri-apps/api/core';
import { asCommandError, formatCommandError } from './errors';

/** Represents an MCP server configured for an agent. */
export interface McpServer {
  /** Server name (identifier) */
  name: string;
  /** The command string (for stdio) or URL (for http/sse) */
  command_or_url: string;
  /** Server status: "connected", "needs_auth", "error", "unknown" */
  status: string;
  /** Configuration scope: "user", "project", "local" */
  scope: string;
}

/**
 * List all MCP servers configured for the given agent.
 * @param projectPath - Optional project path for project-scoped servers
 * @param agentId - Optional agent ID to list servers for a specific agent
 * @returns Array of configured MCP servers
 */
export async function listMcpServers(projectPath?: string, agentId?: string): Promise<McpServer[]> {
  return invoke<McpServer[]>('list_mcp_servers', { projectPath, agentId });
}

/**
 * Add an MCP server using the agent's CLI.
 * @param rawArgs - Raw arguments for `mcp add` (e.g., "my-server -- npx -y @some/package")
 * @param scope - Configuration scope: "user" or "project"
 * @param projectPath - Optional project path for project-scoped servers
 * @param agentId - Optional agent ID to add for a specific agent
 */
export async function addMcpServer(
  rawArgs: string,
  scope?: string,
  projectPath?: string,
  agentId?: string
): Promise<void> {
  return invoke('add_mcp_server', { rawArgs, scope, projectPath, agentId });
}

/**
 * True when an `mcp add/list/remove` failure means the installed agent CLI is
 * too old to have MCP subcommands at all. Older Codex CLIs (pre `codex mcp
 * add|list|remove|get`) fail with clap's usage error — "error: unexpected
 * argument 'add' found\n\nUsage: codex mcp [OPTIONS]" — which the backend
 * forwards verbatim. That's a user-environment state ("update your CLI"), not
 * an app bug (issue #550).
 */
export function isMcpUnsupportedCliError(value: unknown): boolean {
  const message = formatCommandError(asCommandError(value));
  return (
    /unexpected argument '(add|list|remove|get)'/i.test(message) ||
    /unrecognized subcommand/i.test(message)
  );
}

/**
 * True when an `mcp add` failure is the backend's own input-shape validation
 * (OpenCode's config-file path in `opencode_mcp_entry`,
 * src-tauri/src/commands/mcp.rs) — the user hasn't finished typing the
 * command, not an app bug. The backend classifies these `Expected`, but the
 * frontend's generic catch branch still logged them as errors, auto-filing
 * bug reports for typos (issue #655).
 */
export function isMcpInvalidInputError(value: unknown): boolean {
  const message = formatCommandError(asCommandError(value));
  return (
    /need a command or a --url/i.test(message) ||
    /--url needs a value/i.test(message) ||
    /No arguments provided for mcp add/i.test(message)
  );
}

/**
 * Wording of the guidance sentences `classify_mcp_failure`
 * (src-tauri/src/commands/mcp.rs) appends when an `<agent> mcp add|remove|list`
 * failure reflects machine state, org policy, the user's own agent config, or
 * an upstream CLI bug — never a Ship Studio defect. The backend returns those
 * as `CommandError::Expected`, but Expected serializes identically to Other
 * across IPC, so the wording is the only signal left by the time the modal
 * catches it. Keep these in sync with the Rust strings byte-for-byte.
 */
const MCP_EXPECTED_FAILURE_PHRASES = [
  // Enterprise MCP allowlist (issue #675)
  "your organization's managed agent settings block this mcp server",
  // Org-managed Cloud gateway unreachable / session expired (issues #799, #800)
  "your organization's agent gateway couldn't be reached",
  // Upstream `mcp add -e` parser regression (issue #763)
  'this is a known bug in recent claude code cli versions',
  // The agent CLI's own config file has a value it no longer accepts (#755)
  "the agent cli couldn't read its own config file",
  // The OS denied the agent's config write (issues #471, #677)
  "the agent couldn't write its own config file",
];

/**
 * True when an `mcp add/remove/list` failure is one the backend already
 * classified `Expected` with its own guidance (see
 * {@link MCP_EXPECTED_FAILURE_PHRASES}). These are the user's environment,
 * organization, or agent CLI — routing them to `logger.error` auto-files a bug
 * report for something Ship Studio can't fix (issues #755, #763, #799, #800),
 * so callers log them at warn level and surface them as information, following
 * the #655 precedent above.
 */
export function isMcpExpectedFailure(value: unknown): boolean {
  const message = formatCommandError(asCommandError(value)).toLowerCase();
  return MCP_EXPECTED_FAILURE_PHRASES.some((phrase) => message.includes(phrase));
}

/**
 * Split a raw `mcp add` argument string like a shell would — whitespace
 * separates tokens, single/double quotes group, `\"` and `\\` escape inside
 * double quotes. Mirrors the backend's `shell_split`
 * (src-tauri/src/commands/mcp.rs) so frontend validation tokenizes exactly
 * like the parser that will actually consume the input.
 */
function shellSplitArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if ((c === ' ' || c === '\t') && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else if (c === '\\' && inDouble && (input[i + 1] === '"' || input[i + 1] === '\\')) {
      current += input[i + 1];
      i++;
    } else {
      current += c;
    }
  }
  if (current) args.push(current);
  return args;
}

/** Flags of `mcp add` that consume the next token as their value. */
const MCP_ADD_VALUE_FLAGS = new Set([
  '--transport',
  '-t',
  '--scope',
  '-s',
  '--env',
  '-e',
  '--header',
  '-H',
]);

/**
 * Frontend validation for the MCP modal's "Add" input (issue #588).
 *
 * `claude mcp add <name>` with no command/URL fails at the CLI level with a
 * raw `error: missing required argument 'commandOrUrl'` — catch the shape
 * before shelling out. Mirrors the backend's leniency: the
 * `<binary> mcp add` prefix is optional, flags may precede the name
 * (`--transport http name url`), and either a `--url <value>`, a URL token,
 * or a command (bare token / `-- command...`) satisfies the requirement.
 *
 * For OpenCode (`agentId === 'opencode'`) the generic flag-aware grammar is
 * wrong: OpenCode's `mcp add` is interactive-only, so the backend writes its
 * config file directly via `opencode_mcp_entry`, whose parser has no flag
 * awareness at all — first token is the name, the rest is either
 * `--url <value>` or the command (optionally after `--`). Mirror that exact
 * rule so what the frontend waves through matches what the backend accepts,
 * and only reject what OpenCode definitely rejects (issue #655).
 *
 * @returns A user-facing error message, or `null` when the input looks valid.
 */
export function validateMcpAddCommand(
  rawArgs: string,
  agentBinaryName = 'claude',
  agentId?: string
): string | null {
  let text = rawArgs.trim();
  // Strip the optional "<binary> mcp add" prefix exactly like the backend.
  if (text.startsWith(agentBinaryName)) text = text.slice(agentBinaryName.length).trimStart();
  if (text.startsWith('mcp add')) text = text.slice('mcp add'.length).trimStart();

  if (agentId === 'opencode') {
    // Same tokenization + shape rule as `opencode_mcp_entry`
    // (src-tauri/src/commands/mcp.rs).
    const [, ...rest] = shellSplitArgs(text);
    if (rest[0] === '--url') {
      if (rest.length < 2) {
        return 'Give --url a value, e.g. `my-server --url https://example.com/mcp`.';
      }
      return null;
    }
    const command = rest[0] === '--' ? rest.slice(1) : rest;
    if (command.length === 0) {
      return 'OpenCode MCP servers need a command or a --url: add a command after the name (e.g. `my-server -- npx -y @some/mcp-server`) or a URL (e.g. `my-server --url https://example.com/mcp`).';
    }
    return null;
  }

  const invalid =
    'Include what the server runs or connects to: a command after the name (e.g. `my-server -- npx -y @some/mcp-server`) or a URL (e.g. `my-server --url https://example.com/mcp`).';
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return invalid;

  // Count "bare" tokens (name + command/URL positions), skipping flags and
  // their values. A `--` separator means everything after is the command.
  let bare = 0;
  let hasUrl = false;
  let hasSeparatorCommand = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') {
      hasSeparatorCommand = i < tokens.length - 1;
      break;
    }
    if (t === '--url' || t === '-u') {
      if (i + 1 >= tokens.length) return invalid;
      hasUrl = true;
      i++;
      continue;
    }
    if (MCP_ADD_VALUE_FLAGS.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith('-')) continue;
    if (/^https?:\/\//i.test(t)) hasUrl = true;
    bare++;
  }

  // Valid shapes: name + `-- command`, name + `--url <url>` / URL token, or
  // name + command (two bare tokens).
  if (hasSeparatorCommand && bare >= 1) return null;
  if (hasUrl && bare >= 1) return null;
  if (bare >= 2) return null;
  return invalid;
}

/**
 * Remove an MCP server by name.
 * @param name - Server name to remove
 * @param scope - Configuration scope the server was added to
 * @param projectPath - Optional project path for project-scoped servers
 * @param agentId - Optional agent ID to remove for a specific agent
 */
export async function removeMcpServer(
  name: string,
  scope?: string,
  projectPath?: string,
  agentId?: string
): Promise<void> {
  return invoke('remove_mcp_server', { name, scope, projectPath, agentId });
}
