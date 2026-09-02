/**
 * The plugin Library tab's empty-state copy must tell the truth about WHY the
 * list is empty:
 *
 * - a reachability failure (offline, GitHub rate limit) keeps the "check your
 *   connection" advice and logs at warn level (#713);
 * - a malformed registry body is our bug, not the user's network — it gets its
 *   own copy and stays a reportable `logger.error`;
 * - a genuinely empty registry says so.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../lib/plugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/plugins')>()),
  listPlugins: vi.fn(),
  fetchPluginRegistry: vi.fn(),
}));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn(), trackError: vi.fn() }));
vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../contexts/ModalContext', () => ({
  useModal: () => ({ isOpen: true, close: vi.fn() }),
}));
vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast: vi.fn() }),
}));

import { PluginManager } from './PluginManager';
import { listPlugins, fetchPluginRegistry } from '../../lib/plugins';
import { logger } from '../../lib/logger';

async function openLibraryTab() {
  // The installed-plugins fetch and the registry fetch both settle after the
  // first paint — flush them inside act so React's warning stays off the output.
  await act(async () => {
    render(<PluginManager onPluginsChanged={vi.fn()} projectPath="/proj" />);
    await Promise.resolve();
  });
  // "Library" also names the shortcut inside the installed-tab empty state —
  // click the tab itself (the Tabs primitive gives it role="tab").
  const tab = screen.getByRole('tab', { name: 'Library' });
  expect(tab).toBeDefined();
  await act(async () => {
    fireEvent.click(tab);
    await Promise.resolve();
  });
}

describe('PluginManager library empty states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listPlugins).mockResolvedValue([]);
  });

  it('keeps the connection copy when the registry is unreachable (#713)', async () => {
    vi.mocked(fetchPluginRegistry).mockRejectedValue(
      new Error('Failed to fetch plugin registry: 429')
    );
    await openLibraryTab();

    expect(await screen.findByText(/Check your connection/)).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the mock's calls, not invoking it bound
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Failed to fetch plugin registry',
      expect.anything()
    );
  });

  it('a malformed registry body gets its own copy, not "check your connection"', async () => {
    vi.mocked(fetchPluginRegistry).mockRejectedValue(
      new SyntaxError('Unexpected end of JSON input')
    );
    await openLibraryTab();

    expect(await screen.findByText(/couldn't read it/)).toBeTruthy();
    expect(screen.queryByText(/Check your connection/)).toBeNull();
    // Still ours to fix — stays on the reportable error channel.
    await waitFor(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting the mock's calls, not invoking it bound
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Failed to fetch plugin registry',
        expect.anything()
      );
    });
  });

  it('says the library is empty when the fetch succeeded with no entries', async () => {
    vi.mocked(fetchPluginRegistry).mockResolvedValue([]);
    await openLibraryTab();

    expect(await screen.findByText(/library is empty right now/)).toBeTruthy();
  });
});
