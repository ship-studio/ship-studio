/**
 * Changelog component that displays recent releases on the dashboard.
 * Users can click any version to rewind/downgrade to it.
 *
 * ⚠️  RELEASE CHECKLIST: Update the CHANGELOG array below when releasing!
 *     Add new version at the TOP with user-facing changes.
 *     Keep ~15 most recent versions.
 */

import { useState, useEffect, useCallback } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
import { WarningIcon } from './icons';
import { trackEvent, trackError } from '../lib/analytics';
import { installVersion } from '../lib/updater';

interface ChangelogEntry {
  version: string;
  items: string[];
}

// Changelog data - update this with each release!
// Keep ~15 most recent versions for the sidebar
const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.4.16',
    items: [
      'Terminal sessions now persist — reopen a project and your conversations resume',
      'New terminal tab dropdown with ⌘T shortcut and agent switching',
      'File search in the Code tab sidebar',
      'Keyboard shortcuts ⌘1-5 to switch terminal tabs',
      'Cleanup status shown when closing projects',
      'Fixed terminal resize issues when switching tabs',
    ],
  },
  {
    version: '0.4.15',
    items: ['Plugin errors no longer crash the entire app'],
  },
  {
    version: '0.4.14',
    items: ['Fixed rapid project switching causing app to hang', 'Faster port cleanup on macOS'],
  },
  {
    version: '0.4.13',
    items: [
      'Fixed 100% CPU spike when navigating back from workspace',
      'Replaced broad CSS transitions with specific properties for better performance',
    ],
  },
  {
    version: '0.4.12',
    items: [
      'Fixed scrollbar engine causing 100% CPU on the dashboard',
      'Fixed "What\'s New" sidebar layout on the projects page',
      'Smoother hover animations on project and folder cards',
    ],
  },
  {
    version: '0.4.11',
    items: [
      'Major performance improvements — reduced CPU and energy usage',
      'Branch changes from Claude Code now reflected instantly',
      'Screenshot capture pauses when window is in background',
      'Fixed resource leaks in terminals, timers, and file watchers',
    ],
  },
  {
    version: '0.4.10',
    items: [
      'Project Settings modal for dev server port and command',
      'Cleaner toolbar with icon-only restart and settings cog',
    ],
  },
  {
    version: '0.4.9',
    items: [
      'Confirmation modals for PR pull, merge, and close actions',
      'Reduced CPU usage with smarter polling and caching',
      'Preview polling pauses when window is hidden',
      'Faster branch list loading (batched git operations)',
      'Fixed AI generate button overlap during generation',
    ],
  },
  {
    version: '0.4.8',
    items: [
      'Pull & close actions for pull requests',
      '"You are here" indicator on checked-out PR',
      'Dev server auto-restarts after PR checkout',
      'Fixed scrollbar crash on component unmount',
      'Fixed toast bubbles stretching to widest sibling',
    ],
  },
  {
    version: '0.4.7',
    items: [
      'Custom dark scrollbars with OverlayScrollbars',
      'Redesigned plugin manager cards with icon previews',
      'Fixed skills search and installation errors',
    ],
  },
  {
    version: '0.4.6',
    items: [
      'Code browser with syntax highlighting and file tree',
      '"Copy to agent" sends selected code directly to the terminal',
    ],
  },
  {
    version: '0.4.5',
    items: [
      'Compact template dropdown with "Set as default" option',
      'Search filtering in Plugin Manager',
      'Custom dev commands for generic projects',
      'Vercel plugin pre-installed for new projects',
      'Plugins now react to GitHub repo changes without restart',
    ],
  },
  {
    version: '0.4.4',
    items: ['Fixed settings toggle color to use green', 'Improved terminal content layout'],
  },
  {
    version: '0.4.3',
    items: ['Moved bug report button to the workspace toolbar'],
  },
  {
    version: '0.4.2',
    items: ['Hide activity calendar from dashboard via Settings or inline button'],
  },
  {
    version: '0.4.1',
    items: [
      'MCP Server Manager for adding custom tool servers',
      'Terminal tabs highlight green when waiting for user input',
      'Instant search in installed skills tab',
      '"View PR" navigates to PRs tab instead of opening GitHub',
      'Sync success shows hint to create a PR on feature branches',
      'PR number shown next to title in PRs tab',
    ],
  },
  {
    version: '0.4.0',
    items: [
      'Plugin system - install extensions from the Plugin Library',
      'Multi-agent support - choose Claude Code or Codex',
      'New onboarding wizard with step-by-step setup',
      'Vercel & Sanity CMS moved to plugins',
      'Toolbar dropdown menu and terminal tab menu',
    ],
  },
  {
    version: '0.3.53',
    items: [
      'HTML/CSS/JS project support - no framework needed',
      'Live reload for static HTML projects',
      'New HTML/CSS/JS starter template',
    ],
  },
  {
    version: '0.3.52',
    items: ['Terminal loading indicator while Claude Code starts up'],
  },
  {
    version: '0.3.51',
    items: ['Import repos you collaborate on (not just owned)', 'Fix dev server restart crashes'],
  },
  {
    version: '0.3.50',
    items: [
      'Fix npm cache permission errors during setup',
      'Slack community banner on welcome screen',
    ],
  },
  {
    version: '0.3.49',
    items: [
      'Import local folders as projects',
      'Link existing Vercel projects',
      'Vercel project list shows all projects (pagination)',
    ],
  },
  {
    version: '0.3.48',
    items: [
      'Nuxt/Vue support - new Nuxt Basic template',
      'Page selector tracks in-iframe navigation',
      'Faster onboarding with batched installs',
      'Better onboarding error messages',
    ],
  },
  {
    version: '0.3.47',
    items: [
      'Dashboard changelog sidebar',
      'GitHub contribution calendar',
      'Better Vercel CLI error messages',
      'Improved dashboard header styling',
    ],
  },
  {
    version: '0.3.46',
    items: [
      'Safe Backup Restore - creates branch for PR review',
      'Clickable project path opens in Finder',
      'Astro page selector support',
    ],
  },
  {
    version: '0.3.45',
    items: ['Astro support - new Astro Basic template'],
  },
  {
    version: '0.3.44',
    items: ['Vercel site URLs dropdown on hover', 'Slack community CTA'],
  },
  {
    version: '0.3.43',
    items: ['Fixed Vercel CLI detection for nvm'],
  },
  {
    version: '0.3.42',
    items: ['Skills Manager - install Claude skills', 'Help & Commands modal'],
  },
  {
    version: '0.3.41',
    items: ['Education Mode - learn UI elements'],
  },
  {
    version: '0.3.37',
    items: ['Terminal Focus Indicator', 'Notification Sounds'],
  },
  {
    version: '0.3.36',
    items: ['Responsive breakpoints', 'Fixed viewport screenshots'],
  },
  {
    version: '0.3.33',
    items: ['Export project as template'],
  },
  {
    version: '0.3.32',
    items: ['Preview breakpoints - 5 responsive sizes'],
  },
  {
    version: '0.3.28',
    items: ['Resizable preview panel', 'Global search in folders'],
  },
  {
    version: '0.3.25',
    items: ['File diff viewer'],
  },
];

