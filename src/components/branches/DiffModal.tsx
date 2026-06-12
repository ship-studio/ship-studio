/**
 * File diff modal for viewing uncommitted changes.
 *
 * Displays a git-style diff with:
 * - Additions highlighted in green
 * - Deletions highlighted in red
 * - Context lines in default color
 *
 * @module components/DiffModal
 */

import { useEffect, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getFileDiff, FileDiff, ChangeStatus } from '../../lib/git';
import { FileIcon } from '../icons';
import { trackError } from '../../lib/analytics';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
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

interface DiffModalProps {
  projectPath: string;
  filePath: string;
  fileStatus: ChangeStatus;
  onClose: () => void;
}

export function DiffModal({ projectPath, filePath, fileStatus, onClose }: DiffModalProps) {
  const isImage = isImageFile(filePath);
  const imageSrc = isImage ? convertFileSrc(`${projectPath}/${filePath}`) : null;

  const fetchDiff = useCallback(async (proj: string, file: string) => {
    try {
      return await getFileDiff(proj, file);
    } catch (e) {
      trackError('diff_load', e, 'Workspace');
      throw e;
    }
  }, []);
  const {
    data: diff,
    isLoading,
    error: loadError,
    execute: executeLoadDiff,
  } = useAsyncState<FileDiff, [string, string]>(fetchDiff);
  const error = loadError ? loadError.message : null;

  const loadDiff = useCallback(() => {
    if (isImage) return Promise.resolve(null);
    return executeLoadDiff(projectPath, filePath);
  }, [isImage, executeLoadDiff, projectPath, filePath]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  // Get filename from path
  const fileName = filePath.split('/').pop() || filePath;

  // Get status label
  const getStatusLabel = () => {
    switch (fileStatus) {
      case 'added':
      case 'untracked':
        return 'New File';
      case 'deleted':
        return 'Deleted';
      case 'renamed':
        return 'Renamed';
      default:
        return 'Modified';
    }
  };

  // Render diff content with syntax highlighting
  const renderDiffContent = () => {
    if (!diff) return null;

    if (diff.isBinary) {
      return <div className="diff-binary">Binary file - cannot display diff</div>;
    }

    // For new files, show content as all additions
    if (diff.isNewFile) {
      const lines = diff.content.split('\n');
      return (
        <div className="diff-lines">
          {lines.map((line, index) => (
            <div key={index} className="diff-line diff-line-add">
              <span className="diff-line-number">{index + 1}</span>
              <span className="diff-line-prefix">+</span>
              <span className="diff-line-content">{line || ' '}</span>
            </div>
          ))}
        </div>
      );
    }

    // For regular diffs, parse and highlight
    const lines = diff.content.split('\n');

    return (
      <div className="diff-lines">
        {lines.map((line, index) => {
          let lineClass = 'diff-line';
          let prefix = ' ';

          if (line.startsWith('+') && !line.startsWith('+++')) {
            lineClass += ' diff-line-add';
            prefix = '+';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            lineClass += ' diff-line-delete';
            prefix = '-';
          } else if (line.startsWith('@@')) {
            lineClass += ' diff-line-hunk';
            prefix = '';
          } else if (line.startsWith('diff ') || line.startsWith('index ')) {
            lineClass += ' diff-line-meta';
            prefix = '';
          } else if (line.startsWith('---') || line.startsWith('+++')) {
            lineClass += ' diff-line-meta';
            prefix = '';
          }

          return (
            <div key={index} className={lineClass}>
              {prefix && <span className="diff-line-prefix">{prefix}</span>}
              <span className="diff-line-content">{line || ' '}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      className="diff-modal-content"
      title={
        <div className="diff-header-info">
          <FileIcon size={16} />
          <span className="diff-filename">{fileName}</span>
          <span className={`diff-status diff-status-${fileStatus}`}>{getStatusLabel()}</span>
        </div>
      }
    >
      <>
        {/* File path */}
        <div className="diff-path">{filePath}</div>

        {/* Stats bar */}
        {diff && !diff.isBinary && (
          <div className="diff-stats">
            <span className="diff-stat-add">+{diff.additions}</span>
            <span className="diff-stat-delete">-{diff.deletions}</span>
          </div>
        )}

        {/* Content */}
        <div className="diff-body">
          {isLoading && (
            <div className="diff-loading">
              <Spinner size="lg" />
              <p>Loading diff...</p>
            </div>
          )}

          {error && (
            <div className="diff-error">
              <p>{error}</p>
              <Button variant="secondary" size="sm" onClick={() => void loadDiff()}>
                Retry
              </Button>
            </div>
          )}

          {!isLoading && !error && isImage && imageSrc && (
            <div className="diff-image-preview">
              <img src={imageSrc} alt={filePath} />
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
