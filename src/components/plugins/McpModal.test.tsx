/**
 * Regression tests for the MCP modal's error-flow handling:
 *
 * - #588 — "Add" with a name but no command/URL must be caught by frontend
 *   validation (inline feedback), never reach the CLI's raw usage error.
 * - #594 — "agent CLI not installed" is Expected on the backend; the modal
 *   must log it at warn level, not logger.error (which auto-files bug reports).
 * - #550 — older Codex CLIs without `mcp add` fail with a raw clap usage
 *   dump; the modal must show a friendly "update your CLI" message instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { McpModal } from './McpModal';

vi.mock('../../lib/mcp', async (importOriginal) => ({
  // Keep the real validators; mock only the invoke wrappers.
  ...(await importOriginal<typeof import('../../lib/mcp')>()),
  listMcpServers: vi.fn(),
  addMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
}));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn(), trackSearch: vi.fn() }));
vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../contexts/ModalContext', () => ({
  useModal: () => ({ isOpen: true, close: vi.fn() }),
}));
const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast }),
}));

import { listMcpServers, addMcpServer, removeMcpServer } from '../../lib/mcp';
import { logger } from '../../lib/logger';

type Fn = ReturnType<typeof vi.fn>;

async function openAddTab() {
  // The "Add" *tab* button (the submit button isn't rendered yet).
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  return await screen.findByPlaceholderText(/my-server/);
}

/** The Add-tab's submit button (distinct from the "Add" tab button). */
function clickAddSubmit() {
  const button = screen
    .getAllByRole('button', { name: /^add$/i })
    .find((b) => b.className.includes('mcp-add-btn'));
  expect(button).toBeDefined();
  fireEvent.click(button!);
}

