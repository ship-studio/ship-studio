/**
 * AgentsPanel — dashboard surface for managing coding agents.
 *
 * Lists every known agent (Claude Code, Codex, Opencode) with install +
 * auth state, and exposes the full lifecycle without touching onboarding:
 *  - Install / Sign in   — open a terminal modal and run the setup command
 *  - Sign out            — backend command, one click
 *  - Uninstall           — confirm, then backend command
 *  - Set as default      — radio pill, only when installed + authed
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  setDefaultAgentId,
  TERMINAL_COMMANDS,
  SETUP_FRIENDLY_NAMES,
  AGENT_ITEM_PAIRS,
} from '../../lib/setup';
import { initDefaultAgent } from '../../lib/agent';
import {
  AgentStatus,
  getAgentsStatus,
  signOutAgent,
  uninstallAgent,
  disconnectClaudeAccount,
} from '../../lib/agents-management';
import {
  getActiveAccountId,
  listAccounts,
  getAccountCredentialStatus,
  DEFAULT_ACCOUNT_ID,
  type AccountCredentialStatus,
} from '../../lib/accounts';
import { OnboardingTerminal } from '../setup/OnboardingTerminal';
import { ClaudeConnectTerminal } from './ClaudeConnectTerminal';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useWorkspaceConnect } from '../../hooks/useWorkspaceConnect';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  CheckIcon,
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
  GitHubIcon,
  OpencodeIcon,
  VercelIcon,
} from '../icons';

function KebabGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="2.5" cy="7" r="1.3" fill="currentColor" />
      <circle cx="7" cy="7" r="1.3" fill="currentColor" />
      <circle cx="11.5" cy="7" r="1.3" fill="currentColor" />
    </svg>
  );
}

interface TerminalTask {
  agentId: string;
  itemId: string;
  command: string;
  args: string[];
  kind: 'install' | 'auth';
}

interface UninstallConfirm {
  agentId: string;
  displayName: string;
}

function getSetupItemId(agent: AgentStatus, kind: 'install' | 'auth'): string | null {
  // A setup item id (e.g. "cursor") isn't always the binary name (e.g.
  // "cursor-agent"), so match the pair by binary name OR agent id. The other
  // three agents have binaryName === binaryId, so this is a superset.
  const pair = AGENT_ITEM_PAIRS.find(
    (p) => p.binaryId === agent.binaryName || p.binaryId === agent.id
  );
  if (!pair) return null;
  return kind === 'install' ? pair.binaryId : pair.authId;
}

function formatVersion(v: string | null): string | null {
  if (!v) return null;
  // Strip common prefixes (e.g. "Claude Code v1.2.3" → "1.2.3")
  const cleaned = v.replace(/^[^\d]*/, '').split(/\s+/)[0];
  return cleaned || v;
}

function GenericAgentIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 10h2M14 10h2M8 14h8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function iconFor(agentId: string) {
  if (agentId === 'claude-code') {
    return <ClaudeIcon size={18} />;
  }
  if (agentId === 'codex') {
    return <CodexIcon size={18} />;
  }
  if (agentId === 'opencode') {
    return <OpencodeIcon size={18} />;
  }
  if (agentId === 'cursor') {
    return <CursorIcon size={18} />;
  }
  return <GenericAgentIcon size={18} />;
}

function statusLine(a: AgentStatus): string {
  if (!a.installed) return 'Not installed';
  // Expired/needs-reconnect: surface the account (if known) plus the call to action.
  if (a.needsReconnect) {
    return a.authEmail ? `${a.authEmail} · Reconnect needed` : 'Reconnect needed';
  }
  if (!a.authed) return 'Not signed in';
  const v = formatVersion(a.version);
  // Prefer the real account email over the generic "Signed in" when we have it.
  const who = a.authEmail ?? 'Signed in';
  return v ? `v${v} · ${who}` : who;
}

