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
import { asCommandError, formatCommandError, isExpectedCommandError } from './errors';

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
 * classified `Expected`. Most branches of `classify_mcp_failure`
 * (src-tauri/src/commands/mcp.rs) append one of the guidance phrases in
 * {@link MCP_EXPECTED_FAILURE_PHRASES}, so those are matched first — but the
 * "already exists" branch (a benign race with a concurrent registration,
 * issue #292) returns the bare message with no such phrase, so it fell
 * through to `logger.error` and got auto-filed as a bug (issue #884).
 * Falling back to the generic {@link isExpectedCommandError} flag (which
 * reads the `expected: true` tag directly instead of re-matching wording)
 * catches that case and any future `Expected` branch that doesn't append a
 * unique phrase either.
 *
 * These are the user's environment, organization, or agent CLI — routing
 * them to `logger.error` auto-files a bug report for something Ship Studio
 * can't fix (issues #755, #763, #799, #800), so callers log them at warn
 * level and surface them as information, following the #655 precedent above.
 */
export function isMcpExpectedFailure(value: unknown): boolean {
  const message = formatCommandError(asCommandError(value)).toLowerCase();
  return (
    MCP_EXPECTED_FAILURE_PHRASES.some((phrase) => message.includes(phrase)) ||
    isExpectedCommandError(value)
  );
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

  // Claude Code and Codex disagree on how a remote server is given: Claude
  // Code takes the URL as a plain argument after `--transport http` and has
  // no `--url`; Codex takes `--url <url>` and has no `--transport`. Passing
  // the other CLI's flag failed with that CLI's raw parse error (issues #998,
  // #1061), so each gets its own syntax — in the guidance and in what's
  // accepted. With no agent known, both are accepted as before.
  const urlExample =
    agentId === 'claude-code'
      ? '`--transport http my-server https://example.com/mcp`'
      : '`my-server --url https://example.com/mcp`';
  const invalid = `Include what the server runs or connects to: a command after the name (e.g. \`my-server -- npx -y @some/mcp-server\`) or a URL (e.g. ${urlExample}).`;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return invalid;

  // Count "bare" tokens (name + command/URL positions), skipping flags and
  // their values. A `--` separator means everything after is the command.
  let bare = 0;
  let hasUrl = false;
  let hasUrlFlag = false;
  let hasSeparatorCommand = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') {
      hasSeparatorCommand = i < tokens.length - 1;
      break;
    }
    if (t === '--url' || t === '-u') {
      if (agentId === 'claude-code') {
        return `Claude Code has no \`--url\` flag — give the transport and the URL as plain arguments, e.g. ${urlExample}.`;
      }
      if (i + 1 >= tokens.length) return invalid;
      hasUrl = true;
      hasUrlFlag = true;
      i++;
      continue;
    }
    if (agentId === 'codex' && (t === '--transport' || t === '-t')) {
      return `Codex has no \`--transport\` flag — add a remote server with ${urlExample}.`;
    }
    // Codex won't take a flag-like token in a command that wasn't set off
    // with `--` ("unexpected argument '-y' found", issue #1059).
    if (agentId === 'codex' && bare >= 2 && t.startsWith('-')) {
      return 'Put `--` between the server name and its command, e.g. `my-server -- npx -y @some/mcp-server`.';
    }
    if (MCP_ADD_VALUE_FLAGS.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith('-')) continue;
    if (/^https?:\/\//i.test(t)) {
      // Codex would take a bare URL as the command to launch.
      if (agentId === 'codex' && !hasUrlFlag) {
        return `Codex needs \`--url\` before a server URL, e.g. ${urlExample}.`;
      }
      hasUrl = true;
    }
    bare++;
  }

  // Valid shapes: name + `-- command`, name + `--url <url>` / URL token, or
  // name + command (two bare tokens).
  if (hasSeparatorCommand && bare >= 1) return null;
  if (hasUrl && bare >= 1) return null;
  if (bare >= 2) return null;
  return invalid;
}

/** Result of reading a pasted JSON MCP config — see {@link mcpJsonConfigToAddArgs}. */
export type McpJsonConversion = { args: string } | { error: string };

const PASTE_NAME_HINT =
  'Or enter the server name followed by its command, e.g. `my-server -- npx -y @some/mcp-server`.';

