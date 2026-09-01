import { describe, it, expect } from 'vitest';
import {
  validateMcpAddCommand,
  isMcpUnsupportedCliError,
  isMcpInvalidInputError,
  isMcpExpectedFailure,
} from './mcp';

describe('validateMcpAddCommand (#588)', () => {
  const validInputs = [
    'my-server -- npx -y @some/mcp-server', // command after --
    'my-server npx -y @some/mcp-server', // command without --
    'my-server --url https://example.com/mcp', // remote via --url
    'my-server https://example.com/mcp', // bare URL as commandOrUrl
    '--transport http sentry https://mcp.sentry.dev/mcp', // flags before name
    'my-server --env FOO=bar -- npx -y pkg', // env flag + separator
    'claude mcp add my-server -- npx -y pkg', // optional CLI prefix
    'mcp add my-server -- npx -y pkg', // partial prefix
  ];

  it.each(validInputs)('accepts: %s', (input) => {
    expect(validateMcpAddCommand(input)).toBeNull();
  });

  const invalidInputs = [
    'my-server', // name only — the exact #588 report shape
    'claude mcp add my-server', // name only behind the prefix
    'my-server --scope user', // name + flags, still no command/URL
    'my-server --url', // --url with no value
    'my-server --', // separator with nothing after it
  ];

  it.each(invalidInputs)('rejects with guidance: %s', (input) => {
    const message = validateMcpAddCommand(input);
    expect(message).not.toBeNull();
    expect(message).toContain('--url');
    expect(message).toContain('npx');
  });

  it('strips the prefix for the configured agent binary', () => {
    expect(validateMcpAddCommand('codex mcp add my-server -- npx pkg', 'codex')).toBeNull();
    expect(validateMcpAddCommand('codex mcp add my-server', 'codex')).not.toBeNull();
  });
});

describe('validateMcpAddCommand for OpenCode (#655)', () => {
  const validate = (input: string) => validateMcpAddCommand(input, 'opencode', 'opencode');

  const validInputs = [
    'my-server -- npx -y @some/mcp-server', // command after --
    'my-server npx -y @some/mcp-server', // command without --
    'my-server --url https://example.com/mcp', // remote via --url
    'opencode mcp add my-server -- npx -y pkg', // optional CLI prefix
    // OpenCode's parser has no flag awareness — these tokens are read as the
    // command, so the backend accepts them. Reject only what it rejects.
    'my-server --transport http something',
    'my-server -e FOO=bar npx pkg',
  ];

  it.each(validInputs)('accepts: %s', (input) => {
    expect(validate(input)).toBeNull();
  });

  it.each([
    'my-server', // name only — exactly what the backend rejects
    'opencode mcp add my-server', // name only behind the prefix
    'my-server --', // separator with nothing after it
    '', // nothing at all
  ])('rejects with guidance: %s', (input) => {
    const message = validate(input);
    expect(message).not.toBeNull();
    expect(message).toContain('--url');
    expect(message).toContain('npx');
  });

  it('rejects --url without a value', () => {
    expect(validate('my-server --url')).toContain('--url');
  });

  it('tokenizes quotes like the backend shell_split: a quoted name alone is still just a name', () => {
    // Whitespace-splitting saw two tokens here and waved it through; the
    // backend's shell_split sees one token (the name) and rejected it — the
    // exact frontend/backend disagreement from the report.
    expect(validate('"my server"')).not.toBeNull();
    expect(validate('"my server" -- npx -y pkg')).toBeNull();
  });
});

describe('isMcpInvalidInputError (#655)', () => {
  it("matches the backend's OpenCode input-shape validation messages", () => {
    expect(
      isMcpInvalidInputError(
        'OpenCode MCP servers need a command or a --url, e.g. `my-server -- npx -y @some/mcp-server`'
      )
    ).toBe(true);
    expect(
      isMcpInvalidInputError(
        'mcp add: --url needs a value, e.g. `my-server --url https://example.com/mcp`'
      )
    ).toBe(true);
    expect(isMcpInvalidInputError('No arguments provided for mcp add')).toBe(true);
    // CommandError objects work too (Tauri rejections are plain objects;
    // Expected serializes as Other across IPC).
    expect(
      isMcpInvalidInputError({
        type: 'Other',
        message: 'OpenCode MCP servers need a command or a --url',
      })
    ).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isMcpInvalidInputError('Failed to add MCP server: connection refused')).toBe(false);
    expect(isMcpInvalidInputError('OpenCode binary not found')).toBe(false);
  });
});

