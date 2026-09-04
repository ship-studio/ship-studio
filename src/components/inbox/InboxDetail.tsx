/**
 * The detail pane for one inbox finding.
 *
 * The action bar is the part that matters: a finding is not a notification,
 * it's the head of a work session. So it is pinned to the bottom of the pane
 * rather than living at the end of the report — a long report otherwise pushes
 * the whole point of the feature below the fold, and the pane opens showing
 * nothing you can act on.
 *
 * "Fix in <project>" opens the finding's workspace and types the suggested
 * prompt into its terminal.
 *
 * @module components/inbox/InboxDetail
 */

import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { CodeIcon, CopyIcon, ResetIcon, TerminalIcon, TrashIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { formatAgo, type InboxItem, type Severity } from '../../lib/routines';

interface InboxDetailProps {
  item: InboxItem;
  onArchive: (item: InboxItem) => void;
  /** Permanently forget a finding. Archived items only. */
  onDelete: (item: InboxItem) => void;
  /**
   * Opens the finding's project and types `prompt` into its terminal. Absent
   * when there is nowhere to navigate to, in which case the fix actions are
   * hidden rather than shown as buttons that do nothing.
   */
  onFix?: (item: InboxItem, prompt: string) => void;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

export function InboxDetail({ item, onArchive, onDelete, onFix }: InboxDetailProps) {
  const { showToast } = useOptionalToast();
  const { copy } = useCopyToClipboard({
    onCopy: () => showToast('Prompt copied', 'success'),
  });

  const html = useMemo(
    () => DOMPurify.sanitize(String(marked.parse(item.bodyMd, { async: false }))),
    [item.bodyMd]
  );

  return (
    <>
      <div className="inbox-detail-scroll">
        <article className="inbox-detail">
          <header className="inbox-detail-header">
            <div className="inbox-detail-severity" data-severity={item.severity}>
              {SEVERITY_LABEL[item.severity]}
            </div>
            <h2 className="inbox-detail-title">{item.title}</h2>
            <div className="inbox-detail-meta">
              <span className="inbox-chip">{item.projectName}</span>
              <span>{item.routineName}</span>
              <span aria-hidden>·</span>
              <span>{formatAgo(item.createdAt)}</span>
              {item.occurrences > 1 && (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    reported {item.occurrences}× since {formatAgo(item.firstSeenAt)}
                  </span>
                </>
              )}
            </div>
          </header>

          {item.locations.length > 0 && (
            <ul className="inbox-detail-locations">
              {item.locations.map((location) => (
                <li key={`${location.path}:${location.line ?? 0}`} className="inbox-location">
                  <CodeIcon size={12} />
                  <code className="inbox-location-path">
                    {location.path}
                    {location.line !== undefined && `:${location.line}`}
                  </code>
                  {location.note && <span className="inbox-location-note">{location.note}</span>}
                </li>
              ))}
            </ul>
          )}

          {/* Report bodies are agent-authored markdown, sanitized before render —
              the same path ArticleView uses for support articles. */}
          <div className="inbox-detail-body" dangerouslySetInnerHTML={{ __html: html }} />

          <section className="inbox-handoff">
            <div className="inbox-handoff-header">
              <TerminalIcon size={12} />
              <span className="text-style-label">What the agent will be asked to do</span>
            </div>
            <p className="inbox-handoff-prompt">{item.suggestedPrompt}</p>
            <p className="inbox-handoff-note text-style-hint">
              Sending this starts the agent on it — it doesn&rsquo;t mean the finding is fixed.
              Review what it does like any other change.
            </p>
          </section>
        </article>
      </div>

      {/* Pinned: the report scrolls behind it, the decision does not. */}
      <div className="inbox-detail-actions">
        <div className="inbox-detail-actions-primary">
          {onFix && (
            <Button
              variant="primary"
              size="compact"
              leftIcon={<TerminalIcon size={12} />}
              title={`Open ${item.projectName} and hand this to your agent`}
              onClick={() => onFix(item, item.suggestedPrompt)}
            >
              Send to agent
            </Button>
          )}
          <Button
            variant="secondary"
            size="compact"
            leftIcon={<CopyIcon size={12} />}
            onClick={() => void copy(item.suggestedPrompt)}
          >
            Copy prompt
          </Button>
        </div>
        {/* Archiving and deleting are different promises, so they get
            different icons and live side by side once a finding is archived:
            archive mutes the fingerprint, delete forgets it and lets a future
            run file it again. */}
        <div className="inbox-detail-actions-secondary">
          <Button
            variant="ghost"
            size="compact"
            leftIcon={item.archived ? <ResetIcon size={12} /> : <TrashIcon size={12} />}
            onClick={() => onArchive(item)}
          >
            {item.archived ? 'Restore' : 'Archive'}
          </Button>
          {item.archived && (
            <Button
              variant="ghost"
              size="compact"
              className="inbox-detail-delete"
              leftIcon={<TrashIcon size={12} />}
              onClick={() => onDelete(item)}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
