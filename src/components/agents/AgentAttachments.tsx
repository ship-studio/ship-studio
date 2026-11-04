/**
 * Attachments on screen: the chips staged in the composer, the thumbnails and
 * file chips on a sent message, and the full-size view an image opens into.
 *
 * @module components/agents/AgentAttachments
 */

import { useCallback, useState } from 'react';
import {
  CloseIcon,
  FileIcon,
  FileTextIcon,
  FolderOpenIcon,
  ExternalLinkIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { ModalFrame } from '../primitives/ModalFrame';
import {
  attachmentUrl,
  formatBytes,
  isImageMime,
  openAttachment,
  type Agent,
  type Attachment,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import type { DraftAttachment } from './useComposerAttachments';

const isTextual = (mime: string) => mime.startsWith('text/') || mime === 'application/json';

/** "PDF", "CSV", "PNG": what a file is, at a glance. */
export function kindLabel(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return ext ? ext.slice(0, 4).toUpperCase() : 'File';
}

export function FileGlyph({ mime }: { mime: string }) {
  return isTextual(mime) || mime === 'application/pdf' ? (
    <FileTextIcon size={16} />
  ) : (
    <FileIcon size={16} />
  );
}

interface ComposerAttachmentsProps {
  items: DraftAttachment[];
  /** Absent once they're on their way (a message still sending shows them as they were). */
  onRemove?: (id: string) => void;
}

/** Staged files above the text, each removable until it's sent. */
export function ComposerAttachments({ items, onRemove }: ComposerAttachmentsProps) {
  if (items.length === 0) return null;
  return (
    <ul className="agent-composer__attachments" aria-label="Attached files">
      {items.map((item) => (
        <li
          key={item.id}
          className="agent-attachment-chip"
          data-kind={item.previewUrl ? 'image' : 'file'}
          title={`${item.name} · ${formatBytes(item.size)}`}
        >
          {item.previewUrl ? (
            <img className="agent-attachment-chip__thumb" src={item.previewUrl} alt={item.name} />
          ) : (
            <>
              <span className="agent-attachment-chip__glyph" aria-hidden>
                <FileGlyph mime={item.mime} />
              </span>
              <span className="agent-attachment-chip__text">
                <span className="agent-attachment-chip__name">{item.name}</span>
                <span className="agent-attachment-chip__meta">
                  {kindLabel(item.name)} · {formatBytes(item.size)}
                </span>
              </span>
            </>
          )}
          {onRemove && (
            <IconButton
              variant="secondary"
              size="compact"
              className="agent-attachment-chip__remove"
              icon={<CloseIcon size={12} />}
              onClick={() => onRemove(item.id)}
              aria-label={`Remove ${item.name}`}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

interface ComposerQuotesProps {
  quotes: string[];
  onRemove: (index: number) => void;
}

/** Passages quoted from replies, waiting to be sent ahead of the text. */
export function ComposerQuotes({ quotes, onRemove }: ComposerQuotesProps) {
  if (quotes.length === 0) return null;
  return (
    <ul className="agent-composer__quotes" aria-label="Quoted">
      {quotes.map((quote, index) => (
        <li key={`${index}-${quote.slice(0, 24)}`} className="agent-quote-chip">
          <span className="agent-quote-chip__text">{quote}</span>
          <IconButton
            variant="ghost"
            size="compact"
            className="agent-quote-chip__remove"
            icon={<CloseIcon size={12} />}
            onClick={() => onRemove(index)}
            aria-label="Remove quote"
            title="Remove quote"
          />
        </li>
      ))}
    </ul>
  );
}

/** Open or reveal an attachment, with failures as a toast. */
export function useAttachmentOpener(agentId: string) {
  const { showToast } = useOptionalToast();
  return useCallback(
    async (attachment: Attachment, reveal = false) => {
      try {
        await openAttachment(agentId, attachment.path, reveal);
      } catch (error) {
        showToast(formatCommandError(asCommandError(error)), 'error');
      }
    },
    [agentId, showToast]
  );
}

function RevealButton({ name, onReveal }: { name: string; onReveal: () => void }) {
  return (
    <IconButton
      variant="secondary"
      size="compact"
      className="agent-attachments__reveal"
      icon={<FolderOpenIcon size={12} />}
      onClick={onReveal}
      aria-label={`Show ${name} in Finder`}
      title="Show in Finder"
    />
  );
}

interface MessageAttachmentsProps {
  agent: Agent;
  attachments: Attachment[];
  /** Whose message: yours sit against the right edge, the agent's against the left. */
  side?: 'user' | 'agent';
}

/** What a message carried: images as thumbnails, everything else as chips. */
export function MessageAttachments({ agent, attachments, side = 'user' }: MessageAttachmentsProps) {
  const open = useAttachmentOpener(agent.id);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const images = attachments.filter((a) => isImageMime(a.mime));
  const files = attachments.filter((a) => !isImageMime(a.mime));

  return (
    <div className="agent-attachments" data-side={side}>
      {images.length > 0 && (
        <div className="agent-attachments__images" data-count={Math.min(images.length, 3)}>
          {images.map((image) => (
            <span key={image.path} className="agent-attachments__item">
              <button
                type="button"
                className="agent-attachments__image"
                onClick={() => setViewing(image)}
                aria-label={`View ${image.name}`}
                title={image.name}
              >
                <img src={attachmentUrl(agent.home, image)} alt={image.name} loading="lazy" />
              </button>
              <RevealButton name={image.name} onReveal={() => void open(image, true)} />
            </span>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="agent-attachments__files">
          {files.map((file) => (
            <span key={file.path} className="agent-attachments__item">
              <button
                type="button"
                className="agent-attachment-chip agent-attachment-chip--sent"
                onClick={() => void open(file)}
                title={`Open ${file.name}`}
              >
                <span className="agent-attachment-chip__glyph" aria-hidden>
                  <FileGlyph mime={file.mime} />
                </span>
                <span className="agent-attachment-chip__text">
                  <span className="agent-attachment-chip__name">{file.name}</span>
                  <span className="agent-attachment-chip__meta">
                    {kindLabel(file.name)} · {formatBytes(file.size)}
                  </span>
                </span>
              </button>
              <RevealButton name={file.name} onReveal={() => void open(file, true)} />
            </span>
          ))}
        </div>
      )}
      <ModalFrame
        isOpen={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing?.name ?? ''}
        className="agent-lightbox"
        headerActions={
          viewing && (
            <>
              <Button
                variant="ghost"
                size="compact"
                leftIcon={<ExternalLinkIcon size={14} />}
                onClick={() => void open(viewing)}
              >
                Open
              </Button>
              <Button
                variant="ghost"
                size="compact"
                leftIcon={<FolderOpenIcon size={14} />}
                onClick={() => void open(viewing, true)}
              >
                Show in Finder
              </Button>
            </>
          )
        }
      >
        {viewing && (
          <img
            className="agent-lightbox__image"
            src={attachmentUrl(agent.home, viewing)}
            alt={viewing.name}
          />
        )}
      </ModalFrame>
    </div>
  );
}
