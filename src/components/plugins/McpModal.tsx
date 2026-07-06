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
import { SearchIcon } from '../icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { type McpServer, listMcpServers, addMcpServer, removeMcpServer } from '../../lib/mcp';
import { trackEvent, trackSearch } from '../../lib/analytics';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useModal } from '../../contexts/ModalContext';

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
      logger.error('Failed to load MCP servers', {
        error: err instanceof Error ? err.message : String(err),
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
      logger.error('Failed to add MCP server', {
        error: err instanceof Error ? err.message : String(err),
      });
      setAddError(formatCommandError(asCommandError(err)));
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
      logger.error('Failed to remove MCP server', {
        error: err instanceof Error ? err.message : String(err),
      });
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
        <div className="mcp-tabs">
          <button
            className={`mcp-tab ${activeTab === 'connected' ? 'active' : ''}`}
            onClick={() => setActiveTab('connected')}
          >
            Connected
          </button>
          <button
            className={`mcp-tab ${activeTab === 'add' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('add');
              setAddError(null);
              setAddSuccess(false);
            }}
          >
            Add
          </button>
        </div>

        <div className="mcp-modal-body">
          {activeTab === 'connected' && (
            <>
              <div className="mcp-connected-controls">
                <div className="mcp-search">
                  <SearchIcon size={12} />
                  <input
                    ref={searchRef}
                    type="text"
                    className="mcp-search-input"
                    placeholder="Filter servers..."
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
                </div>
                <div className="mcp-filter-bar">
                  <button
                    className={`mcp-filter-btn ${scopeFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setScopeFilter('all')}
                  >
                    All
                  </button>
                  <button
                    className={`mcp-filter-btn ${scopeFilter === 'user' ? 'active' : ''}`}
                    onClick={() => setScopeFilter('user')}
                  >
                    User
                  </button>
                  <button
                    className={`mcp-filter-btn ${scopeFilter === 'project' ? 'active' : ''}`}
                    onClick={() => setScopeFilter('project')}
                  >
                    Project
                  </button>
                </div>
              </div>

              {isLoadingServers && servers.length === 0 && (
                <div className="mcp-loading">
                  <Spinner className="mcp-loading-spinner" />
                  Loading MCP servers...
                </div>
              )}

              {!isLoadingServers && filteredServers.length === 0 && (
                <div className="mcp-empty">
                  {debouncedQuery
                    ? 'No matching servers found'
                    : scopeFilter === 'all'
                      ? 'No MCP servers configured yet'
                      : `No ${scopeFilter}-scoped servers configured`}
                </div>
              )}

              <div className="mcp-list">
                {filteredServers.map((server) => (
                  <div key={`${server.scope}-${server.name}`} className="mcp-row">
                    <div className="mcp-server-info">
                      <div className="mcp-server-name-row">
                        <span
                          className={`mcp-status-dot ${server.status}`}
                          title={statusLabel(server.status)}
                        />
                        <span className="mcp-server-name">{server.name}</span>
                      </div>
                      <div className="mcp-server-meta">
                        <span
                          className={`mcp-scope-badge ${server.scope === 'project' ? 'project' : ''}`}
                        >
                          {server.scope}
                        </span>
                        <span className="mcp-status-label">{statusLabel(server.status)}</span>
                      </div>
                      {server.command_or_url && (
                        <div className="mcp-server-command">{server.command_or_url}</div>
                      )}
                    </div>
                    <button
                      className="mcp-remove-btn"
                      onClick={() => void handleRemove(server)}
                      disabled={removingServer === serverKey(server)}
                    >
                      {removingServer === serverKey(server) ? 'Removing...' : 'Remove'}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

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
                  <button
                    className="mcp-add-btn"
                    onClick={() => void handleAdd()}
                    disabled={isAdding || !addCommand.trim()}
                  >
                    {isAdding ? 'Adding...' : 'Add'}
                  </button>
                </div>
                <div className="mcp-scope-toggle">
                  <span className="mcp-scope-toggle-label">Scope:</span>
                  <button
                    type="button"
                    className={`mcp-scope-btn ${addScope === 'user' ? 'active' : ''}`}
                    onClick={() => setAddScope('user')}
                  >
                    User
                  </button>
                  <button
                    type="button"
                    className={`mcp-scope-btn ${addScope === 'project' ? 'active' : ''}`}
                    onClick={() => setAddScope('project')}
                    disabled={!projectPath}
                  >
                    Project
                  </button>
                </div>
              </div>

              {addError && <div className="mcp-error">{addError}</div>}

              {addSuccess && <div className="mcp-success">MCP server added successfully.</div>}
            </>
          )}
        </div>

        <div className="mcp-footer">
          <span className="mcp-footer-hint">
            Press <span className="help-shortcut">Esc</span> to close
          </span>
        </div>
      </>
    </ModalFrame>
  );
}
