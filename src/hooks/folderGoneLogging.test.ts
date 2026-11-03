/**
 * Call sites that used to file a bug report when the backend refused a path
 * that is gone or no longer accepted — Expected states, not malfunctions.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../lib/logger', () => ({ logger: log }));
const analytics = vi.hoisted(() => ({
  trackEvent: vi.fn().mockResolvedValue(undefined),
  trackError: vi.fn(),
}));
vi.mock('../lib/analytics', () => analytics);
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('../lib/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/assets')>()),
  listAssets: vi.fn(),
  getAssetsRoot: vi.fn().mockResolvedValue('public'),
}));
vi.mock('../lib/agentBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/agentBridge')>()),
  getAgentBridgeUrl: vi.fn(),
  registerPreviewMcpServer: vi.fn().mockResolvedValue(undefined),
  registerSharedPreviewMcpServers: vi.fn().mockResolvedValue(undefined),
  setAgentBridgeAttached: vi.fn().mockResolvedValue(undefined),
}));

import { listAssets } from '../lib/assets';
import { getAgentBridgeUrl } from '../lib/agentBridge';
import { useAssetManagement } from './useAssetManagement';
import { useAgentBridge } from './useAgentBridge';

// The backend's Expected wording, verbatim from the reports.
const FOLDER_GONE = {
  type: 'Other',
  expected: true,
  message:
    "The folder '<project>' no longer exists — it may have been moved, renamed, or deleted outside Ship Studio",
};
const OUTSIDE_PROJECTS = {
  type: 'Other',
  expected: true,
  message: "Security error: path '<project>' is outside the projects directory",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAssetManagement loadAssets (issue #972)', () => {
  it('warns instead of filing a bug when the project folder is gone', async () => {
    vi.mocked(listAssets).mockRejectedValue(FOLDER_GONE);
    const { result } = renderHook(() =>
      useAssetManagement({ projectPath: '/p', isOpen: true, onToast: vi.fn() })
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith('Failed to load assets', {
        error: FOLDER_GONE.message,
      })
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(analytics.trackError).not.toHaveBeenCalled();
  });

  it('still reports an unexplained failure', async () => {
    vi.mocked(listAssets).mockRejectedValue({ type: 'Io', message: 'boom' });
    renderHook(() => useAssetManagement({ projectPath: '/p', isOpen: true, onToast: vi.fn() }));
    await waitFor(() => expect(log.error).toHaveBeenCalled());
  });
});

describe('useAgentBridge setUp (issues #973/#974)', () => {
  function mount() {
    renderHook(() =>
      useAgentBridge({
        projectPath: '/p',
        currentUrl: null,
        serverReady: false,
        currentPath: '/',
        pages: [],
        navigate: vi.fn(),
        reload: vi.fn(),
        setViewport: vi.fn(),
        getViewportWidth: () => null,
        canvasMode: false,
        getOverlayFrameSize: () => null,
      })
    );
  }

  it.each([
    ['#973', FOLDER_GONE],
    ['#974', OUTSIDE_PROJECTS],
  ])('warns instead of filing a bug (%s)', async (_issue, err) => {
    vi.mocked(getAgentBridgeUrl).mockRejectedValue(err);
    mount();
    await waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith('[AgentBridge] Failed to get bridge URL', {
        error: err.message,
      })
    );
    expect(log.error).not.toHaveBeenCalled();
  });
});