/**
 * Modal for connecting a workspace's isolated Claude login.
 *
 * Two phases:
 *  1. **Email** — the user names the account (display-only) and continues.
 *  2. **Terminal** — a backend-owned PTY runs `claude setup-token`: the browser
 *     opens, the user signs in, then pastes the shown code into the embedded
 *     terminal. Rust scrapes + stores the token (never crossing to the webview)
 *     and signals capture, at which point we report success.
 */
function ClaudeConnectModal({
  workspaceName,
  accountId,
  reconnect,
  onSuccess,
  onClose,
}: {
  workspaceName: string;
  accountId: string;
  reconnect: boolean;
  onSuccess: (email?: string) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<'email' | 'terminal'>('email');
  const [email, setEmail] = useState('');
  // A fresh session id per terminal attempt so "Start over" spawns a new PTY.
  const [sessionId, setSessionId] = useState('');
  const [exited, setExited] = useState(false);
  // Latch capture so a near-simultaneous exit event can't fire a failure toast.
  const capturedRef = useRef(false);

  const trimmedEmail = email.trim() || undefined;

  const beginTerminal = () => {
    capturedRef.current = false;
    setExited(false);
    setSessionId(crypto.randomUUID());
    setPhase('terminal');
  };

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title={reconnect ? 'Reconnect Claude' : 'Connect Claude'}
      className={phase === 'terminal' ? 'agents-panel-terminal-modal' : 'connect-modal'}
    >
      {phase === 'email' ? (
        <div className="connect-modal-body">
          <p>
            A browser window will open. Sign in with the Claude account you want{' '}
            <strong>{workspaceName}</strong> to use — its login stays isolated to this workspace and
            won't affect your other workspaces or your machine's default login.
          </p>
          <label className="connect-modal-field">
            <span>
              Account email <span className="connect-modal-muted">(shown on the card)</span>
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') beginTerminal();
              }}
            />
          </label>
          <div className="connect-modal-actions">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={beginTerminal}>
              Continue
            </Button>
          </div>
        </div>
      ) : (
        <div className="connect-modal-terminal-phase">
          <p className="connect-modal-instructions">
            Sign in in the browser, then <strong>paste the code it shows</strong> into the terminal
            below and press Enter.
          </p>
          <div className="agents-panel-terminal-body">
            <ClaudeConnectTerminal
              key={sessionId}
              sessionId={sessionId}
              accountId={accountId}
              email={trimmedEmail}
              onCaptured={() => {
                capturedRef.current = true;
                onSuccess(trimmedEmail);
              }}
              onExit={() => {
                // Token already captured → success path handles close. Otherwise
                // the user cancelled or login failed; offer a retry.
                if (!capturedRef.current) setExited(true);
              }}
            />
          </div>
          {exited && (
            <div className="connect-modal-actions">
              <span className="connect-modal-muted">Login didn't finish.</span>
              <Button variant="secondary" onClick={beginTerminal}>
                Start over
              </Button>
            </div>
          )}
        </div>
      )}
    </ModalFrame>
  );
}

