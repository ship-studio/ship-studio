/**
 * The connect modal — the first hosting screen anybody touches, and the only
 * one that writes a credential.
 *
 * It shipped with no test and no harness scenario. What that hid is worth
 * stating, because these tests are written around it rather than over it:
 *
 * **Nothing checks the token.** `verify_hosting_token` exists as a registered
 * Tauri command with no callers, so Save writes whatever is in the field to the
 * keychain and closes. A wrong, expired or under-permissioned token is stored
 * without a word, and the user's first sign that anything is wrong is the same
 * row they were trying to fix still saying the connection is broken. These
 * tests pin the write itself (the token that reaches the keychain is the
 * trimmed one, the failure path keeps the dialog open) and deliberately do
 * *not* assert that verification is absent — a test asserting the absence of a
 * check would stand in the way of adding one.
 *
 * Note `document.body`, not `container`: `ModalFrame` renders through a portal,
 * so `container.textContent` is `''` and any assertion against it passes no
 * matter what the dialog says. That mistake is recorded in
 * `docs/verifying-your-own-work.md`; it is not repeated here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockIPC } from '@tauri-apps/api/mocks';
import { ToastContext } from '../../contexts/ToastContext';
import { HostingTokenModal } from './HostingTokenModal';
import type { HostingProvider } from '../../lib/hosting';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const showToast = vi.fn();

function renderModal(
  over: Partial<{ provider: HostingProvider; wasRejected: boolean }> = {},
  handlers: Partial<{ onSaved: () => void; onClose: () => void }> = {}
) {
  const onSaved = handlers.onSaved ?? vi.fn();
  const onClose = handlers.onClose ?? vi.fn();
  render(
    <ToastContext.Provider value={{ toasts: [], showToast, dismissToast: vi.fn() }}>
      <HostingTokenModal
        provider={over.provider ?? 'vercel'}
        accountId="default"
        workspaceName="this workspace"
        wasRejected={over.wasRejected ?? false}
        onSaved={onSaved}
        onClose={onClose}
      />
    </ToastContext.Provider>
  );
  return { onSaved, onClose };
}

/** Every command the modal invoked, in order, with its arguments. */
function recordCalls() {
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    return null;
  });
  return calls;
}

const field = () => screen.getByPlaceholderText(/x{4,}/i);
const saveButton = () => screen.getByRole('button', { name: /^save/i });

describe('HostingTokenModal', () => {
  beforeEach(() => {
    showToast.mockClear();
  });

  it('will not save an empty field', () => {
    recordCalls();
    renderModal();

    expect(saveButton()).toBeDisabled();
  });

  it('enables Save as soon as anything is typed — the only gate on the value', async () => {
    recordCalls();
    renderModal();

    await userEvent.type(field(), 'x');

    // One character. There is no format check, no length check and no call to
    // the provider between here and the keychain; this assertion is the whole
    // of the validation, which is the point of writing it down.
    expect(saveButton()).toBeEnabled();
  });

  it('writes the pasted token to the keychain under the provider’s own key', async () => {
    const calls = recordCalls();
    const { onSaved } = renderModal();

    await userEvent.type(field(), 'vercel_TOKEN123');
    await userEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls).toEqual([
      {
        cmd: 'set_account_credential',
        args: { id: 'default', key: 'vercel_token', value: 'vercel_TOKEN123' },
      },
    ]);
  });

  it('trims the whitespace a copied token arrives with', async () => {
    const calls = recordCalls();
    renderModal();

    // Copying from a provider's UI routinely brings a trailing newline or
    // space with it, and a credential store keeps whatever it is handed.
    await userEvent.type(field(), '  nfp_TOKEN456  ');
    await userEvent.click(saveButton());

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].args.value).toBe('nfp_TOKEN456');
  });

  it('keeps the dialog open, and the typed token, when the write fails', async () => {
    mockIPC(() => {
      throw new Error('The keychain refused to store this item');
    });
    const { onSaved } = renderModal();

    await userEvent.type(field(), 'vercel_TOKEN123');
    await userEvent.click(saveButton());

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast.mock.calls[0][0]).toMatch(/couldn't save the vercel token/i);
    expect(showToast.mock.calls[0][1]).toBe('error');
    // The flow must not report success it did not have.
    expect(onSaved).not.toHaveBeenCalled();
    // And the user must not have to retype a token they just pasted.
    expect(field()).toHaveValue('vercel_TOKEN123');
    expect(saveButton()).toBeEnabled();
  });

  it('shows a by-design refusal without filing it as a bug (#942)', async () => {
    const message =
      "Per-workspace credentials are only stored on macOS at the moment — Ship Studio has no credential vault on this platform yet. Use the default workspace, or sign in with the provider's own CLI (`vercel login`, `gh auth login`, `claude /login`), and this project will use those credentials.";
    mockIPC(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the IPC rejection shape
      throw { type: 'Other', message, expected: true };
    });
    renderModal();

    await userEvent.type(field(), 'vercel_TOKEN123');
    await userEvent.click(saveButton());

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(
      `Couldn't save the Vercel token: ${message}`,
      'error',
      undefined,
      { expected: true }
    );
  });

  it('says the old sign-in was refused when that is why we are here', () => {
    recordCalls();
    renderModal({ wasRejected: true });

    expect(document.body.textContent).toMatch(/refused the sign-in/i);
    // Never the first-run sentence: a user reconnecting has already done this
    // once and needs to know the previous credential is the problem.
    expect(document.body.textContent).not.toMatch(/account this workspace deploys with/i);
  });

  it('warns Cloudflare users about the permission that silently empties the picker', () => {
    recordCalls();
    renderModal({ provider: 'cloudflare' });

    // Without `Account Settings:Read` Cloudflare returns no accounts, so the
    // link picker lists nothing at all — and this sentence is the only warning
    // in the product that happens before that.
    expect(document.body.textContent).toMatch(/Account Settings:Read/);
    expect(document.body.textContent).toMatch(/Cloudflare Pages:Read/);
  });

  it('does not show one provider’s requirements while connecting another', () => {
    recordCalls();
    renderModal({ provider: 'vercel' });

    expect(document.body.textContent).not.toMatch(/Account Settings:Read/);
    expect(document.body.textContent).toMatch(/vercel\.com\/account\/tokens/);
  });

  it('masks the credential rather than printing it into a screenshot', async () => {
    recordCalls();
    renderModal();

    await userEvent.type(field(), 'vercel_TOKEN123');
    expect(field()).toHaveAttribute('type', 'password');
  });
});