describe('McpModal error flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listMcpServers).mockResolvedValue([]);
  });

  it('logs "agent not installed" on load at warn level, not error (#594)', async () => {
    vi.mocked(listMcpServers).mockRejectedValue({
      type: 'Other',
      message: 'Codex binary not found',
    });

    render(<McpModal agentId="codex" agentDisplayName="Codex" agentBinaryName="codex" />);

    await waitFor(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
      expect(logger.warn as Fn).toHaveBeenCalledWith(
        'Failed to load MCP servers',
        expect.objectContaining({ error: 'Codex binary not found' })
      );
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
  });

  it('rejects a name-only Add inline, without invoking the CLI (#588)', async () => {
    render(<McpModal />);
    const input = await openAddTab();

    fireEvent.change(input, { target: { value: 'my-server' } });
    clickAddSubmit();

    // Inline guidance, not the CLI's raw usage error.
    expect(await screen.findByText(/command after the name|--url/)).toBeInTheDocument();
    expect(addMcpServer).not.toHaveBeenCalled();
    // No toast-error / bug-report channel involved.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).not.toHaveBeenCalled();
  });

  it('still submits a valid Add command', async () => {
    vi.mocked(addMcpServer).mockResolvedValue(undefined);
    render(<McpModal />);
    const input = await openAddTab();

    fireEvent.change(input, { target: { value: 'my-server -- npx -y @some/mcp-server' } });
    clickAddSubmit();

    await waitFor(() =>
      expect(addMcpServer).toHaveBeenCalledWith(
        'my-server -- npx -y @some/mcp-server',
        'user',
        undefined,
        undefined
      )
    );
    // Success switches back to the Connected tab.
    expect(await screen.findByPlaceholderText(/filter servers/i)).toBeInTheDocument();
  });

  it("maps an old CLI's missing `mcp add` subcommand to update guidance (#550)", async () => {
    vi.mocked(addMcpServer).mockRejectedValue({
      type: 'Other',
      message:
        "Failed to add MCP server: error: unexpected argument 'add' found\n\nUsage: codex mcp [OPTIONS]\n\nFor more information, try '--help'.",
    });

    render(<McpModal agentId="codex" agentDisplayName="Codex" agentBinaryName="codex" />);
    const input = await openAddTab();

    fireEvent.change(input, { target: { value: 'my-server -- npx -y @some/mcp-server' } });
    clickAddSubmit();

    // Friendly, actionable message — not clap's usage dump.
    const message = await screen.findByText(/too old to manage MCP servers/i);
    expect(message.textContent).toContain('update Codex');
    expect(screen.queryByText(/unexpected argument/)).not.toBeInTheDocument();
    // Environment state, not a bug: warn, not error.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
  });

  it('shows a friendly install prompt when adding with the CLI missing (#594)', async () => {
    vi.mocked(addMcpServer).mockRejectedValue({
      type: 'Other',
      message: 'Codex binary not found',
    });

    render(<McpModal agentId="codex" agentDisplayName="Codex" agentBinaryName="codex" />);
    const input = await openAddTab();

    fireEvent.change(input, { target: { value: 'my-server -- npx -y @some/mcp-server' } });
    clickAddSubmit();

    expect(await screen.findByText(/doesn't appear to be installed/i)).toBeInTheDocument();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
  });

  it("rejects an OpenCode name-only Add inline via OpenCode's own grammar (#655)", async () => {
    render(<McpModal agentId="opencode" agentDisplayName="OpenCode" agentBinaryName="opencode" />);
    const input = await openAddTab();

    // A quoted name is one shell token — the generic whitespace-based
    // validator saw two tokens and waved it through to the CLI.
    fireEvent.change(input, { target: { value: '"my server"' } });
    clickAddSubmit();

    expect(await screen.findByText(/need a command or a --url/i)).toBeInTheDocument();
    expect(addMcpServer).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).not.toHaveBeenCalled();
  });

  it("logs the backend's own input-shape rejection at warn, not error (#655)", async () => {
    vi.mocked(addMcpServer).mockRejectedValue({
      type: 'Other',
      message:
        'OpenCode MCP servers need a command or a --url, e.g. `my-server -- npx -y @some/mcp-server`',
    });

    render(<McpModal agentId="opencode" agentDisplayName="OpenCode" agentBinaryName="opencode" />);
    const input = await openAddTab();

    // Passes frontend validation but (hypothetically) still bounces off the
    // backend parser — must be classified as user input, not an app bug.
    fireEvent.change(input, { target: { value: 'my-server -- npx -y @some/mcp-server' } });
    clickAddSubmit();

    expect(await screen.findByText(/need a command or a --url/i)).toBeInTheDocument();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).toHaveBeenCalledWith(
      'Failed to add MCP server: input rejected by agent parser',
      expect.objectContaining({ error: expect.stringContaining('need a command') as unknown })
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
  });

  it('keeps logger.error for genuinely unrecognized add failures', async () => {
    vi.mocked(addMcpServer).mockRejectedValue({
      type: 'Other',
      message: 'Failed to add MCP server: something exploded',
    });

    render(<McpModal />);
    const input = await openAddTab();

    fireEvent.change(input, { target: { value: 'my-server -- npx -y @some/mcp-server' } });
    clickAddSubmit();

    expect(await screen.findByText(/something exploded/)).toBeInTheDocument();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).toHaveBeenCalled();
  });

  // #799/#800/#755/#763 — classify_mcp_failure marks these Expected on the
  // backend and writes the guidance into the message; the modal's catch-alls
  // still sent them to logger.error, auto-filing a bug report for an org
  // policy, an unreachable gateway, the user's own agent config, or an
  // upstream CLI regression.
  it("logs the backend's Expected environment failures at warn, not error (#799/#800)", async () => {
    vi.mocked(addMcpServer).mockRejectedValue({
      type: 'Other',
      message:
        "Failed to add MCP server: Couldn't load settings from Cloud gateway gw.example.com.\n\nYour organization's agent gateway couldn't be reached. Check your network (or VPN) connection, or run `claude auth login` in a terminal to sign in again, then try again.",
    });

    render(<McpModal />);
    const input = await openAddTab();

    fireEvent.change(input, { target: { value: 'my-server -- npx -y @some/mcp-server' } });
    clickAddSubmit();

    expect(await screen.findByText(/agent gateway couldn't be reached/i)).toBeInTheDocument();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.warn as Fn).toHaveBeenCalledWith(
      'Failed to add MCP server: environment or agent-config condition',
      expect.objectContaining({ error: expect.stringContaining('Cloud gateway') as unknown })
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
  });

  it('surfaces an Expected remove failure as an info toast at warn level (#755)', async () => {
    vi.mocked(listMcpServers).mockResolvedValue([
      {
        name: 'sentry',
        command_or_url: 'https://mcp.sentry.dev/mcp',
        status: 'connected',
        scope: 'user',
      },
    ]);
    vi.mocked(removeMcpServer).mockRejectedValue({
      type: 'Other',
      message:
        "Failed to remove MCP server: failed to load configuration\n\nThe agent CLI couldn't read its own config file — a setting in it (`service_tier`) has a value this version no longer accepts. Fix or remove that setting in the config file named above, then try again.",
    });

    render(<McpModal />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining("couldn't read its own config file"),
        'info'
      );
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the logger mock's calls, not invoking it bound
    expect(logger.error as Fn).not.toHaveBeenCalled();
  });
});
