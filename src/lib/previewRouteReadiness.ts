/** Confirm a route on an already-running preview before following it. */
export async function waitForPreviewRoute(
  probe: () => Promise<number | null>,
  isCurrent: () => boolean,
  options: { maxAttempts?: number; retryDelayMs?: (attempt: number) => number } = {}
): Promise<'ready' | 'cancelled' | 'not-ready'> {
  const maxAttempts = options.maxAttempts ?? 6;
  const retryDelayMs =
    options.retryDelayMs ?? ((attempt: number) => Math.min(250 * 2 ** attempt, 1000));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!isCurrent()) return 'cancelled';
    let status: number | null = null;
    try {
      status = await probe();
    } catch {
      // A stopped server or an unavailable probe is treated as not ready.
    }
    if (!isCurrent()) return 'cancelled';
    if (status !== null && status >= 200 && status < 400) return 'ready';
    if (attempt + 1 < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
  return 'not-ready';
}