type RewindStage = 'confirm' | 'downloading' | 'installing' | 'done' | 'error';

interface ChangelogProps {
  className?: string;
}

export function Changelog({ className = '' }: ChangelogProps) {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [rewindVersion, setRewindVersion] = useState<string | null>(null);
  const [rewindStage, setRewindStage] = useState<RewindStage>('confirm');
  const [rewindError, setRewindError] = useState<string | null>(null);

  useEffect(() => {
    void getVersion().then(setCurrentVersion);
  }, []);

  // Listen for progress events from the backend
  useEffect(() => {
    const unlisten = listen<{ stage: string }>('rewind-progress', (event) => {
      const stage = event.payload.stage;
      if (stage === 'downloading' || stage === 'installing' || stage === 'done') {
        setRewindStage(stage);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const handleRewind = useCallback(async () => {
    if (!rewindVersion) return;
    void trackEvent('version_rewind_started', {
      target_version: rewindVersion,
      $screen_name: 'Dashboard',
    });
    setRewindStage('downloading');
    setRewindError(null);

    try {
      await installVersion(rewindVersion);
      void trackEvent('version_rewind_completed', {
        target_version: rewindVersion,
        $screen_name: 'Dashboard',
      });
      setRewindStage('done');
    } catch (err: unknown) {
      trackError('version_rewind', err, 'Dashboard');
      setRewindStage('error');
      setRewindError(err instanceof Error ? err.message : String(err));
    }
  }, [rewindVersion]);

  const handleRestart = useCallback(async () => {
    try {
      await relaunch();
    } catch (err) {
      trackError('app_restart', err, 'Dashboard');
      setRewindError('Failed to restart. Please restart manually.');
    }
  }, []);

  const closeModal = () => {
    setRewindVersion(null);
    setRewindStage('confirm');
    setRewindError(null);
  };

  const isWorking = rewindStage === 'downloading' || rewindStage === 'installing';

  return (
    <div className={`changelog ${className}`}>
      <div className="changelog-header">
        <h3>What's New</h3>
        <span className="changelog-subtitle">Recent updates</span>
      </div>
      <div className="changelog-list">
        {CHANGELOG.map((entry) => {
          const isCurrent = currentVersion === entry.version;
          return (
            <div key={entry.version} className="changelog-entry">
              <div className="changelog-entry-header">
                {isCurrent ? (
                  <span className="changelog-version">
                    v{entry.version}
                    <span className="changelog-current-badge">current</span>
                  </span>
                ) : (
                  <button
                    className="changelog-version changelog-version-link"
                    onClick={() => setRewindVersion(entry.version)}
                  >
                    v{entry.version}
                  </button>
                )}
              </div>
              <ul className="changelog-items">
                {entry.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Rewind confirmation modal */}
      {rewindVersion && (
        <div className="rewind-modal" onClick={() => !isWorking && closeModal()}>
          <div className="rewind-content" onClick={(e) => e.stopPropagation()}>
            <div className="rewind-header">
              <WarningIcon size={18} />
              <h3>
                {rewindStage === 'confirm' && `Install v${rewindVersion}?`}
                {rewindStage === 'downloading' && 'Downloading...'}
                {rewindStage === 'installing' && 'Installing...'}
                {rewindStage === 'done' && 'Ready to restart'}
                {rewindStage === 'error' && 'Installation failed'}
              </h3>
            </div>
            <div className="rewind-body">
              {rewindStage === 'confirm' && (
                <p>
                  This will replace your current version
                  {currentVersion && <> (v{currentVersion})</>} with{' '}
                  <strong>v{rewindVersion}</strong>. The app will restart afterward.
                </p>
              )}
              {rewindStage === 'downloading' && (
                <>
                  <p>Downloading v{rewindVersion}...</p>
                  <div className="rewind-progress">
                    <div className="rewind-progress-bar rewind-progress-indeterminate" />
                  </div>
                </>
              )}
              {rewindStage === 'installing' && (
                <>
                  <p>Installing v{rewindVersion}...</p>
                  <div className="rewind-progress">
                    <div className="rewind-progress-bar rewind-progress-indeterminate" />
                  </div>
                </>
              )}
              {rewindStage === 'done' && (
                <p>v{rewindVersion} has been installed. Restart to use it.</p>
              )}
              {rewindStage === 'error' && <p className="rewind-error-text">{rewindError}</p>}
            </div>
            <div className="rewind-actions">
              {rewindStage === 'confirm' && (
                <>
                  <button className="rewind-btn secondary" onClick={closeModal}>
                    Cancel
                  </button>
                  <button className="rewind-btn primary" onClick={() => void handleRewind()}>
                    Install
                  </button>
                </>
              )}
              {isWorking && (
                <button className="rewind-btn secondary" disabled>
                  Please wait...
                </button>
              )}
              {rewindStage === 'done' && (
                <button className="rewind-btn primary" onClick={() => void handleRestart()}>
                  Restart Now
                </button>
              )}
              {rewindStage === 'error' && (
                <>
                  <button className="rewind-btn secondary" onClick={closeModal}>
                    Cancel
                  </button>
                  <button className="rewind-btn primary" onClick={() => void handleRewind()}>
                    Retry
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
