/**
 * SkillsModal component for discovering, installing, and removing Claude skills.
 *
 * Provides two tabs:
 * - Installed: View and remove installed skills
 * - Add: Search and install new skills from skills.sh
 *
 * @module components/SkillsModal
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { SearchIcon } from '../icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import {
  type AgentSkill,
  checkSkillsCli,
  searchSkills,
  installSkill,
  removeSkill,
  type SkillSearchResult,
} from '../../lib/skills';
import { listAgentSkills } from '../../lib/claude';
import { trackEvent, trackSearch } from '../../lib/analytics';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useModal } from '../../contexts/ModalContext';

/** Format install count as compact string (e.g., 98500 → "98.5K") */
function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M installs`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K installs`;
  return `${n} installs`;
}

type Tab = 'installed' | 'add';
type ScopeFilter = 'all' | 'user' | 'project';
type InstallScope = 'user' | 'project';

interface SkillsModalProps {
  projectPath?: string;
  agentId?: string;
  agentDisplayName?: string;
}

export function SkillsModal({
  projectPath,
  agentId,
  agentDisplayName = 'Claude',
}: SkillsModalProps) {
  const { isOpen, close: onClose } = useModal('skills');
  const [activeTab, setActiveTab] = useState<Tab>('installed');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [isLoadingSkills, setIsLoadingSkills] = useState(false);
  const [removingSkill, setRemovingSkill] = useState<string | null>(null);

  // Installed tab search
  const [installedSearchQuery, setInstalledSearchQuery] = useState('');
  const [debouncedInstalledQuery, setDebouncedInstalledQuery] = useState('');
  const installedSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const installedSearchRef = useRef<HTMLInputElement>(null);

  // Debounce installed search input
  useEffect(() => {
    if (installedSearchTimer.current) clearTimeout(installedSearchTimer.current);
    installedSearchTimer.current = setTimeout(() => {
      setDebouncedInstalledQuery(installedSearchQuery);
    }, 150);
    return () => {
      if (installedSearchTimer.current) clearTimeout(installedSearchTimer.current);
    };
  }, [installedSearchQuery]);

  // Add tab state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SkillSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installScope, setInstallScope] = useState<InstallScope>('user');
  const [installingPackage, setInstallingPackage] = useState<string | null>(null);
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null);

  // Handle Escape key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Fetch installed skills when modal opens or when returning to installed tab
  const fetchSkills = useCallback(async () => {
    setIsLoadingSkills(true);
    try {
      const result = await listAgentSkills(projectPath, agentId);
      setSkills(result);
    } catch (err) {
      logger.error('Failed to load skills', {
        error: err instanceof Error ? err.message : String(err),
      });
      setSkills([]);
    } finally {
      setIsLoadingSkills(false);
    }
  }, [projectPath, agentId]);

  useEffect(() => {
    if (!isOpen) return;
    void fetchSkills();
  }, [isOpen, fetchSkills]);

  // Check CLI availability when switching to Add tab
  useEffect(() => {
    if (!isOpen || activeTab !== 'add' || cliAvailable !== null) return;

    checkSkillsCli()
      .then(setCliAvailable)
      .catch(() => setCliAvailable(false));
  }, [isOpen, activeTab, cliAvailable]);

  // Filter skills based on scope filter and search query
  const filteredSkills = skills.filter((skill) => {
    if (scopeFilter !== 'all' && skill.scope !== scopeFilter) return false;
    if (debouncedInstalledQuery) {
      const q = debouncedInstalledQuery.toLowerCase();
      return (
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.plugin.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Handle search
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    void trackEvent('skills_searched', {
      query: searchQuery.trim(),
      $screen_name: 'Skills Modal',
    });

    setIsSearching(true);
    setSearchError(null);
    setSearchResults([]);

    try {
      const results = await searchSkills(searchQuery.trim());
      setSearchResults(results);
    } catch (err) {
      logger.error('Failed to search skills', {
        error: err instanceof Error ? err.message : String(err),
      });
      setSearchError(formatCommandError(asCommandError(err)));
    } finally {
      setIsSearching(false);
    }
  };

  // Handle install
  const handleInstall = async (pkg: string) => {
    setInstallingPackage(pkg);
    try {
      await installSkill(pkg, installScope, projectPath, agentId);
      void trackEvent('skill_installed', {
        package: pkg,
        scope: installScope,
        $screen_name: 'Skills Modal',
      });
      // Refresh installed skills and switch to installed tab
      await fetchSkills();
      setActiveTab('installed');
    } catch (err) {
      const msg = formatCommandError(asCommandError(err));
      logger.error('Failed to install skill', { error: msg });
      setSearchError(msg);
    } finally {
      setInstallingPackage(null);
    }
  };

  // Handle remove
  const handleRemove = async (skill: AgentSkill) => {
    const skillKey = `${skill.plugin}-${skill.name}`;
    setRemovingSkill(skillKey);
    try {
      // Use the plugin as the package identifier
      await removeSkill(skill.plugin, skill.scope as 'user' | 'project', projectPath, agentId);
      void trackEvent('skill_removed', {
        plugin: skill.plugin,
        scope: skill.scope,
        $screen_name: 'Skills Modal',
      });
      // Refresh installed skills
      await fetchSkills();
    } catch (err) {
      logger.error('Failed to remove skill', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRemovingSkill(null);
    }
  };

  // Handle key press in search input
  const handleSearchKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void handleSearch();
    }
  };

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={`Skills for ${agentDisplayName}`}
      className="skills-modal"
    >
      <>
        <div className="skills-tabs">
          <button
            className={`skills-tab ${activeTab === 'installed' ? 'active' : ''}`}
            onClick={() => setActiveTab('installed')}
          >
            Installed
          </button>
          <button
            className={`skills-tab ${activeTab === 'add' ? 'active' : ''}`}
            onClick={() => setActiveTab('add')}
          >
            Add
          </button>
        </div>

        <div className="skills-modal-body">
          {activeTab === 'installed' && (
            <>
              <div className="skills-installed-controls">
                <div className="skills-installed-search">
                  <SearchIcon size={12} />
                  <input
                    ref={installedSearchRef}
                    type="text"
                    className="skills-installed-search-input"
                    placeholder="Filter skills..."
                    value={installedSearchQuery}
                    onChange={(e) => {
                      setInstalledSearchQuery(e.target.value);
                      trackSearch('skills_filter', e.target.value, 'Skills Modal');
                    }}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div className="skills-filter-bar">
                  <button
                    className={`skills-filter-btn ${scopeFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setScopeFilter('all')}
                  >
                    All
                  </button>
                  <button
                    className={`skills-filter-btn ${scopeFilter === 'user' ? 'active' : ''}`}
                    onClick={() => setScopeFilter('user')}
                  >
                    User
                  </button>
                  <button
                    className={`skills-filter-btn ${scopeFilter === 'project' ? 'active' : ''}`}
                    onClick={() => setScopeFilter('project')}
                  >
                    Project
                  </button>
                </div>
              </div>

              {isLoadingSkills && skills.length === 0 && (
                <div className="skills-loading">
                  <Spinner className="skills-loading-spinner" />
                  Loading skills...
                </div>
              )}

              {!isLoadingSkills && filteredSkills.length === 0 && (
                <div className="skills-empty">
                  {debouncedInstalledQuery
                    ? 'No matching skills found'
                    : scopeFilter === 'all'
                      ? 'No skills installed yet'
                      : `No ${scopeFilter}-scoped skills installed`}
                </div>
              )}

              <div className="skills-list">
                {filteredSkills.map((skill) => {
                  const skillKey = `${skill.plugin}-${skill.name}`;
                  return (
                    <div key={skillKey} className="skill-row">
                      <div className="skill-info">
                        <div className="skill-name">/{skill.name}</div>
                        <div className="skill-meta">
                          <span className="skill-plugin">{skill.plugin}</span>
                          <span
                            className={`skill-scope-badge ${skill.scope === 'project' ? 'project' : ''}`}
                          >
                            {skill.scope}
                          </span>
                        </div>
                        <div className="skill-desc">{skill.description}</div>
                      </div>
                      <button
                        className="skill-remove-btn"
                        onClick={() => void handleRemove(skill)}
                        disabled={removingSkill === skillKey}
                      >
                        {removingSkill === skillKey ? 'Removing...' : 'Remove'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {activeTab === 'add' && (
            <>
              {cliAvailable === false && (
                <div className="skills-cli-unavailable">
                  <p>Skills CLI is not available. Install it to search and add skills:</p>
                  <code>npm install -g skills</code>
                </div>
              )}

              {cliAvailable !== false && (
                <>
                  <div className="skills-search-section">
                    <div className="skills-search-input-wrapper">
                      <input
                        type="text"
                        className="skills-search-input"
                        placeholder={`What do you want ${agentDisplayName} to do?`}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyPress={handleSearchKeyPress}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                      />
                      <button
                        className="skills-search-btn"
                        onClick={() => void handleSearch()}
                        disabled={isSearching || !searchQuery.trim()}
                      >
                        {isSearching ? 'Searching...' : 'Search'}
                      </button>
                    </div>
                    <div className="skills-scope-toggle">
                      <span className="skills-scope-toggle-label">Install to:</span>
                      <button
                        type="button"
                        className={`skills-scope-btn ${installScope === 'user' ? 'active' : ''}`}
                        onClick={() => setInstallScope('user')}
                      >
                        User
                      </button>
                      <button
                        type="button"
                        className={`skills-scope-btn ${installScope === 'project' ? 'active' : ''}`}
                        onClick={() => setInstallScope('project')}
                        disabled={!projectPath}
                      >
                        Project
                      </button>
                    </div>
                  </div>

                  {searchError && <div className="skills-error">{searchError}</div>}

                  {isSearching && (
                    <div className="skills-loading">
                      <Spinner className="skills-loading-spinner" />
                      Searching skills...
                    </div>
                  )}

                  {!isSearching && searchResults.length === 0 && searchQuery && !searchError && (
                    <div className="skills-empty">
                      No skills found. Try a different search term.
                    </div>
                  )}

                  <div className="skills-search-results">
                    {searchResults.map((result) => (
                      <div key={result.package} className="skills-result-card">
                        <div className="skills-result-header">
                          <div className="skills-result-info">
                            <div className="skills-result-name">{result.name}</div>
                            <div className="skills-result-package">
                              {result.package}
                              {result.installs != null && (
                                <span className="skills-result-installs">
                                  {formatInstalls(result.installs)}
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            className={`skills-install-btn ${installingPackage === result.package ? 'installing' : ''}`}
                            onClick={() => void handleInstall(result.package)}
                            disabled={installingPackage !== null}
                          >
                            {installingPackage === result.package ? 'Installing...' : 'Install'}
                          </button>
                        </div>
                        {result.description && (
                          <div className="skills-result-desc">{result.description}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="skills-footer">
          <span className="skills-footer-hint">
            Press <span className="help-shortcut">Esc</span> to close
          </span>
          <a
            href="https://skills.sh"
            target="_blank"
            rel="noopener noreferrer"
            className="skills-footer-link"
          >
            <svg
              width={10}
              height={10}
              viewBox="0 0 76 65"
              fill="currentColor"
              style={{ marginRight: 6 }}
            >
              <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
            </svg>
            Powered by skills.sh
          </a>
        </div>
      </>
    </ModalFrame>
  );
}
