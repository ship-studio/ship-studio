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
// `?raw` rather than node:fs — `src` carries no node type declarations, and
// Vite resolves this at build time, so the assertion cannot drift from the file
// it claims to be reading.
import workspaceModalsSource from '../workspace/WorkspaceModals.tsx?raw';

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

    renderModal();

    await waitFor(() => {
      expect(screen.getByText(/doesn’t deploy anywhere yet/i)).toBeInTheDocument();
    });

    // `document.body`, not the render container: ModalFrame renders through a
    // portal, so `container.textContent` is the empty string and a negative
    // assertion against it passes whatever the modal actually says.
    expect(document.body.textContent).not.toMatch(/your host/i);
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

  it("drops the previous project's deployments when the path changes", async () => {
    // Everything in this component is scoped to one project, so the reset is a
    // remount rather than a pile of clears the component must remember to
    // keep in step. `WorkspaceModals` supplies the key; this renders the same
    // composition, because testing the component without it would assert a
    // guarantee the product does not actually have.
    mockIPC((cmd, args) => {
      const path = (args as { projectPath?: string })?.projectPath;
      if (cmd === 'get_hosting_status') {
        if (path === '/project/b') return UNLINKED;
        return {
          ...UNLINKED,
          providers: [
            {
              link: { provider: 'vercel', project_id: 'prj_a', source: 'vercel_cli_file' },
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
            id: 'dpl_a',
            status_label: 'Ready',
            phase: { phase: 'ready' },
            environment: 'production',
            commit_sha: 'aaa1111',
            commit_message: 'Project A deploy',
            urls: { aliases: [] },
            created_at: Date.now() - 60_000,
          },
        ];
      }
      if (cmd === 'get_deployment_log') {
        return { deployment_id: 'dpl_a', lines: [], truncated: false };
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const tree = (path: string) => (
      <ModalProvider>
        <OpenIt>
          <DeploymentsModal key={path} projectPath={path} />
        </OpenIt>
      </ModalProvider>
    );

    const { rerender } = render(tree('/project/a'));
    await waitFor(() => {
      expect(screen.getByText('Project A deploy')).toBeInTheDocument();
    });

    rerender(tree('/project/b'));
    await waitFor(() => {
      expect(screen.getByText(/doesn\u2019t deploy anywhere yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Project A deploy')).not.toBeInTheDocument();
  });

  it("prints the provider's own status word, not a synonym for it", async () => {
    // The Push row shows Vercel's "Ready"; this list used to call the same
    // deployment "Live", and "Error" read as "Failed". One deployment, two
    // vocabularies, inside the feature rewritten to stop doing exactly that.
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

    expect(document.body.textContent).toContain('Ready');
    expect(document.body.textContent).not.toContain('Live');
  });

  it('is keyed by project path where it is actually rendered', () => {
    // The test above proves the remount clears everything; it cannot prove the
    // product asks for one. Removing the key would leave that test green and
    // put the previous project's deploys back on screen under the new
    // project's name, so the call site is asserted directly.
    const source = workspaceModalsSource;
    expect(source).toMatch(/<DeploymentsModal\s+key=\{projectPath\}/);
  });
});
