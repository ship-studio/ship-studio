/**
 * Tests for DeviceMirror's fresh-user / agent-setup path — the case a user with no
 * Xcode, Android SDK, or emulator hits. Verifies that instead of dead-ending, the
 * component routes the toolchain setup to the embedded agent.
 *
 * The connected/mirror path isn't exercised here (it needs a live WebSocket +
 * simulator); these tests cover the capability gating, which short-circuits before
 * any connect attempt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ============ Module-level mocks ============

const invokeResults = new Map<string, { value?: unknown; error?: Error; pending?: boolean }>();

function mockInvoke(cmd: string, value: unknown) {
  invokeResults.set(cmd, { value });
}
function mockInvokePending(cmd: string) {
  invokeResults.set(cmd, { pending: true });
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) => {
    const result = invokeResults.get(cmd);
    if (result?.pending) return new Promise(() => {}); // never resolves
    if (result?.error) return Promise.reject(result.error);
    return Promise.resolve(result?.value);
  }),
}));

// Keep xterm / tauri-pty out of jsdom — BuildTerminal isn't rendered on the setup path.
vi.mock('../terminal/BuildTerminal', () => ({
  BuildTerminal: () => <div data-testid="mock-build-terminal" />,
}));

// getWindowLabel touches a Tauri window API absent in jsdom; the connect flow only
// needs a label string.
vi.mock('../../lib/window', () => ({ getWindowLabel: () => 'main' }));

import { DeviceMirror } from './DeviceMirror';

const baseProps = {
  projectName: 'demo',
  projectPath: '/Users/x/ShipStudio/demo',
};

beforeEach(() => {
  invokeResults.clear();
});

describe('DeviceMirror — agent-driven setup (fresh user, no toolchain)', () => {
  it('offers iOS setup with an agent hand-off when the project targets both but no toolchain exists', async () => {
    mockInvoke('detect_mobile_targets', { ios: true, android: true });
    mockInvoke('mobile_platform_support', { ios: false, android: false });
    const onSendToAgent = vi.fn();

    render(<DeviceMirror {...baseProps} onSendToAgent={onSendToAgent} />);

    // Prefers iOS when both are targeted-but-unavailable.
    const setupBtn = await screen.findByRole('button', { name: /set up with ai/i });
    expect(screen.getByText(/set up ios previews/i)).toBeInTheDocument();

    fireEvent.click(setupBtn);
    expect(onSendToAgent).toHaveBeenCalledTimes(1);
    expect(onSendToAgent.mock.calls[0][0]).toMatch(/Xcode command line tools/i);
  });

  it('offers Android setup with the nuanced agent prompt for an Android-only project with no SDK', async () => {
    mockInvoke('detect_mobile_targets', { ios: false, android: true });
    mockInvoke('mobile_platform_support', { ios: false, android: false });
    const onSendToAgent = vi.fn();

    render(<DeviceMirror {...baseProps} onSendToAgent={onSendToAgent} />);

    const setupBtn = await screen.findByRole('button', { name: /set up with ai/i });
    expect(screen.getByText(/set up android previews/i)).toBeInTheDocument();

    fireEvent.click(setupBtn);
    const prompt = onSendToAgent.mock.calls[0][0] as string;
    // The Android prompt bakes in the lessons that bit us: Homebrew ownership,
    // no-sudo home install, creating an AVD.
    expect(prompt).toMatch(/Android SDK/i);
    expect(prompt).toMatch(/Homebrew is owned by another user/i);
    expect(prompt).toMatch(/without sudo/i);
    expect(prompt).toMatch(/AVD/);
  });

  it('does not prematurely show setup while capability detection is still pending', async () => {
    mockInvokePending('detect_mobile_targets');
    mockInvokePending('mobile_platform_support');

    render(<DeviceMirror {...baseProps} onSendToAgent={vi.fn()} />);

    // While detecting: the starting spinner, never the setup CTA.
    await waitFor(() => expect(screen.getByText(/starting the ios preview/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /set up with ai/i })).not.toBeInTheDocument();
  });

  it('does not show the setup view when the targeted platform IS supported', async () => {
    // Targets+supports iOS → it proceeds to connect (start_mobile_preview pending →
    // stays on the spinner); the setup CTA must not appear.
    mockInvoke('detect_mobile_targets', { ios: true, android: false });
    mockInvoke('mobile_platform_support', { ios: true, android: false });
    mockInvokePending('start_mobile_preview');

    render(<DeviceMirror {...baseProps} onSendToAgent={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/starting the ios preview/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /set up with ai/i })).not.toBeInTheDocument();
  });
});
