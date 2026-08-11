import { describe, it, expect } from 'vitest';
import { validateMcpAddCommand, isMcpUnsupportedCliError, isMcpInvalidInputError } from './mcp';

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
