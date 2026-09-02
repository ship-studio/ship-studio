/**
 * PluginInstallForm — the "Install from URL" toggle + input used in the
 * Plugin Manager's Library tab.
 *
 * @module components/PluginInstallForm
 */

import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';

export interface PluginInstallFormProps {
  showUrlInput: boolean;
  onShowUrlInput: () => void;
  repoUrl: string;
  onRepoUrlChange: (value: string) => void;
  isInstallingUrl: boolean;
  onInstall: () => void;
}

export function PluginInstallForm({
  showUrlInput,
  onShowUrlInput,
  repoUrl,
  onRepoUrlChange,
  isInstallingUrl,
  onInstall,
}: PluginInstallFormProps) {
  return (
    <div className="plugins-url-section">
      {!showUrlInput ? (
        <TextButton onClick={onShowUrlInput}>Install from URL</TextButton>
      ) : (
        <div className="plugins-install-input-wrapper">
          <input
            type="text"
            className="plugins-install-input"
            placeholder="https://github.com/owner/repo"
            value={repoUrl}
            onChange={(e) => onRepoUrlChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onInstall();
            }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
          />
          <Button
            variant="primary"
            onClick={onInstall}
            disabled={isInstallingUrl || !repoUrl.trim()}
          >
            {isInstallingUrl ? 'Installing...' : 'Install'}
          </Button>
        </div>
      )}
    </div>
  );
}
