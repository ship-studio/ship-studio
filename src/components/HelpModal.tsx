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
import { ModalFrame } from './primitives/ModalFrame';
import { useModal } from '../contexts/ModalContext';

interface HelpModalProps {
  /** Optional project path to include project-level skills */
  projectPath?: string;
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

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="Help & Commands" className="help-modal">
      <>
        <div className="help-modal-body">
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
              <div className="help-example">"Make the website look good on phones and tablets"</div>
              <div className="help-example">
                "Add a new testimonials section below the pricing page"
              </div>

              <div className="help-example-category">Add Features</div>
              <div className="help-example">"Add a newsletter signup form to the footer"</div>
              <div className="help-example">"Create a FAQ accordion section for the homepage"</div>
              <div className="help-example">"Add a search bar that filters the blog posts"</div>

              <div className="help-example-category">Understand Your Project</div>
              <div className="help-example">"What pages does this website have?"</div>
              <div className="help-example">"Where do I change the company logo?"</div>
              <div className="help-example">"How do I add a new blog post?"</div>
            </div>
          </div>
        </div>

        <div className="help-footer">
          <span className="help-footer-hint">
            Press <span className="help-shortcut">Esc</span> to close
          </span>
        </div>
      </>
    </ModalFrame>
  );
}
