import { describe, expect, it, vi } from 'vitest';
import { waitForPreviewRoute } from './previewRouteReadiness';

describe('waitForPreviewRoute', () => {
  it('keeps probing after a 404 and only permits navigation after a successful response', async () => {
    const statuses = [404, 200];
    const probe = vi.fn(() => Promise.resolve(statuses.shift() ?? null));
    const navigate = vi.fn();

    const ready = await waitForPreviewRoute(probe, () => true, {
      retryDelayMs: () => 0,
    });
    if (ready === 'ready') navigate();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('stops retrying after the destination or project changes', async () => {
    let current = true;
    const probe = vi.fn(() => {
      current = false;
      return Promise.resolve(404);
    });

    await expect(
      waitForPreviewRoute(probe, () => current, { retryDelayMs: () => 0 })
    ).resolves.toBe('cancelled');
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
