/**
 * HelpModal component for displaying Claude CLI commands and Ship Studio tips.
 *
 * Shows a glossary of available slash commands for Claude Code,
 * user's custom skills, keyboard shortcuts, and helpful tips.
 *
 * @module components/HelpModal
 */

import { useEffect, useState } from 'react';
import { listAgentSkills, AgentSkill } from '../lib/claude';
import { trackEvent } from '../lib/analytics';
import { logger } from '../lib/logger';
import { kbd } from '../lib/shortcuts';
import { isMac } from '../lib/setup';
import { ModalFrame } from './primitives/ModalFrame';
import { Tabs, TabsList, TabsPanel, TabsTab } from './primitives/Tabs';
import { useModal } from '../contexts/ModalContext';

interface HelpModalProps {
  /** Optional project path to include project-level skills */
  projectPath?: string;
}

interface HelpShortcut {
  id: string;
  label: string;
  description: string;
  keys: string[];
}

const DEFAULT_WORKSPACE_PANEL_LABELS = ['Agent', 'Elements', 'Variables', 'Assets', 'Plugins'];

function getWorkspacePanelLabels(): string[] {
  if (typeof document === 'undefined') return DEFAULT_WORKSPACE_PANEL_LABELS;

  const labels = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '.workspace-panel-group button[data-workspace-panel]'
    )
  )
    .map((button) => button.getAttribute('aria-label')?.trim())
    .filter((label): label is string => Boolean(label));

  return labels.length > 0 ? labels : DEFAULT_WORKSPACE_PANEL_LABELS;
}

function getHelpShortcuts(): HelpShortcut[] {
  const panelShortcuts = getWorkspacePanelLabels()
    .slice(0, 5)
    .map((label, index) => ({
      id: `workspace-panel-${index + 1}`,
      label: `Toggle ${label} panel`,
      description: `Open or close the ${label} panel (toolbar position ${index + 1})`,
      keys: [String(index + 1)],
    }));

  return [
    {
      id: 'command-palette',
      label: 'Open command palette',
      description: 'Search projects, actions, and settings',
      keys: [kbd('mod', 'K')],
    },
    {
      id: 'project-picker',
      label: 'Open project picker',
      description: 'Open the command palette on the Projects tab',
      keys: [kbd('mod', 'O')],
    },
    {
      id: 'switch-project',
      label: 'Switch project',
      description: 'Jump to a pinned or active project',
      keys: [kbd('mod', '1–9')],
    },
    {
      id: 'switch-workspace',
      label: 'Switch workspace',
      description: 'Switch to the workspace in the matching account-picker position',
      keys: [kbd('alt', '1–9')],
    },
    ...panelShortcuts,
    ...(isMac()
      ? [
          {
            id: 'switch-workspace-mode',
            label: 'Switch workspace mode',
            description: 'Switch to Preview, Focus, or Code (1–3 respectively)',
            keys: [kbd('mod', 'ctrl', '1–3')],
          },
        ]
      : []),
    {
      id: 'switch-terminal-tab',
      label: 'Switch terminal/agent tab',
      description: 'Switch to terminal or agent tab 1–9 in the current project',
      keys: [isMac() ? kbd('ctrl', '1–9') : kbd('ctrl', 'alt', '1–9')],
    },
    {
      id: 'toggle-edit-mode',
      label: 'Toggle Edit mode',
      description: 'Turn visual editing on or off in Preview',
      keys: [kbd('mod', 'E')],
    },
    {
      id: 'toggle-inspector',
      label: 'Toggle Inspector',
      description: 'Open or close the Preview inspector panel',
      keys: [kbd('mod', 'I')],
    },
    {
      id: 'help',
      label: 'Open Help & Commands',
      description: 'Show this reference',
      keys: [kbd('mod', '/'), 'F1'],
    },
    {
      id: 'new-terminal-tab',
      label: 'New terminal tab',
      description: 'Open a new agent terminal tab',
      keys: [kbd('mod', 'T')],
    },
    {
      id: 'close-terminal-tab',
      label: 'Close terminal tab',
      description: 'Close the active terminal tab',
      keys: [kbd('mod', 'W')],
    },
    {
      id: 'multiline-input',
      label: 'Multiline terminal input',
      description: 'Insert a newline instead of sending the message',
      keys: [kbd('shift', 'Enter')],
    },
    {
      id: 'undo',
      label: 'Undo agent changes',
      description: 'Undo the last working-tree snapshot',
      keys: [kbd('mod', 'Z')],
    },
    {
      id: 'redo',
      label: 'Redo agent changes',
      description: 'Redo the last undone working-tree snapshot',
      keys: [kbd('mod', 'shift', 'Z')],
    },
    {
      id: 'copy-element',
      label: 'Copy selected element',
      description: 'Copy the selected element and its children in Edit mode',
      keys: [kbd('mod', 'C')],
    },
    {
      id: 'cut-element',
      label: 'Cut selected element',
      description: 'Cut the selected element and its children in Edit mode',
      keys: [kbd('mod', 'X')],
    },
    {
      id: 'paste-element',
      label: 'Paste element',
      description: 'Paste the copied or cut element inside the selection',
      keys: [kbd('mod', 'V')],
    },
    {
      id: 'duplicate-element',
      label: 'Duplicate selected element',
      description: 'Duplicate the selected element and its children in Edit mode',
      keys: [kbd('mod', 'D')],
    },
    {
      id: 'delete-element',
      label: 'Delete selected element',
      description: 'Delete the selected element and its children in Edit mode',
      keys: [kbd('⌫')],
    },
    {
      id: 'save-code',
      label: 'Save code',
      description: 'Save the current file in Code edit mode',
      keys: [kbd('mod', 'S')],
    },
    {
      id: 'capture-preview',
      label: 'Capture preview',
      description: 'Capture the visible preview for your agent',
      keys: [kbd('mod', 'shift', 'S')],
    },
    {
      id: 'crop-preview',
      label: 'Crop preview screenshot',
      description: 'Enter crop mode for the preview',
      keys: [kbd('mod', 'shift', 'C')],
    },
    {
      id: 'escape',
      label: 'Close or cancel',
      description: 'Close dialogs and cancel preview crop mode',
      keys: ['Esc'],
    },
  ];
}

