/**
 * Ticket creation form with type selector (bug/feature/support).
 * Optional "Share project info" toggle appends useful debug context.
 */

import { useState, useEffect } from 'react';
import { createTicket } from '../../lib/support';
import type { Conversation } from '../../lib/support';
import { trackEvent } from '../../lib/analytics';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentBranch } from '../../lib/branches';
import { detectProjectType } from '../../lib/static-server';

const TICKET_TYPES = [
  { id: 'bug', icon: '🐛', label: 'Bug' },
  { id: 'feature', icon: '💡', label: 'Feature' },
  { id: 'support', icon: '💬', label: 'Support' },
] as const;

interface ProjectInfo {
  appVersion: string;
  os: string;
  projectName?: string;
  framework?: string;
  branch?: string;
}

interface NewTicketFormProps {
  initialType?: string;
  projectPath?: string;
  projectName?: string;
  onSuccess: (conversation: Conversation) => void;
  onCancel: () => void;
}

export function NewTicketForm({
  initialType = 'support',
  projectPath,
  projectName,
  onSuccess,
  onCancel,
}: NewTicketFormProps) {
  const [ticketType, setTicketType] = useState(initialType);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [loomUrl, setLoomUrl] = useState('');
  const [shareProjectInfo, setShareProjectInfo] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);

  const canSubmit = subject.trim() && message.trim() && !submitting;

  // Gather project info on mount
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [appVersion, branch, framework] = await Promise.all([
        getVersion().catch(() => 'unknown'),
        projectPath
          ? getCurrentBranch(projectPath).catch(() => undefined)
          : Promise.resolve(undefined),
        projectPath
          ? detectProjectType(projectPath).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);

      const ua = navigator.userAgent;
      const osMatch = ua.match(/\(([^)]+)\)/);
      const os = osMatch ? osMatch[1] : navigator.platform;

      if (!cancelled) {
        setProjectInfo({
          appVersion,
          os,
          projectName,
          framework: framework && framework !== 'unknown' ? framework : undefined,
          branch,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectPath, projectName]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      let fullMessage = message.trim();

      const loom = loomUrl.trim();
      if (loom) {
        fullMessage += `\n\nLoom: ${loom}`;
      }

      // Append system/project context as a formatted block
      if (shareProjectInfo && projectInfo) {
        const lines: string[] = [];
        lines.push(`App: Ship Studio v${projectInfo.appVersion}`);
        lines.push(`OS: ${projectInfo.os}`);
        if (projectInfo.projectName) lines.push(`Project: ${projectInfo.projectName}`);
        if (projectInfo.framework) lines.push(`Framework: ${projectInfo.framework}`);
        if (projectInfo.branch) lines.push(`Branch: ${projectInfo.branch}`);
        fullMessage += `\n\n---\n${lines.join('\n')}`;
      }

      const conversation = await createTicket({
        subject: `[${ticketType}] ${subject.trim()}`,
        message: fullMessage,
      });

      void trackEvent('support_ticket_created', {
        ticket_type: ticketType,
        shared_project_info: shareProjectInfo,
        $screen_name: 'Support',
      });

      onSuccess(conversation);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="support-form">
      {/* Type selector */}
      <div className="support-field">
        <label>Type</label>
        <div className="support-type-selector">
          {TICKET_TYPES.map((t) => (
            <button
              key={t.id}
              className={`support-type-btn ${ticketType === t.id ? 'active' : ''}`}
              onClick={() => setTicketType(t.id)}
            >
              <span className="type-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Subject */}
      <div className="support-field">
        <label>Subject</label>
        <input
          type="text"
          placeholder="Brief description..."
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={200}
        />
      </div>

      {/* Details */}
      <div className="support-field">
        <label>Details</label>
        <textarea
          placeholder={
            ticketType === 'bug'
              ? 'What happened? What did you expect?'
              : ticketType === 'feature'
                ? 'Describe the feature you would like...'
                : 'How can we help?'
          }
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      {/* Loom URL */}
      <div className="support-field">
        <label>
          Loom URL <span className="field-hint">(optional)</span>
        </label>
        <input
          type="url"
          placeholder="https://www.loom.com/share/..."
          value={loomUrl}
          onChange={(e) => setLoomUrl(e.target.value)}
        />
      </div>

      {/* Share project info toggle */}
      <div className="support-toggle-field">
        <label
          className="support-toggle-label"
          onClick={() => setShareProjectInfo(!shareProjectInfo)}
        >
          <span
            className={`support-toggle ${shareProjectInfo ? 'on' : ''}`}
            role="switch"
            aria-checked={shareProjectInfo}
          />
          <span>
            Share project info <span className="field-hint">— helps us debug faster</span>
          </span>
        </label>
        {shareProjectInfo && projectInfo && (
          <div className="support-project-info-preview">
            <div className="support-info-row">
              <span className="support-info-label">App</span>
              <span>v{projectInfo.appVersion}</span>
            </div>
            <div className="support-info-row">
              <span className="support-info-label">OS</span>
              <span>{projectInfo.os}</span>
            </div>
            {projectInfo.projectName && (
              <div className="support-info-row">
                <span className="support-info-label">Project</span>
                <span>{projectInfo.projectName}</span>
              </div>
            )}
            {projectInfo.framework && (
              <div className="support-info-row">
                <span className="support-info-label">Framework</span>
                <span>{projectInfo.framework}</span>
              </div>
            )}
            {projectInfo.branch && (
              <div className="support-info-row">
                <span className="support-info-label">Branch</span>
                <span>{projectInfo.branch}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {error && <div className="support-error">{error}</div>}

      {/* Actions */}
      <div className="support-form-actions">
        <button className="support-cancel-btn" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          className="support-submit-btn"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
        >
          {submitting ? 'Submitting...' : 'Submit'}
        </button>
      </div>
    </div>
  );
}
