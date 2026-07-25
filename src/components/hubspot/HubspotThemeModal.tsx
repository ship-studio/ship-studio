/**
 * Modal for changing the Design Tools destination path a HubSpot theme
 * project previews to. Opened from the command palette ("Change HubSpot
 * theme path…"); the default (project folder name) needs no setup.
 *
 * @module components/HubspotThemeModal
 */

import { useEffect, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useModal } from '../../contexts/ModalContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  getHubspotDest,
  setHubspotDest,
  normalizeThemeDest,
  defaultThemeDest,
} from '../../lib/hubspot';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';

interface HubspotThemeModalProps {
  projectPath: string;
  /** Called after a new path is saved so the parent can restart the preview. */
  onDestSaved: () => void;
}

export function HubspotThemeModal({ projectPath, onDestSaved }: HubspotThemeModalProps) {
  const { isOpen, close } = useModal('hubspotTheme');
  const { showToast } = useOptionalToast();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Prefill with the current destination (or the default) each time it opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    void getHubspotDest(projectPath)
      .then((dest) => {
        if (!cancelled) setInput(dest ?? defaultThemeDest(projectPath));
      })
      .catch(() => {
        if (!cancelled) setInput(defaultThemeDest(projectPath));
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectPath]);

  const handleSave = async () => {
    const dest = normalizeThemeDest(input);
    if (!dest) {
      setError('Enter a theme path, like my-theme or themes/site');
      return;
    }
    setError(null);
    setIsSaving(true);
    try {
      await setHubspotDest(projectPath, dest);
      showToast(`Theme path set to ${dest} — restarting preview`, 'success');
      close();
      onDestSaved();
    } catch (err) {
      logger.error('[HubspotThemeModal] Failed to save theme path', { error: String(err) });
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ModalFrame isOpen={isOpen} onClose={close} title="HubSpot theme path">
      <div className="hubspot-theme-modal-body">
        <p className="hint">
          The path in HubSpot Design Tools this theme uploads to for previewing via{' '}
          <code>hs cms theme preview</code>. To preview changes on a live site&apos;s pages, it must
          match the path of the theme that site uses.
        </p>
        <input
          type="text"
          className="hubspot-setup-input"
          placeholder="my-theme"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSave();
          }}
          disabled={isSaving}
          autoFocus
        />
        {error && <p className="hubspot-setup-error">{error}</p>}
        <div className="hubspot-theme-modal-actions">
          <Button variant="secondary" size="sm" onClick={close} disabled={isSaving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save & restart preview'}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
