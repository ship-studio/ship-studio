/**
 * The Deployments panel, and specifically the state it spent this whole branch
 * getting wrong: a project that deploys nowhere.
 *
 * `provider` was a two-state value — `null` meaning both "we haven't asked
 * yet" and "asked, nothing there". The effect that lists deployments bails on
 * a falsy provider, so on a project with no hosting link it never ran,
 * `deployments` stayed `null`, and `null` renders "Loading…". The panel
 * claimed to be loading a request it was never going to make, under a heading
 * reading "Deployments — your host".
 *
 * Nothing caught it. There was no test for this component, the harness covered
 * it only through a palette-command capture that asserts a command doesn't
 * crash rather than what it shows, and a permanent spinner looks exactly like
 * a slow one. It was found by opening the screenshot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { mockIPC } from '@tauri-apps/api/mocks';
import { ModalProvider, useModal } from '../../contexts/ModalContext';
import { DeploymentsModal } from './DeploymentsModal';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

/** Opens the modal on mount, the way the palette command does. */
function OpenIt({ children }: { children: ReactNode }) {
  const { open } = useModal('deployments');
  useEffect(() => {
    open();
  }, [open]);
  return <>{children}</>;
}

function renderModal() {
  return render(
    <ModalProvider>
      <OpenIt>
        <DeploymentsModal projectPath="/test/path" />
      </OpenIt>
    </ModalProvider>
  );
}

/** A `HostingStatus` with no providers — a project that deploys nowhere. */
const UNLINKED = {
  commit: {
    sha: 'abc1234567',
    short_sha: 'abc1234',
    subject: 'Fix the nav',
    branch: 'main',
    has_upstream: true,
  },
  providers: [],
  detected: [],
};

describe('DeploymentsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says a project deploys nowhere instead of loading forever', async () => {
    mockIPC((cmd) => {
      if (cmd === 'get_hosting_status') return UNLINKED;
      throw new Error(`unexpected command in this scenario: ${cmd}`);
    });

    renderModal();

    await waitFor(() => {
      expect(screen.getByText(/doesn’t deploy anywhere yet/i)).toBeInTheDocument();
    });

    // The precise regression: a request that will never be made must not be
    // described as in flight.
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('never puts a placeholder host name in its heading', async () => {
    mockIPC((cmd) => {
      if (cmd === 'get_hosting_status') return UNLINKED;
      throw new Error(`unexpected command in this scenario: ${cmd}`);
    });

    const { container } = renderModal();

    await waitFor(() => {
      expect(screen.getByText(/doesn’t deploy anywhere yet/i)).toBeInTheDocument();
    });

    // "Deployments — your host" was the shipped heading. A title is a name, and
    // naming a thing "your host" tells the reader nothing they didn't know.
    expect(container.textContent).not.toMatch(/your host/i);
    expect(screen.getByText('Deployments')).toBeInTheDocument();
  });

  it('lists what the provider returned once there is a provider', async () => {
    mockIPC((cmd) => {
      if (cmd === 'get_hosting_status') {
        return {
          ...UNLINKED,
          providers: [
            {
              link: { provider: 'vercel', project_id: 'prj_1', source: 'vercel_cli_file' },
              auth: { kind: 'ok' },
              fetched_at: Date.now(),
              from_cache: false,
            },
          ],
        };
      }
      if (cmd === 'list_recent_deployments') {
        return [
          {
            id: 'dpl_1',
            status_label: 'Ready',
            phase: { phase: 'ready' },
            environment: 'production',
            commit_sha: 'abc1234',
            commit_message: 'Fix the nav',
            urls: { aliases: [] },
            created_at: Date.now() - 60_000,
          },
        ];
      }
      if (cmd === 'get_deployment_log') {
        return { deployment_id: 'dpl_1', lines: [], truncated: false };
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    renderModal();

    await waitFor(() => {
      expect(screen.getByText('Fix the nav')).toBeInTheDocument();
    });
    expect(screen.getByText(/Deployments — Vercel/)).toBeInTheDocument();
    expect(screen.queryByText(/doesn’t deploy anywhere yet/i)).not.toBeInTheDocument();
  });
});
