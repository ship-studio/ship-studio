/**
 * Everything shared in one conversation, both ways: what you attached and what
 * the agent handed you with `share_file`. Newest first, filterable by who sent
 * it, and each row opens the file or shows it in Finder.
 *
 * @module components/agents/AgentFilesModal
 */

import { useEffect, useState } from 'react';
import { ExternalLinkIcon, FolderOpenIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { ModalFrame } from '../primitives/ModalFrame';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { Spinner } from '../primitives/Spinner';
import { FileGlyph, kindLabel, useAttachmentOpener } from './AgentAttachments';
import { useInvoke } from '../../hooks/useInvoke';
import { useAgents } from '../../lib/agentsStore';
import {
  attachmentUrl,
  filterFiles,
  formatBytes,
  formatHitTime,
  isImageMime,
  type Agent,
  type FilesFilter,
  type SharedFile,
} from '../../lib/agents';

interface AgentFilesModalProps {
  agent: Agent;
  isOpen: boolean;
  onClose: () => void;
}

export function AgentFilesModal({ agent, isOpen, onClose }: AgentFilesModalProps) {
  const [filter, setFilter] = useState<FilesFilter>('all');
  const { data, isLoading, error, execute } = useInvoke<SharedFile[]>('agents_files');
  const open = useAttachmentOpener(agent.id);
  // A file shared while the list is open shows up in it.
  const loaded = useAgents().messages[agent.id]?.length ?? 0;
  useEffect(() => {
    if (isOpen) void execute({ agentId: agent.id }).catch(() => undefined);
  }, [isOpen, agent.id, loaded, execute]);

  const files = filterFiles(data ?? [], filter);
  const sender = (f: SharedFile) => (f.from === 'user' ? 'You' : agent.name);

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="Files" className="agent-files">
      <div className="agent-files__body">
        <SegmentedControl
          aria-label="Shared by"
          className="agent-files__filter"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'user', label: 'From you' },
            { value: 'agent', label: `From ${agent.name}` },
          ]}
        />
        {error ? (
          <p className="agent-files__empty" role="alert">
            {error.message}
          </p>
        ) : !data && isLoading ? (
          <div className="agent-files__empty">
            <Spinner size="sm" />
          </div>
        ) : files.length === 0 ? (
          <p className="agent-files__empty">
            {filter === 'agent'
              ? `${agent.name} hasn’t shared any files yet.`
              : filter === 'user'
                ? `You haven’t sent ${agent.name} any files yet.`
                : `Files you send ${agent.name}, and files it makes for you, collect here.`}
          </p>
        ) : (
          <ul className="agent-files__list">
            {files.map((file) => (
              <li key={`${file.messageId}/${file.path}`} className="agent-files__row">
                <button
                  type="button"
                  className="agent-files__open"
                  onClick={() => void open(file)}
                  title={`Open ${file.name}`}
                >
                  <span className="agent-files__icon" aria-hidden>
                    {isImageMime(file.mime) ? (
                      <img src={attachmentUrl(agent.home, file)} alt="" loading="lazy" />
                    ) : (
                      <FileGlyph mime={file.mime} />
                    )}
                  </span>
                  <span className="agent-files__text">
                    <span className="agent-files__name">{file.name}</span>
                    <span className="agent-files__meta">
                      {[
                        kindLabel(file.name),
                        formatBytes(file.size),
                        formatHitTime(file.ts),
                        filter === 'all' && sender(file),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </button>
                <IconButton
                  variant="ghost"
                  size="compact"
                  icon={<FolderOpenIcon size={14} />}
                  onClick={() => void open(file, true)}
                  aria-label={`Show ${file.name} in Finder`}
                  title="Show in Finder"
                />
                <IconButton
                  variant="ghost"
                  size="compact"
                  icon={<ExternalLinkIcon size={14} />}
                  onClick={() => void open(file)}
                  aria-label={`Open ${file.name}`}
                  title="Open"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </ModalFrame>
  );
}