describe('isMcpUnsupportedCliError (#550)', () => {
  it("matches older Codex CLIs' clap usage error for missing mcp subcommands", () => {
    expect(
      isMcpUnsupportedCliError(
        "Failed to add MCP server: error: unexpected argument 'add' found\n\nUsage: codex mcp [OPTIONS]\n\nFor more information, try '--help'."
      )
    ).toBe(true);
    expect(
      isMcpUnsupportedCliError("error: unrecognized subcommand 'remove'\n\nUsage: codex mcp")
    ).toBe(true);
    // CommandError objects work too (Tauri rejections are plain objects).
    expect(
      isMcpUnsupportedCliError({
        type: 'Other',
        message: "Failed to list MCP servers: error: unexpected argument 'list' found",
      })
    ).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isMcpUnsupportedCliError('Failed to add MCP server: connection refused')).toBe(false);
    expect(isMcpUnsupportedCliError('Codex binary not found')).toBe(false);
    // The CLI's *own* argument validation for a user typo is not a version gap.
    expect(isMcpUnsupportedCliError("error: missing required argument 'commandOrUrl'")).toBe(false);
  });
});

describe('isMcpExpectedFailure', () => {
  // Guidance sentences authored by classify_mcp_failure
  // (src-tauri/src/commands/mcp.rs) — kept byte-identical to the Rust strings.
  const expectedFailures: [string, string][] = [
    [
      '#675 enterprise MCP allowlist',
      'Failed to add MCP server: Cannot add MCP server "x": not allowed by enterprise policy\n\nYour organization\'s managed agent settings block this MCP server. Ask your admin to allowlist it, then try again.',
    ],
    [
      '#799/#800 org Cloud gateway unreachable',
      "Failed to list MCP servers: Couldn't load settings from Cloud gateway gw.example.com.\n\nYour organization's agent gateway couldn't be reached. Check your network (or VPN) connection, or run `claude auth login` in a terminal to sign in again, then try again.",
    ],
    [
      '#763 upstream `mcp add -e` parser bug',
      "Failed to add MCP server: Invalid environment variable format\n\nThis is a known bug in recent Claude Code CLI versions — its `mcp add` parser mishandles `-e` environment variables (anthropics/claude-code#23365). Add the server without its `-e` flags for now (set those variables in the server's own config instead), or update Claude Code once the fix ships.",
    ],
    [
      "#755 the agent CLI's own config has an unusable value",
      "Failed to remove MCP server: failed to load configuration\n\nThe agent CLI couldn't read its own config file — a setting in it (`service_tier`) has a value this version no longer accepts. Fix or remove that setting in the config file named above, then try again.",
    ],
    [
      "#471/#677 the OS denied the agent's config write",
      "Failed to add MCP server: Access is denied. (os error 5)\n\nThe agent couldn't write its own config file — the OS denied access. Check that the file isn't read-only or locked by another program (antivirus, OneDrive/cloud sync), and that its folder is owned by your user account, then try again.",
    ],
  ];

  it.each(expectedFailures)('recognizes %s', (_label, message) => {
    expect(isMcpExpectedFailure(message)).toBe(true);
    expect(isMcpExpectedFailure({ type: 'Other', message })).toBe(true);
  });

  it('does not swallow failures that could be app defects', () => {
    expect(isMcpExpectedFailure('Failed to add MCP server: connection refused')).toBe(false);
    expect(isMcpExpectedFailure('Failed to list MCP servers: unexpected panic')).toBe(false);
    expect(isMcpExpectedFailure(null)).toBe(false);
  });
});
