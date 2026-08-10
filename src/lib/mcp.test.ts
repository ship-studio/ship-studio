import { describe, it, expect } from 'vitest';
import { validateMcpAddCommand, isMcpUnsupportedCliError } from './mcp';

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
