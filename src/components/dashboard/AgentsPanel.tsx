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
} from '../../lib/agents-management';
import { OnboardingTerminal } from '../setup/OnboardingTerminal';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { useOptionalToast } from '../../contexts/ToastContext';
import { logger } from '../../lib/logger';
import { CheckIcon, ClaudeIcon } from '../icons';

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

function getSetupItemId(binaryName: string, kind: 'install' | 'auth'): string | null {
  const pair = AGENT_ITEM_PAIRS.find((p) => p.binaryId === binaryName);
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
  return <GenericAgentIcon size={18} />;
}

function statusLine(a: AgentStatus): string {
  if (!a.installed) return 'Not installed';
  if (!a.authed) return 'Not signed in';
  const v = formatVersion(a.version);
  return v ? `v${v} · Signed in` : 'Signed in';
}

export function AgentsPanel() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [terminalTask, setTerminalTask] = useState<TerminalTask | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<UninstallConfirm | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { showToast } = useOptionalToast();

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
      showToastRef.current(`Failed to load agents: ${String(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        showToast(`Failed to set default: ${String(err)}`, 'error');
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
        await signOutAgent(agent.id);
        showToast(`Signed out of ${agent.displayName}`, 'success');
        await refresh();
      } catch (err) {
        showToast(`Sign out failed: ${String(err)}`, 'error');
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh, showToast]
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
        showToast(`Uninstall failed: ${String(err)}`, 'error');
      } finally {
        setBusy(null);
      }
    },
    [refresh, showToast]
  );

  const openTerminal = useCallback((agent: AgentStatus, kind: 'install' | 'auth') => {
    setOpenMenuId(null);
    const itemId = getSetupItemId(agent.binaryName, kind);
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
          <h3 className="agents-panel-title">Coding Agents</h3>
          <p className="agents-panel-subtitle">
            Install, sign in, or switch the default agent new terminals use.
          </p>
        </div>
        {loading && <Spinner size="sm" className="agents-panel-spinner" />}
      </header>

      <div className="agents-panel-list">
        {agents.map((agent) => {
          const ready = agent.installed && agent.authed;
          const isBusy = busy === agent.id;
          const menuOpen = openMenuId === agent.id;

          return (
            <div
              key={agent.id}
              className={`agents-panel-row ${agent.isDefault ? 'is-default' : ''}`}
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
                    onClick={() => openTerminal(agent, 'auth')}
                    disabled={isBusy}
                  >
                    Sign in
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
                            onClick={() => openTerminal(agent, 'auth')}
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
