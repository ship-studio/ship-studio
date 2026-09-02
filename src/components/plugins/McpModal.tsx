/**
 * McpModal component for managing MCP (Model Context Protocol) servers.
 *
 * Provides two tabs:
 * - Connected: View and remove configured MCP servers
 * - Add: Add new MCP servers by pasting CLI commands
 *
 * @module components/McpModal
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import {
  type McpServer,
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  validateMcpAddCommand,
  isMcpUnsupportedCliError,
  isMcpInvalidInputError,
  isMcpExpectedFailure,
} from '../../lib/mcp';
import { trackEvent, trackSearch } from '../../lib/analytics';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError, isAgentNotInstalledError } from '../../lib/errors';
import { useModal } from '../../contexts/ModalContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  ExtensionListRow,
  ExtensionManagerLayout,
  ExtensionSearchField,
  ExtensionState,
  ScopeBadge,
} from './extension';

type Tab = 'connected' | 'add';
type ScopeFilter = 'all' | 'user' | 'project';
type AddScope = 'user' | 'project';

interface McpModalProps {
  projectPath?: string;
  agentId?: string;
  agentDisplayName?: string;
  agentBinaryName?: string;
}

export function McpModal({
  projectPath,
  agentId,
  agentDisplayName = 'Claude',
  agentBinaryName = 'claude',
}: McpModalProps) {
  const { isOpen, close: onClose } = useModal('mcp');
  const { showToast } = useOptionalToast();
  const [activeTab, setActiveTab] = useState<Tab>('connected');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [servers, setServers] = useState<McpServer[]>([]);
  const [isLoadingServers, setIsLoadingServers] = useState(false);
  const [removingServer, setRemovingServer] = useState<string | null>(null);

  // Connected tab search
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Debounce search input
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 150);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQuery]);

  // Add tab state
  const [addCommand, setAddCommand] = useState('');
  const [addScope, setAddScope] = useState<AddScope>('user');
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState(false);

  // Fetch servers when modal opens
  const fetchServers = useCallback(async () => {
    setIsLoadingServers(true);
    try {
      const result = await listMcpServers(projectPath, agentId);
      setServers(result);
    } catch (err) {
      // "Agent CLI not installed" (backend marks it Expected, issue #594) and
      // "CLI too old for mcp subcommands" (issue #550) are user-environment
      // states — logger.error would auto-file a bug report for them.
      const expected = isAgentNotInstalledError(err) || isMcpUnsupportedCliError(err);
      logger[expected ? 'warn' : 'error']('Failed to load MCP servers', {
        error: formatCommandError(asCommandError(err)),
      });
      setServers([]);
    } finally {
      setIsLoadingServers(false);
    }
  }, [projectPath, agentId]);

  useEffect(() => {
    if (!isOpen) return;
    void fetchServers();
  }, [isOpen, fetchServers]);

  // Filter servers based on scope filter and search query
  const filteredServers = servers.filter((server) => {
    if (scopeFilter !== 'all' && server.scope !== scopeFilter) return false;
    if (debouncedQuery) {
      const q = debouncedQuery.toLowerCase();
      return (
        server.name.toLowerCase().includes(q) || server.command_or_url.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Handle add
  const handleAdd = async () => {
    if (!addCommand.trim()) return;

    // Validate before shelling out: a name with no command/URL would only
    // fail at the CLI level with a raw "missing required argument
    // 'commandOrUrl'" usage error (issue #588). Inline feedback, no toast,
    // no log — the user just hasn't finished typing the command. The agentId
    // selects OpenCode's stricter flag-unaware grammar (issue #655).
    const validationError = validateMcpAddCommand(addCommand.trim(), agentBinaryName, agentId);
    if (validationError) {
      setAddError(validationError);
      setAddSuccess(false);
      return;
    }

    setIsAdding(true);
    setAddError(null);
    setAddSuccess(false);

    try {
      await addMcpServer(addCommand.trim(), addScope, projectPath, agentId);
      void trackEvent('mcp_server_added', { scope: addScope, $screen_name: 'MCP Modal' });
      setAddSuccess(true);
      setAddCommand('');
      // Refresh server list and switch to connected tab
      await fetchServers();
      setActiveTab('connected');
    } catch (err) {
      const message = formatCommandError(asCommandError(err));
      if (isMcpUnsupportedCliError(err)) {
        // The installed CLI predates `mcp add` entirely (older Codex builds) —
        // a friendly "update your CLI" beats clap's raw usage dump (issue #550).
        logger.warn('Failed to add MCP server: agent CLI lacks mcp subcommands', {
          error: message,
        });
        setAddError(
          `Your ${agentDisplayName} CLI is too old to manage MCP servers — update ${agentDisplayName} to its latest version, then try again.`
        );
      } else if (isAgentNotInstalledError(err)) {
        // Missing CLI is a user-environment state, not a bug (issue #594).
        logger.warn('Failed to add MCP server: agent CLI not installed', { error: message });
        setAddError(
          `${agentDisplayName} doesn't appear to be installed on this computer, so its MCP servers can't be managed. Install ${agentDisplayName} first, then try again.`
        );
      } else if (isMcpInvalidInputError(err)) {
        // The backend's own input-shape validation (OpenCode config path) —
        // a user-input problem the frontend pre-flight didn't catch, not an
        // app bug. Inline feedback + warn, no auto-filed report (issue #655).
        logger.warn('Failed to add MCP server: input rejected by agent parser', {
          error: message,
        });
        setAddError(message);
      } else if (isMcpExpectedFailure(err)) {
        // Enterprise policy, an unreachable org gateway, the agent CLI's own
        // config, or an upstream `mcp add -e` parser bug — the backend already
        // classified all of these Expected and wrote the guidance into the
        // message. Nothing Ship Studio can fix, so don't auto-file a report
        // (issues #755, #763, #799, #800).
        logger.warn('Failed to add MCP server: environment or agent-config condition', {
          error: message,
        });
        setAddError(message);
      } else {
        logger.error('Failed to add MCP server', { error: message });
        setAddError(message);
      }
    } finally {
      setIsAdding(false);
    }
  };

  // Handle remove
  const serverKey = (s: McpServer) => `${s.scope}-${s.name}`;

  const handleRemove = async (server: McpServer) => {
    setRemovingServer(serverKey(server));
    try {
      await removeMcpServer(server.name, server.scope, projectPath, agentId);
      void trackEvent('mcp_server_removed', { scope: server.scope, $screen_name: 'MCP Modal' });
      await fetchServers();
    } catch (err) {
      const message = formatCommandError(asCommandError(err));
      // CLI wording varies ("No MCP server named …", "No project-local MCP
      // server found with name: …") — match the shape, not exact phrases
      // (#295). The backend now also treats these as success (mcp.rs), so
      // this is defense for wordings that slip through.
      if (/no .*mcp server|not found|no such/i.test(message)) {
        // Already gone (e.g. the preview bridge's remove-then-re-add cycle
        // raced this click) — that's the outcome the user wanted, not an error.
        // (This shape check also swallows "binary not found" — an uninstalled
        // CLI has no servers to remove either way.)
        await fetchServers();
      } else if (isMcpUnsupportedCliError(err)) {
        // CLI too old for `mcp remove` — environment state, not a bug (#550).
        logger.warn('Failed to remove MCP server: agent CLI lacks mcp subcommands', {
          error: message,
        });
        showToast(
          `Your ${agentDisplayName} CLI is too old to manage MCP servers — update it, then try again.`,
          'info'
        );
      } else if (isMcpExpectedFailure(err)) {
        // Same Expected shapes as the add path (#755, #763, #799, #800). The
        // remove path had no user-facing feedback at all on failure, so the
        // row simply stopped spinning — surface the backend's guidance.
        logger.warn('Failed to remove MCP server: environment or agent-config condition', {
          error: message,
        });
        showToast(message, 'info');
      } else {
        logger.error('Failed to remove MCP server', { error: message });
      }
    } finally {
      setRemovingServer(null);
    }
  };

  // Handle key press in add input
  const handleAddKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void handleAdd();
    }
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case 'connected':
        return 'Connected';
      case 'needs_auth':
        return 'Needs authentication';
      case 'error':
        return 'Error';
      default:
        return 'Unknown';
    }
  };

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={`MCP Servers for ${agentDisplayName}`}
      className="mcp-modal"
    >
      <>
        <Tabs
          value={activeTab}
          onValueChange={(next) => {
            const tab = next as Tab;
            setActiveTab(tab);
            if (tab === 'add') {
              setAddError(null);
              setAddSuccess(false);
            }
          }}
        >
          <ExtensionManagerLayout
            tabs={
              <TabsList className="mcp-tabs" aria-label="MCP servers view">
                <TabsTab value="connected" className="mcp-tab">
                  Connected
                </TabsTab>
                <TabsTab value="add" className="mcp-tab">
                  Add
                </TabsTab>
              </TabsList>
            }
            footer={
              <span className="extension-manager-layout__footer-hint">
                Press <span className="help-shortcut">Esc</span> to close
              </span>
            }
          >
            <TabsPanel value="connected" className="mcp-modal-body">
              {activeTab === 'connected' && (
                <>
                  <div className="mcp-connected-controls">
                    <ExtensionSearchField
                      ref={searchRef}
                      placeholder="Filter servers..."
                      aria-label="Filter MCP servers"
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        trackSearch('mcp_filter', e.target.value, 'MCP Modal');
                      }}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                    <Tabs
                      value={scopeFilter}
                      mode="navigation"
                      onValueChange={(next) => setScopeFilter(next as ScopeFilter)}
                    >
                      <TabsList aria-label="Filter MCP servers by scope">
                        <TabsTab value="all">All</TabsTab>
                        <TabsTab value="user">User</TabsTab>
                        <TabsTab value="project">Project</TabsTab>
                      </TabsList>
                    </Tabs>
                  </div>

                  {isLoadingServers && servers.length === 0 && (
                    <ExtensionState kind="loading" loadingLabel="Loading MCP servers">
                      Loading MCP servers...
                    </ExtensionState>
                  )}

                  {!isLoadingServers && filteredServers.length === 0 && (
                    <ExtensionState kind="empty">
                      {debouncedQuery
                        ? 'No matching servers found'
                        : scopeFilter === 'all'
                          ? 'No MCP servers configured yet'
                          : `No ${scopeFilter}-scoped servers configured`}
                    </ExtensionState>
                  )}

                  <div className="mcp-list">
                    {filteredServers.map((server) => (
                      <ExtensionListRow
                        key={`${server.scope}-${server.name}`}
                        action={
                          <Button
                            variant="danger"
                            size="compact"
                            onClick={() => void handleRemove(server)}
                            disabled={removingServer === serverKey(server)}
                          >
                            {removingServer === serverKey(server) ? 'Removing...' : 'Remove'}
                          </Button>
                        }
                      >
                        <div className="mcp-server-info">
                          <div className="mcp-server-name-row">
                            <span
                              className={`mcp-status-dot ${server.status}`}
                              title={statusLabel(server.status)}
                            />
                            <span className="mcp-server-name">{server.name}</span>
                          </div>
                          <div className="mcp-server-meta">
                            <ScopeBadge scope={server.scope} />
                            <span className="mcp-status-label">{statusLabel(server.status)}</span>
                          </div>
                          {server.command_or_url && (
                            <div className="mcp-server-command">{server.command_or_url}</div>
                          )}
                        </div>
                      </ExtensionListRow>
                    ))}
                  </div>
                </>
              )}
            </TabsPanel>

            <TabsPanel value="add" className="mcp-modal-body">
              {activeTab === 'add' && (
                <>
                  <div className="mcp-add-section">
                    <p className="mcp-add-description">
                      Paste the full command to add an MCP server. The{' '}
                      <code>{agentBinaryName} mcp add</code> prefix is optional.
                    </p>
                    <div className="mcp-add-input-wrapper">
                      <input
                        type="text"
                        className="mcp-add-input"
                        placeholder={`e.g. my-server -- npx -y @some/mcp-server`}
                        value={addCommand}
                        onChange={(e) => {
                          setAddCommand(e.target.value);
                          setAddError(null);
                          setAddSuccess(false);
                        }}
                        onKeyDown={handleAddKeyDown}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                      />
                      <Button
                        variant="primary"
                        onClick={() => void handleAdd()}
                        disabled={isAdding || !addCommand.trim()}
                      >
                        {isAdding ? 'Adding...' : 'Add'}
                      </Button>
                    </div>
                    <div className="mcp-scope-toggle">
                      <span className="mcp-scope-toggle-label">Scope:</span>
                      <Tabs
                        value={addScope}
                        mode="navigation"
                        onValueChange={(next) => setAddScope(next as AddScope)}
                      >
                        <TabsList aria-label="MCP server scope">
                          <TabsTab value="user">User</TabsTab>
                          <TabsTab value="project" disabled={!projectPath}>
                            Project
                          </TabsTab>
                        </TabsList>
                      </Tabs>
                    </div>
                  </div>

                  {addError && <ExtensionState kind="error">{addError}</ExtensionState>}

                  {addSuccess && <div className="mcp-success">MCP server added successfully.</div>}
                </>
              )}
            </TabsPanel>
          </ExtensionManagerLayout>
        </Tabs>
      </>
    </ModalFrame>
  );
}
