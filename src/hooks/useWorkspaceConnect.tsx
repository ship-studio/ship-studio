/**
 * useWorkspaceConnect — one shared connect/disconnect layer for a workspace's
 * per-client logins (GitHub, Codex, Opencode, Vercel), consumed by *both* the
 * dashboard's Workspace-accounts card and the per-workspace Settings modal so
 * the two surfaces can never drift.
 *
 * It owns the modal state and renders the right flow per service:
 *  - **Vercel** → {@link VercelTokenModal} (token paste; works for any workspace).
 *  - **GitHub / Codex / Opencode**, non-default workspace → {@link WorkspaceConnectModal}
 *    (backend PTY under the workspace's isolated env, so creds land in its config dir).
 *  - **GitHub / Codex / Opencode**, Default workspace → the native CLI login in an
 *    in-webview {@link OnboardingTerminal} (the machine's native env, left untouched).
 *
 * Claude is intentionally *not* handled here — it keeps its existing token-capture
 * flow in {@link AgentsPanel} (a global-keychain entry needs `resolve_claude_identity`,
 * not a config-dir login).
 *
 * @module hooks/useWorkspaceConnect
 */

import { useCallback, useState, type ReactNode } from 'react';
import { ModalFrame } from '../components/primitives/ModalFrame';
import { OnboardingTerminal } from '../components/setup/OnboardingTerminal';
import { WorkspaceConnectModal } from '../components/dashboard/WorkspaceConnectModal';
import { VercelTokenModal } from '../components/dashboard/VercelTokenModal';
import {
  clearAccountCredential,
  workspaceDisconnectService,
  notifyAccountCredentialsChanged,
  type WorkspaceConnectService,
} from '../lib/accounts';
import { useOptionalToast } from '../contexts/ToastContext';

/** Every login this hook can connect. (`vercel` is token-based, the rest are PTY.) */
export type ConnectServiceId = WorkspaceConnectService | 'vercel';

/**
 * Native CLI login command per service, used for the Default workspace — which
 * deliberately uses the machine's native logins (no token injection, nothing
 * pinned to an isolated config dir). Vercel here is the native browser login,
 * NOT a token, so Default is never given an injected `VERCEL_TOKEN`.
 */
const NATIVE_LOGIN: Record<ConnectServiceId, { command: string; args: string[] }> = {
  github: { command: 'gh', args: ['auth', 'login', '--web', '--git-protocol', 'https'] },
  codex: { command: 'codex', args: ['login'] },
  opencode: { command: 'opencode', args: ['auth', 'login'] },
  vercel: { command: 'vercel', args: ['login'] },
};

const SERVICE_LABEL: Record<ConnectServiceId, string> = {
  github: 'GitHub',
  codex: 'Codex',
  opencode: 'Opencode',
  vercel: 'Vercel',
};

interface UseWorkspaceConnectArgs {
  accountId: string;
  accountName: string;
  isDefault: boolean;
  /** Called after a successful connect/disconnect so callers can re-fetch status. */
  onChanged?: () => void;
}

export function useWorkspaceConnect({
  accountId,
  accountName,
  isDefault,
  onChanged,
}: UseWorkspaceConnectArgs) {
  const { showToast } = useOptionalToast();
  const [ptyService, setPtyService] = useState<WorkspaceConnectService | null>(null);
  const [nativeService, setNativeService] = useState<ConnectServiceId | null>(null);
  const [vercelOpen, setVercelOpen] = useState(false);

  const connect = useCallback(
    (service: ConnectServiceId) => {
      // Default workspace uses the machine's native logins for everything (incl.
      // Vercel's browser login) — never a token, never an isolated config dir.
      if (isDefault) {
        setNativeService(service);
        return;
      }
      // A non-default workspace: Vercel via token (its browser login is global
      // and would bleed across workspaces), the rest via the backend PTY under
      // the workspace's isolated env.
      if (service === 'vercel') {
        setVercelOpen(true);
      } else {
        setPtyService(service);
      }
    },
    [isDefault]
  );

  const disconnect = useCallback(
    async (service: ConnectServiceId) => {
      try {
        if (service === 'vercel') {
          await clearAccountCredential(accountId, 'vercel_token');
        } else {
          // Backend rejects the Default workspace (native logins are managed by
          // the CLI directly), so only offer this for non-default workspaces.
          await workspaceDisconnectService(accountId, service);
        }
        showToast(`Disconnected ${SERVICE_LABEL[service]}`, 'success');
        onChanged?.();
      } catch (err) {
        showToast(`Couldn't disconnect ${SERVICE_LABEL[service]}: ${String(err)}`, 'error');
      }
    },
    [accountId, showToast, onChanged]
  );

  const succeed = useCallback(
    (service: ConnectServiceId, message?: string) => {
      showToast(message ?? `Connected ${SERVICE_LABEL[service]}`, 'success');
      // The workspace's login env just changed — let open terminals surface a
      // "restart to apply" banner (PTY/native logins don't go through the
      // credential-vault wrappers that already emit this).
      notifyAccountCredentialsChanged(accountId);
      onChanged?.();
    },
    [showToast, onChanged, accountId]
  );

  const modals: ReactNode = (
    <>
      {ptyService && (
        <WorkspaceConnectModal
          accountId={accountId}
          workspaceName={accountName}
          service={ptyService}
          onSuccess={() => {
            const svc = ptyService;
            setPtyService(null);
            succeed(svc);
          }}
          onClose={() => setPtyService(null)}
        />
      )}

      {nativeService && (
        <ModalFrame
          isOpen
          onClose={() => setNativeService(null)}
          title={`Connect ${SERVICE_LABEL[nativeService]}`}
          className="agents-panel-terminal-modal"
        >
          <div className="agents-panel-terminal-body">
            <OnboardingTerminal
              command={NATIVE_LOGIN[nativeService].command}
              args={NATIVE_LOGIN[nativeService].args}
              onExit={(code) => {
                const svc = nativeService;
                setNativeService(null);
                // Native login: exit 0 == success. A late-written indicator is
                // picked up by the caller's staggered refresh.
                if (code === 0 && svc) succeed(svc);
              }}
            />
          </div>
        </ModalFrame>
      )}

      {vercelOpen && (
        <VercelTokenModal
          accountId={accountId}
          workspaceName={accountName}
          onSaved={() => {
            setVercelOpen(false);
            succeed('vercel', 'Connected Vercel');
          }}
          onClose={() => setVercelOpen(false)}
        />
      )}
    </>
  );

  return { connect, disconnect, modals };
}
