/**
 * The detail pane for one inbox finding.
 *
 * PROTOTYPE. The action bar is the part that matters: a finding is not a
 * notification, it's the head of a work session. "Fix with agent" would open
 * the project workspace and spawn a terminal tab with `suggestedPrompt`
 * pre-filled — here it shows the prompt instead of running it.
 *
 * @module components/inbox/InboxDetail
 */

import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  BranchIcon,
  CodeIcon,
  HistoryIcon,
  ResetIcon,
  TerminalIcon,
  TrashIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { formatAgo, type InboxItem, type Severity } from '../../lib/routines';

interface InboxDetailProps {
  item: InboxItem;
  onArchive: (item: InboxItem) => void;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

export function InboxDetail({ item, onArchive }: InboxDetailProps) {
  const { showToast } = useOptionalToast();
  const { copy } = useCopyToClipboard({
    onCopy: () => showToast('Prompt copied', 'success'),
  });

  const html = useMemo(
    () => DOMPurify.sanitize(String(marked.parse(item.bodyMd, { async: false }))),
    [item.bodyMd]
  );

  return (
    <article className="inbox-detail" key={item.id}>
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
          <span className="text-style-label">Hand this to the agent</span>
        </div>
        <p className="inbox-handoff-prompt">{item.suggestedPrompt}</p>
        <div className="inbox-handoff-actions">
          <Button
            variant="primary"
            size="compact"
            leftIcon={<TerminalIcon size={12} />}
            onClick={() =>
              showToast(
                'Prototype — this would open the project and pre-fill a terminal tab',
                'info'
              )
            }
          >
            Fix with agent
          </Button>
          <Button
            variant="secondary"
            size="compact"
            leftIcon={<ResetIcon size={12} />}
            onClick={() => showToast('Prototype — snapshot, then hand off', 'info')}
          >
            Snapshot &amp; fix
          </Button>
          <Button
            variant="secondary"
            size="compact"
            leftIcon={<BranchIcon size={12} />}
            onClick={() => showToast('Prototype — fix on a new branch', 'info')}
          >
            Fix on a branch
          </Button>
          <Button variant="ghost" size="compact" onClick={() => void copy(item.suggestedPrompt)}>
            Copy prompt
          </Button>
        </div>
      </section>

      <footer className="inbox-detail-footer">
        <Button
          variant="ghost"
          size="compact"
          leftIcon={<HistoryIcon size={12} />}
          onClick={() => showToast(`Prototype — would open run ${item.runId}`, 'info')}
        >
          View the run that filed this
        </Button>
        <Button
          variant="ghost"
          size="compact"
          leftIcon={<TrashIcon size={12} />}
          onClick={() => onArchive(item)}
        >
          {item.archived ? 'Restore' : 'Archive'}
        </Button>
      </footer>
    </article>
  );
}