export function HelpModal({ projectPath }: HelpModalProps) {
  const { isOpen, close: onClose } = useModal('help');
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [isLoadingSkills, setIsLoadingSkills] = useState(false);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  const toggleSkillExpanded = (skillKey: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillKey)) {
        next.delete(skillKey);
      } else {
        next.add(skillKey);
      }
      return next;
    });
  };

  // Fetch skills when modal opens
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setIsLoadingSkills(true); // eslint-disable-line react-hooks/set-state-in-effect -- intentional: triggers loading UI before async fetch
    listAgentSkills(projectPath)
      .then((result) => {
        if (!cancelled) setSkills(result);
      })
      .catch((err) => {
        logger.error('Failed to load skills', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!cancelled) setSkills([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSkills(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectPath]);

  useEffect(() => {
    if (isOpen) {
      void trackEvent('help_opened', { $screen_name: 'Workspace' });
    }
  }, [isOpen]);

  const userSkills = skills.filter((s) => s.scope === 'user');
  const projectSkills = skills.filter((s) => s.scope === 'project');
  const shortcuts = getHelpShortcuts();

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="Help & Commands" className="help-modal">
      <>
        <Tabs defaultValue="shortcuts">
          <TabsList
            className="help-tabs"
            variant="stretch"
            appearance="underline"
            aria-label="Help sections"
          >
            <TabsTab value="shortcuts" width="fill" className="help-tab">
              Shortcuts
            </TabsTab>
            <TabsTab value="commands" width="fill" className="help-tab">
              Commands
            </TabsTab>
          </TabsList>

          <TabsPanel value="shortcuts" className="help-modal-body">
            <div className="help-section">
              <div className="help-section-title">Keyboard shortcuts</div>
              <div className="help-shortcut-list">
                {shortcuts.map((shortcut) => (
                  <div key={shortcut.id} className="help-shortcut-row">
                    <div className="help-shortcut-info">
                      <span className="help-shortcut-label">{shortcut.label}</span>
                      <span className="help-shortcut-description">{shortcut.description}</span>
                    </div>
                    <div className="help-shortcut-keys">
                      {shortcut.keys.map((key, index) => (
                        <span key={`${shortcut.id}-${key}`} className="help-shortcut-key-group">
                          {index > 0 && <span className="help-shortcut-or">or</span>}
                          <span className="workspace-sidebar-filter-shortcut">{key}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </TabsPanel>

          <TabsPanel value="commands" className="help-modal-body">
            {/* Custom Skills Section - shown first if user has any */}
            {skills.length > 0 && (
              <>
                <div className="help-section">
                  <div className="help-section-title">Your Skills</div>
                  <div className="help-command-list">
                    {userSkills.map((skill) => {
                      const skillKey = `${skill.plugin}-${skill.name}`;
                      const isExpanded = expandedSkills.has(skillKey);
                      return (
                        <div
                          key={skillKey}
                          className={`help-skill ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => toggleSkillExpanded(skillKey)}
                        >
                          <div className="help-skill-header">
                            <span className="help-skill-name">/{skill.name}</span>
                            <span className="help-skill-toggle">{isExpanded ? '−' : '+'}</span>
                          </div>
                          {isExpanded && <div className="help-skill-desc">{skill.description}</div>}
                        </div>
                      );
                    })}
                    {projectSkills.map((skill) => {
                      const skillKey = `${skill.plugin}-${skill.name}`;
                      const isExpanded = expandedSkills.has(skillKey);
                      return (
                        <div
                          key={skillKey}
                          className={`help-skill ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => toggleSkillExpanded(skillKey)}
                        >
                          <div className="help-skill-header">
                            <span className="help-skill-name">
                              /{skill.name}
                              <span className="help-skill-badge">project</span>
                            </span>
                            <span className="help-skill-toggle">{isExpanded ? '−' : '+'}</span>
                          </div>
                          {isExpanded && <div className="help-skill-desc">{skill.description}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="help-divider" />
              </>
            )}

            {isLoadingSkills && skills.length === 0 && (
              <>
                <div className="help-section">
                  <div className="help-section-title">Your Skills</div>
                  <div className="help-loading">Loading skills...</div>
                </div>
                <div className="help-divider" />
              </>
            )}

            {/* Session Commands */}
            <div className="help-section">
              <div className="help-section-title">Session</div>
              <div className="help-command-list">
                <div className="help-command">
                  <span className="help-command-name">/clear</span>
                  <span className="help-command-desc">Clear conversation history</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/compact</span>
                  <span className="help-command-desc">Toggle compact output mode</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/cost</span>
                  <span className="help-command-desc">Show token usage and cost</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/status</span>
                  <span className="help-command-desc">Show current session status</span>
                </div>
              </div>
            </div>

            <div className="help-divider" />

            {/* Code Actions */}
            <div className="help-section">
              <div className="help-section-title">Code Actions</div>
              <div className="help-command-list">
                <div className="help-command">
                  <span className="help-command-name">/init</span>
                  <span className="help-command-desc">Initialize project with CLAUDE.md</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/review</span>
                  <span className="help-command-desc">Review code changes</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/pr-comments</span>
                  <span className="help-command-desc">View PR comments from GitHub</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/bug</span>
                  <span className="help-command-desc">Report a bug to Anthropic</span>
                </div>
              </div>
            </div>

            <div className="help-divider" />

            {/* Configuration Commands */}
            <div className="help-section">
              <div className="help-section-title">Configuration</div>
              <div className="help-command-list">
                <div className="help-command">
                  <span className="help-command-name">/config</span>
                  <span className="help-command-desc">Open configuration settings</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/model</span>
                  <span className="help-command-desc">Change AI model</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/permissions</span>
                  <span className="help-command-desc">Manage tool permissions</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/memory</span>
                  <span className="help-command-desc">Edit CLAUDE.md memory file</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/mcp</span>
                  <span className="help-command-desc">Manage MCP servers</span>
                </div>
              </div>
            </div>

            <div className="help-divider" />

            {/* Utility Commands */}
            <div className="help-section">
              <div className="help-section-title">Utility</div>
              <div className="help-command-list">
                <div className="help-command">
                  <span className="help-command-name">/help</span>
                  <span className="help-command-desc">Show all available commands</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/doctor</span>
                  <span className="help-command-desc">Run diagnostics</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/login</span>
                  <span className="help-command-desc">Log in to your account</span>
                </div>
                <div className="help-command">
                  <span className="help-command-name">/logout</span>
                  <span className="help-command-desc">Log out of your account</span>
                </div>
              </div>
            </div>

            <div className="help-divider" />

            {/* Ship Studio Tips */}
            <div className="help-section">
              <div className="help-section-title">Ship Studio Tips</div>
              <div className="help-tip-list">
                <div className="help-tip">Drag files onto the terminal to paste their paths</div>
                <div className="help-tip">
                  Use <span className="help-shortcut">Shift</span> +{' '}
                  <span className="help-shortcut">Enter</span> for multiline input
                </div>
                <div className="help-tip">
                  Status dot shows Claude state: thinking, waiting, or idle
                </div>
                <div className="help-tip">Use numbered tabs to run multiple Claude sessions</div>
                <div className="help-tip">
                  Blank preview but the site works in your browser? Auth middleware (e.g. Clerk dev
                  keys) can redirect-loop inside the embedded preview — scope it to protected routes
                </div>
              </div>
            </div>

            <div className="help-divider" />

            {/* Example Prompts */}
            <div className="help-section">
              <div className="help-section-title">Example Prompts</div>
              <div className="help-example-list">
                <div className="help-example-category">Fix & Improve</div>
                <div className="help-example">
                  "The contact form isn't sending emails, can you fix it?"
                </div>
                <div className="help-example">
                  "The page is loading really slowly, can you speed it up?"
                </div>
                <div className="help-example">
                  "The images look blurry on mobile, can you fix that?"
                </div>

                <div className="help-example-category">Design & Content</div>
                <div className="help-example">
                  "Change the hero section background color to dark blue"
                </div>
                <div className="help-example">
                  "Make the website look good on phones and tablets"
                </div>
                <div className="help-example">
                  "Add a new testimonials section below the pricing page"
                </div>

                <div className="help-example-category">Add Features</div>
                <div className="help-example">"Add a newsletter signup form to the footer"</div>
                <div className="help-example">
                  "Create a FAQ accordion section for the homepage"
                </div>
                <div className="help-example">"Add a search bar that filters the blog posts"</div>

                <div className="help-example-category">Understand Your Project</div>
                <div className="help-example">"What pages does this website have?"</div>
                <div className="help-example">"Where do I change the company logo?"</div>
                <div className="help-example">"How do I add a new blog post?"</div>
              </div>
            </div>
          </TabsPanel>
        </Tabs>

        <div className="help-footer">
          <span className="help-footer-hint">
            Press <span className="help-shortcut">Esc</span> to close
          </span>
        </div>
      </>
    </ModalFrame>
  );
}