/** Quote one token so `shell_split` (and {@link shellSplitArgs}) read it back unchanged. */
function quoteArg(token: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `"${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
    out[k] = String(v);
  }
  return out;
}

/**
 * Turn a pasted JSON MCP config into the `mcp add` argument string the active
 * agent's CLI takes (issue #1154).
 *
 * Server READMEs hand out configs as JSON (`{"mcpServers": {"name": {"command":
 * …}}}`), so people paste that into the Add field. Passed through as-is, the
 * first token (`{`) became the server name and Claude Code refused it with a
 * raw "Invalid name {. Names can only contain letters, numbers, hyphens, and
 * underscores." — the Codex equivalent was #1058.
 *
 * Accepts one server, wrapped in `mcpServers` / `servers` / `mcp` or given as
 * `{"<name>": {…}}`, with `command` (+ `args`, `env`/`environment`) or `url`
 * (+ `headers`, `type`). Anything it can't represent faithfully for this
 * agent — several servers, no name, a field the agent's `mcp add` has no flag
 * for — gets an inline message instead of a partial add that silently drops
 * part of the config.
 *
 * @returns `null` when the input isn't a JSON object (normal `mcp add` text).
 */
export function mcpJsonConfigToAddArgs(
  rawInput: string,
  agentId?: string
): McpJsonConversion | null {
  const text = rawInput.trim();
  if (!text.startsWith('{')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      error: `That looks like a JSON config, but it isn't complete JSON. Paste the whole config. ${PASTE_NAME_HINT}`,
    };
  }
  if (!isPlainObject(parsed)) {
    return { error: `That JSON isn't an MCP server config. ${PASTE_NAME_HINT}` };
  }

  // A config with no name around it: `{"command": "npx", …}`.
  if ('command' in parsed || 'url' in parsed) {
    return {
      error: `That config has no server name. Paste it with its name, e.g. \`{"my-server": {"command": "npx", "args": ["-y", "@some/mcp-server"]}}\`. ${PASTE_NAME_HINT}`,
    };
  }

  const wrapper = ['mcpServers', 'servers', 'mcp'].find((key) => isPlainObject(parsed[key]));
  const servers = (wrapper ? parsed[wrapper] : parsed) as Record<string, unknown>;
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    return { error: `That config has no servers in it. ${PASTE_NAME_HINT}` };
  }
  if (entries.length > 1) {
    return {
      error: `That config has ${entries.length} servers (${entries
        .map(([name]) => name)
        .join(', ')}). Add them one at a time — paste one server's config at once.`,
    };
  }

  const [name, config] = entries[0];
  if (!isPlainObject(config)) {
    return { error: `The config for "${name}" isn't an object. ${PASTE_NAME_HINT}` };
  }
  const env = stringRecord(config.env ?? config.environment);
  const headers = stringRecord(config.headers);
  if (env === null || headers === null) {
    return {
      error: `The env or headers in "${name}" aren't simple key/value text. ${PASTE_NAME_HINT}`,
    };
  }
  const envPairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const headerPairs = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);

  // Local (stdio) server. OpenCode writes `command` as an array.
  let command: string[] | null = null;
  if (typeof config.command === 'string' && config.command.trim()) {
    const args = config.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return { error: `The "args" in "${name}" must be a list of text values. ${PASTE_NAME_HINT}` };
    }
    command = [config.command, ...(args as string[])];
  } else if (
    Array.isArray(config.command) &&
    config.command.length > 0 &&
    config.command.every((c) => typeof c === 'string')
  ) {
    command = config.command;
  }

  const url = typeof config.url === 'string' && config.url.trim() ? config.url.trim() : null;
  if (!command && !url) {
    return {
      error: `The config for "${name}" has neither a "command" nor a "url". ${PASTE_NAME_HINT}`,
    };
  }

  const unsupported = (what: string) => ({
    error: `"${name}" sets ${what}, which this agent's MCP setup here can't take. Add the server in the agent's own config file instead, or add it without them as a name followed by its command or URL.`,
  });

  if (command) {
    if (agentId === 'opencode') {
      if (envPairs.length > 0) return unsupported('environment variables');
      return { args: [name, '--', ...command].map(quoteArg).join(' ') };
    }
    // Claude Code takes `-e`, Codex `--env`; both after the name and before
    // `--`, where neither CLI can mistake the name for a flag value.
    const envFlag = agentId === 'codex' ? '--env' : '-e';
    const envArgs = envPairs.flatMap((pair) => [envFlag, pair]);
    return { args: [name, ...envArgs, '--', ...command].map(quoteArg).join(' ') };
  }

  // Remote server.
  const remoteUrl = url as string;
  if (agentId === 'claude-code') {
    const declared = typeof config.type === 'string' ? config.type.toLowerCase() : '';
    const transport = declared === 'sse' ? 'sse' : 'http';
    const headerArgs = headerPairs.flatMap((pair) => ['-H', pair]);
    return {
      args: ['--transport', transport, name, remoteUrl, ...headerArgs].map(quoteArg).join(' '),
    };
  }
  if (headerPairs.length > 0) return unsupported('headers');
  return { args: [name, '--url', remoteUrl].map(quoteArg).join(' ') };
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
