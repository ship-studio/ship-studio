/**
 * File diff modal: one file's change, with old and new line numbers and one
 * +/− marker per line. git's per-file headers are dropped (the title already
 * names the file). Given the other files of the same change, it steps
 * between them.
 *
 * @module components/DiffModal
 */

import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getFileDiff, FileDiff, ChangeStatus } from '../../lib/git';
import { newFileRows, parseUnifiedDiff } from '../../lib/diff';
import { ArrowLeftIcon, ArrowRightIcon, FileIcon } from '@/components/icons';
import { trackError } from '../../lib/analytics';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Spinner } from '../primitives/Spinner';
import { Tooltip } from '../primitives/Tooltip';
import { useAsyncState } from '../../hooks/useAsyncState';

// Image extensions to detect for preview
const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.tiff',
  '.tif',
];

function isImageFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface DiffFile {
  path: string;
  status: ChangeStatus;
}

interface DiffModalProps {
  projectPath: string;
  filePath: string;
  fileStatus: ChangeStatus;
  onClose: () => void;
  /** Where the diff comes from; defaults to the uncommitted change (`get_file_diff`). */
  loadDiff?: (projectPath: string, filePath: string) => Promise<FileDiff>;
  /** Every file of the same change, in order: Previous / Next step through them. */
  files?: DiffFile[];
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: 'New File',
  untracked: 'New File',
  deleted: 'Deleted',
  renamed: 'Renamed',
  modified: 'Modified',
};

export function DiffModal({
  projectPath,
  filePath,
  fileStatus,
  onClose,
  loadDiff: source = getFileDiff,
  files,
}: DiffModalProps) {
  const [shown, setShown] = useState<DiffFile>({ path: filePath, status: fileStatus });
  // A parent that swaps the file in place (rather than remounting) wins.
  const [opened, setOpened] = useState(filePath);
  if (opened !== filePath) {
    setOpened(filePath);
    setShown({ path: filePath, status: fileStatus });
  }
  const index = files?.findIndex((f) => f.path === shown.path) ?? -1;
  const stepping = files && files.length > 1 && index >= 0;

  const isImage = isImageFile(shown.path);
  const imageSrc = isImage ? convertFileSrc(`${projectPath}/${shown.path}`) : null;

  const fetchDiff = useCallback(
    async (proj: string, file: string) => {
      try {
        return await source(proj, file);
      } catch (e) {
        trackError('diff_load', e, 'Workspace');
        throw e;
      }
    },
    [source]
  );
  const {
    data: diff,
    isLoading,
    error: loadError,
    execute: executeLoadDiff,
  } = useAsyncState<FileDiff, [string, string]>(fetchDiff);
  const error = loadError ? loadError.message : null;

  const loadDiff = useCallback(() => {
    if (isImage) return Promise.resolve(null);
    return executeLoadDiff(projectPath, shown.path);
  }, [isImage, executeLoadDiff, projectPath, shown.path]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  // Focus lands on the diff itself (arrow keys scroll it), not on Close.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0, left: 0 });
  }, [shown.path]);

  const rows = useMemo(() => {
    if (!diff || diff.isBinary) return null;
    return diff.isNewFile ? newFileRows(diff.content) : parseUnifiedDiff(diff.content);
  }, [diff]);

  const slash = shown.path.lastIndexOf('/');
  const directory = slash >= 0 ? shown.path.slice(0, slash + 1) : '';
  const fileName = shown.path.slice(slash + 1);

  const step = (by: 1 | -1) => {
    const next = files?.[index + by];
    if (next) setShown(next);
  };

  const renderDiffContent = () => {
    if (!diff) return null;
    if (diff.isBinary) {
      return <div className="diff-binary">Binary file - cannot display diff</div>;
    }
    return (
      <div className="diff-lines">
        {rows?.map((row, i) => {
          if (row.kind === 'hunk') {
            return (
              <div key={i} className="diff-line diff-line-hunk">
                <span className="diff-line-content">{row.text || ' '}</span>
              </div>
            );
          }
          if (row.kind === 'note') {
            return (
              <div key={i} className="diff-line diff-line-meta">
                <span className="diff-line-number" />
                <span className="diff-line-number" />
                <span className="diff-line-prefix" />
                <span className="diff-line-content">{row.text}</span>
              </div>
            );
          }
          const kindClass =
            row.kind === 'add'
              ? ' diff-line-add'
              : row.kind === 'delete'
                ? ' diff-line-delete'
                : '';
          return (
            <div key={i} className={`diff-line${kindClass}`}>
              <span className="diff-line-number">{row.oldLine}</span>
              <span className="diff-line-number">{row.newLine}</span>
              <span className="diff-line-prefix">
                {row.kind === 'add' ? '+' : row.kind === 'delete' ? '−' : ''}
              </span>
              <span className="diff-line-content">{row.text || ' '}</span>
            </div>
          );
        })}
      </div>
    );
  };

  const hasStats = diff && !diff.isBinary && !isImage && !isLoading;

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      className="diff-modal-content"
      initialFocusRef={bodyRef}
      title={
        <div className="diff-header-info">
          <FileIcon size={16} />
          <Tooltip content={shown.path}>
            <span className="diff-filepath">
              {directory && <span className="diff-directory">{directory}</span>}
              <span className="diff-filename">{fileName}</span>
            </span>
          </Tooltip>
          <span className={`diff-status diff-status-${shown.status}`}>
            {STATUS_LABEL[shown.status]}
          </span>
        </div>
      }
    >
      <>
        {(hasStats || stepping) && (
          <div className="diff-stats">
            {hasStats && (
              <>
                <span className="diff-stat-add">+{diff.additions}</span>
                <span className="diff-stat-delete">−{diff.deletions}</span>
              </>
            )}
            {stepping && (
              <div className="diff-nav">
                <span className="diff-nav-count">
                  {index + 1} of {files.length}
                </span>
                <Tooltip content="Previous file">
                  <IconButton
                    tabIndex={0}
                    variant="ghost"
                    size="compact"
                    icon={<ArrowLeftIcon size={12} />}
                    aria-label="Previous file"
                    disabled={index === 0}
                    onClick={() => step(-1)}
                  />
                </Tooltip>
                <Tooltip content="Next file">
                  <IconButton
                    tabIndex={0}
                    variant="ghost"
                    size="compact"
                    icon={<ArrowRightIcon size={12} />}
                    aria-label="Next file"
                    disabled={index === files.length - 1}
                    onClick={() => step(1)}
                  />
                </Tooltip>
              </div>
            )}
          </div>
        )}

        {/* Content: focusable, so the keyboard scrolls it from the moment it opens. */}
        <div
          ref={bodyRef}
          className="diff-body"
          tabIndex={0}
          role="region"
          aria-label={`Changes to ${shown.path}`}
        >
          {isLoading && (
            <div className="diff-loading">
              <Spinner size="lg" />
              <p>Loading diff...</p>
            </div>
          )}

          {error && (
            <div className="diff-error">
              <p>{error}</p>
              <Button variant="secondary" onClick={() => void loadDiff()}>
                Retry
              </Button>
            </div>
          )}

          {!isLoading && !error && isImage && imageSrc && (
            <div className="diff-image-preview">
              <img src={imageSrc} alt={shown.path} />
            </div>
          )}

          {!isLoading && !error && !isImage && diff && (
            <pre className="diff-pre">{renderDiffContent()}</pre>
          )}
        </div>
      </>
    </ModalFrame>
  );
}
