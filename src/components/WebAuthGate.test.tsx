import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebAuthGate } from './WebAuthGate';

describe('WebAuthGate', () => {
  let tauriInternals: unknown;

  beforeEach(() => {
    tauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = tauriInternals;
    vi.unstubAllGlobals();
  });

  it('exchanges the server token before rendering the app', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <WebAuthGate>
        <div>Protected app</div>
      </WebAuthGate>
    );

    const input = await screen.findByLabelText('Auth token');
    fireEvent.change(input, { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Protected app')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/login',
      expect.objectContaining({ body: JSON.stringify({ token: 'secret-token' }) })
    );
  });
});