export function AgentsPanel() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [terminalTask, setTerminalTask] = useState<TerminalTask | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<UninstallConfirm | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // The active workspace decides how Claude auth works: the Default workspace
  // uses the machine's native `claude` login (today's terminal flow), while a
  // non-default workspace gets its own isolated token via the connect modal.
  const [activeAccount, setActiveAccount] = useState<{
    id: string;
    name: string;
    color: string;
    isDefault: boolean;
  } | null>(null);
  // Workspace-scoped login/credential status for the Services rows (GitHub,
  // Vercel). Same source the Settings modal reads, so the two surfaces agree.
  const [credStatus, setCredStatus] = useState<AccountCredentialStatus | null>(null);
  // When set, the Claude connect/reconnect modal is open for the active workspace.
  const [claudeConnect, setClaudeConnect] = useState<{ reconnect: boolean } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Stable handle to openTerminal so auth routing doesn't depend on definition
  // order; kept current by an effect once openTerminal is defined below.
  const openTerminalRef = useRef<(agent: AgentStatus, kind: 'install' | 'auth') => void>(() => {});
  const { showToast } = useOptionalToast();

  const isWorkspaceActive = !!activeAccount && !activeAccount.isDefault;

  // Keep showToast in a ref so refresh() has a stable identity — otherwise
  // the mount effect re-fires on every render (useOptionalToast returns a
  // fresh object each render when there's no ToastProvider), causing a
  // storm of refetches that makes the default pill flicker.
  const showToastRef = useRef(showToast);
  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  const refresh = useCallback(async () => {
    try {
      const data = await getAgentsStatus();
      setAgents(data);
    } catch (err) {
      logger.warn('Failed to load agent status');
      showToastRef.current(
        `Failed to load agents: ${formatCommandError(asCommandError(err))}`,
        'error'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Resolve the active workspace so Claude auth routes to the right flow.
  useEffect(() => {
    void (async () => {
      try {
        const [id, accounts] = await Promise.all([getActiveAccountId(), listAccounts()]);
        const acc = accounts.find((a) => a.id === id);
        setActiveAccount(
          acc
            ? { id: acc.id, name: acc.name, color: acc.color, isDefault: acc.isDefault }
            : {
                id,
                name: 'Workspace',
                color: 'var(--text-muted)',
                isDefault: id === DEFAULT_ACCOUNT_ID,
              }
        );
      } catch {
        // Fall back to treating it as Default (native login) on failure.
        setActiveAccount({
          id: DEFAULT_ACCOUNT_ID,
          name: 'Default',
          color: 'var(--text-muted)',
          isDefault: true,
        });
      }
    })();
  }, []);

  // Workspace-scoped login status for the Services rows. Shells out to
  // `gh auth status` / `vercel whoami` (~10s worst case), so fetch on mount and
  // after connect actions — never on a tight poll.
  const loadCredStatus = useCallback(async (accountId: string) => {
    try {
      setCredStatus(await getAccountCredentialStatus(accountId));
    } catch {
      logger.warn('Failed to load workspace credential status');
    }
  }, []);

  useEffect(() => {
    if (activeAccount) void loadCredStatus(activeAccount.id);
  }, [activeAccount, loadCredStatus]);

  // Reload everything after a connect/disconnect. A freshly-written auth
  // indicator can land a beat late, so re-check on the same staggered cadence
  // the agent rows use.
  const refreshAll = useCallback(() => {
    void refresh();
    const id = activeAccount?.id;
    if (id) {
      void loadCredStatus(id);
      [600, 1500, 3000].forEach((delay) => setTimeout(() => void loadCredStatus(id), delay));
    }
  }, [refresh, loadCredStatus, activeAccount]);

  // One shared connect layer for the Services rows (GitHub, Vercel), the same
  // hook the per-workspace Settings modal uses so the surfaces never drift.
  const {
    connect: connectService,
    disconnect: disconnectService,
    modals: connectModals,
  } = useWorkspaceConnect({
    accountId: activeAccount?.id ?? DEFAULT_ACCOUNT_ID,
    accountName: activeAccount?.name ?? 'Workspace',
    isDefault: activeAccount?.isDefault ?? true,
    onChanged: refreshAll,
  });

  // Close kebab menu on outside click
  useEffect(() => {
    if (!openMenuId) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [openMenuId]);

  const handleSetDefault = useCallback(
    async (agentId: string) => {
      if (busy) return;
      // Don't optimistically flip isDefault — that causes visible back-and-
      // forth while the backend write + any in-flight refresh races. Instead,
      // render an explicit "Switching…" state on the target pill until the
      // backend confirms, then apply the new default in a single update.
      setBusy(agentId);
      try {
        await setDefaultAgentId(agentId);
        initDefaultAgent(agentId);
        // Apply the final transition in a single setState so React renders
        // the new default without intermediate states.
        setAgents((current) => current.map((a) => ({ ...a, isDefault: a.id === agentId })));
      } catch (err) {
        showToast(`Failed to set default: ${formatCommandError(asCommandError(err))}`, 'error');
      } finally {
        setBusy(null);
      }
    },
    [busy, showToast]
  );

  const handleSignOut = useCallback(
    async (agent: AgentStatus) => {
      if (busy) return;
      setOpenMenuId(null);
      setBusy(agent.id);
      try {
        // Claude in a non-default workspace is the per-workspace token, not the
        // file-based native login — clear the vaulted token instead.
        if (agent.id === 'claude-code' && isWorkspaceActive && activeAccount) {
          await disconnectClaudeAccount(activeAccount.id);
        } else {
          await signOutAgent(agent.id);
        }
        showToast(`Signed out of ${agent.displayName}`, 'success');
        await refresh();
      } catch (err) {
        showToast(`Sign out failed: ${formatCommandError(asCommandError(err))}`, 'error');
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh, showToast, isWorkspaceActive, activeAccount]
  );

  // Route a Claude "Sign in"/"Reconnect" to the per-workspace token flow when a
  // non-default workspace is active; everything else uses the terminal flow.
  const startAuth = useCallback(
    (agent: AgentStatus, reconnect: boolean) => {
      setOpenMenuId(null);
      if (agent.id === 'claude-code' && isWorkspaceActive) {
        setClaudeConnect({ reconnect });
      } else {
        openTerminalRef.current(agent, 'auth');
      }
    },
    [isWorkspaceActive]
  );

  // Called by the connect modal once Rust has captured + stored the token.
  const handleClaudeConnected = useCallback(
    (email?: string) => {
      showToast(email ? `Connected Claude as ${email}` : 'Connected Claude', 'success');
      setClaudeConnect(null);
      void refresh();
    },
    [refresh, showToast]
  );

  const handleUninstall = useCallback(
    async (agentId: string, displayName: string) => {
      setConfirmUninstall(null);
      setBusy(agentId);
      try {
        await uninstallAgent(agentId);
        showToast(`Uninstalled ${displayName}`, 'success');
        await refresh();
      } catch (err) {
        showToast(`Uninstall failed: ${formatCommandError(asCommandError(err))}`, 'error');
      } finally {
        setBusy(null);
      }
    },
    [refresh, showToast]
  );

  const openTerminal = useCallback((agent: AgentStatus, kind: 'install' | 'auth') => {
    setOpenMenuId(null);
    const itemId = getSetupItemId(agent, kind);
    if (!itemId) {
      return;
    }
    const cmd = TERMINAL_COMMANDS[itemId];
    if (!cmd) return;
    setTerminalTask({
      agentId: agent.id,
      itemId,
      command: cmd.command,
      args: cmd.args,
      kind,
    });
  }, []);

  // Keep the ref pointed at the latest openTerminal so startAuth can call it
  // without a definition-order dependency.
  useEffect(() => {
    openTerminalRef.current = openTerminal;
  }, [openTerminal]);

  const handleTerminalExit = useCallback(
    (exitCode: number | null) => {
      setTerminalTask(null);
      // Auth/install files (and newly-installed binaries) can land a beat after
      // the child process exits. Refresh immediately and then retry a few times
      // so a freshly-installed agent shows up without requiring a manual reload.
      void refresh();
      [600, 1500, 3000].forEach((delay) => setTimeout(() => void refresh(), delay));
      if (exitCode !== null && exitCode !== 0) {
        logger.info('Agent terminal exited with non-zero code', { exitCode });
      }
    },
    [refresh]
  );

  return (
    <section className="agents-panel" ref={panelRef}>
      <header className="agents-panel-header">
        <div>
          <h3 className="agents-panel-title">Workspace accounts</h3>
          <p className="agents-panel-subtitle">
            Logins for{' '}
            {activeAccount && (
              <span className="agents-panel-badge">
                <span
                  className="agents-panel-badge-dot"
                  style={{ background: activeAccount.color }}
                />
                {activeAccount.name}
              </span>
            )}{' '}
            — each workspace signs in separately, like a separate client.
          </p>
        </div>
        {loading && <Spinner size="sm" className="agents-panel-spinner" />}
      </header>

      <p className="agents-section-title">Coding agents</p>
      <div className="agents-panel-list">
        {agents.map((agent) => {
          // "Ready" (eligible to be the default agent) means connected AND valid.
          // A needs-reconnect agent is excluded so it shows Reconnect, not the pill.
          const ready = agent.installed && agent.authed && !agent.needsReconnect;
          const isBusy = busy === agent.id;
          const menuOpen = openMenuId === agent.id;
          // Stroke: red when attention needed, green when connected & valid,
          // neutral otherwise (never-connected keeps today's plain border).
          const stateClass = agent.needsReconnect
            ? 'needs-reconnect'
            : agent.authed
              ? 'is-connected'
              : '';

          return (
            <div
              key={agent.id}
              className={`agents-panel-row ${agent.isDefault ? 'is-default' : ''} ${stateClass}`}
            >
              <div className="agents-panel-row-icon">{iconFor(agent.id)}</div>

              <div className="agents-panel-row-main">
                <div className="agents-panel-row-name">{agent.displayName}</div>
                <div className="agents-panel-row-status">{statusLine(agent)}</div>
              </div>

              <div className="agents-panel-row-actions">
                {!agent.installed && agent.installSupported && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => openTerminal(agent, 'install')}
                    disabled={isBusy}
                  >
                    Install
                  </Button>
                )}

                {agent.installed && !agent.authed && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => startAuth(agent, false)}
                    disabled={isBusy}
                  >
                    Sign in
                  </Button>
                )}

                {agent.installed && agent.needsReconnect && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="agents-reconnect-btn"
                    onClick={() => startAuth(agent, true)}
                    disabled={isBusy}
                  >
                    Reconnect
                  </Button>
                )}

                {ready &&
                  (() => {
                    const isSwitchingToThis = busy === agent.id && !agent.isDefault;
                    const anySwitching = busy !== null;
                    return (
                      <button
                        type="button"
                        className={`agents-default-pill ${agent.isDefault ? 'on' : ''} ${isSwitchingToThis ? 'switching' : ''}`}
                        onClick={() => {
                          if (!agent.isDefault) void handleSetDefault(agent.id);
                        }}
                        disabled={anySwitching || agent.isDefault}
                        aria-pressed={agent.isDefault}
                        aria-busy={isSwitchingToThis || undefined}
                      >
                        <span className="agents-default-pill-radio">
                          {isSwitchingToThis ? (
                            <Spinner size="sm" />
                          ) : agent.isDefault ? (
                            <CheckIcon size={10} />
                          ) : null}
                        </span>
                        {isSwitchingToThis
                          ? 'Switching…'
                          : agent.isDefault
                            ? 'Default'
                            : 'Set default'}
                      </button>
                    );
                  })()}

                {agent.installed && (
                  <div className="agents-panel-menu-wrap">
                    <button
                      type="button"
                      className="agents-panel-kebab"
                      onClick={() => setOpenMenuId(menuOpen ? null : agent.id)}
                      title={`More actions for ${agent.displayName}`}
                      aria-label={`More actions for ${agent.displayName}`}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      disabled={isBusy}
                    >
                      <KebabGlyph />
                    </button>
                    {menuOpen && (
                      <div className="agents-panel-menu" role="menu">
                        {agent.installSupported && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => openTerminal(agent, 'install')}
                          >
                            Update
                          </button>
                        )}
                        {agent.authed && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void handleSignOut(agent)}
                          >
                            Sign out
                          </button>
                        )}
                        {!agent.authed && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => startAuth(agent, false)}
                          >
                            Sign in
                          </button>
                        )}
                        {agent.uninstallSupported && (
                          <button
                            type="button"
                            role="menuitem"
                            className="agents-panel-menu-danger"
                            onClick={() => {
                              setOpenMenuId(null);
                              setConfirmUninstall({
                                agentId: agent.id,
                                displayName: agent.displayName,
                              });
                            }}
                          >
                            Uninstall
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {activeAccount && (
        <>
          <p className="agents-section-title">Services</p>
          <div className="agents-panel-list">
            {(
              [
                {
                  id: 'github' as const,
                  name: 'GitHub',
                  icon: <GitHubIcon size={18} />,
                  identity: credStatus?.githubAuthEmail ?? null,
                },
                {
                  id: 'vercel' as const,
                  name: 'Vercel',
                  icon: <VercelIcon size={16} />,
                  identity: credStatus?.vercelUsername ?? null,
                },
              ] as const
            ).map((svc) => {
              const connected = !!svc.identity;
              const menuKey = `service:${svc.id}`;
              const menuOpen = openMenuId === menuKey;
              // Until the (slow) status fetch resolves, say "Checking…" rather
              // than flashing a false "Not connected".
              const statusText = connected
                ? svc.identity
                : credStatus
                  ? 'Not connected'
                  : 'Checking…';
              // Services never show the red reconnect stroke — there's no expiry
              // signal here, only connected vs. never-connected (neutral border).
              const stateClass = connected ? 'is-connected' : '';
              // Disconnect manages the workspace's own credential; the Default
              // workspace's logins are the machine's native ones — leave untouched.
              const canDisconnect = connected && !activeAccount.isDefault;

              return (
                <div key={svc.id} className={`agents-panel-row ${stateClass}`}>
                  <div className="agents-panel-row-icon">{svc.icon}</div>

                  <div className="agents-panel-row-main">
                    <div className="agents-panel-row-name">{svc.name}</div>
                    <div className="agents-panel-row-status">{statusText}</div>
                  </div>

                  <div className="agents-panel-row-actions">
                    {!connected && (
                      <Button variant="primary" size="sm" onClick={() => connectService(svc.id)}>
                        Connect
                      </Button>
                    )}

                    {connected && (
                      <div className="agents-panel-menu-wrap">
                        <button
                          type="button"
                          className="agents-panel-kebab"
                          onClick={() => setOpenMenuId(menuOpen ? null : menuKey)}
                          title={`More actions for ${svc.name}`}
                          aria-label={`More actions for ${svc.name}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                        >
                          <KebabGlyph />
                        </button>
                        {menuOpen && (
                          <div className="agents-panel-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setOpenMenuId(null);
                                connectService(svc.id);
                              }}
                            >
                              {activeAccount.isDefault ? 'Sign in again' : 'Switch account'}
                            </button>
                            {canDisconnect && (
                              <button
                                type="button"
                                role="menuitem"
                                className="agents-panel-menu-danger"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  void disconnectService(svc.id);
                                }}
                              >
                                Disconnect
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {connectModals}

      {claudeConnect && activeAccount && (
        <ClaudeConnectModal
          workspaceName={activeAccount.name}
          accountId={activeAccount.id}
          reconnect={claudeConnect.reconnect}
          onSuccess={handleClaudeConnected}
          onClose={() => setClaudeConnect(null)}
        />
      )}

      {terminalTask && (
        <ModalFrame
          isOpen
          onClose={() => handleTerminalExit(null)}
          title={`${SETUP_FRIENDLY_NAMES[terminalTask.itemId] ?? terminalTask.itemId}`}
          className="agents-panel-terminal-modal"
        >
          <div className="agents-panel-terminal-body">
            <OnboardingTerminal
              command={terminalTask.command}
              args={terminalTask.args}
              onExit={handleTerminalExit}
            />
          </div>
        </ModalFrame>
      )}

      {confirmUninstall && (
        <ModalFrame
          isOpen
          onClose={() => setConfirmUninstall(null)}
          title={`Uninstall ${confirmUninstall.displayName}?`}
          className="agents-panel-confirm-modal"
        >
          <div className="agents-panel-confirm-body">
            <p>
              This removes the {confirmUninstall.displayName} CLI from your machine. You can
              reinstall it any time from this panel.
            </p>
            <div className="agents-panel-confirm-actions">
              <Button variant="secondary" onClick={() => setConfirmUninstall(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  void handleUninstall(confirmUninstall.agentId, confirmUninstall.displayName)
                }
              >
                Uninstall
              </Button>
            </div>
          </div>
        </ModalFrame>
      )}
    </section>
  );
}
