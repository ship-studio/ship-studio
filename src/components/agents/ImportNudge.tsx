/**
 * "Coming from another assistant?" A quiet card at the foot of the agent list
 * that tells people import exists. Nobody finds a menu item they don't know
 * to look for, and most people decide to bring their agents over only after
 * they've tried this. It stays until it's dismissed or the team has clearly
 * been set up, and never comes back after that.
 *
 * @module components/agents/ImportNudge
 */

import { useState } from 'react';
import { ArrowRightIcon, CloseIcon, DownloadIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { IconButton } from '../primitives/IconButton';

const DISMISSED_KEY = 'shipstudio.agents.importNudgeDismissed';

/** A team this size was built on purpose; the nudge has done its job. */
const SET_UP_TEAM_SIZE = 4;

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    /* per-viewer convenience only */
  }
}

/** Whether the note shows, and how to put it away for good. */
export function useImportNudge(agentCount: number) {
  const [dismissed, setDismissed] = useState(readDismissed);
  return {
    visible: !dismissed && agentCount < SET_UP_TEAM_SIZE,
    dismiss: () => {
      writeDismissed();
      setDismissed(true);
    },
  };
}

interface ImportNudgeProps {
  onImport: () => void;
  onDismiss: () => void;
}

export function ImportNudge({ onImport, onDismiss }: ImportNudgeProps) {
  return (
    <aside className="agents-import-nudge" aria-label="Import agents">
      {/* The badge column of the rows above, so the text starts where their names do. */}
      <span className="agents-import-nudge__icon" aria-hidden>
        <DownloadIcon size={14} />
      </span>
      <div className="agents-import-nudge__text">
        <p className="agents-import-nudge__title">
          Coming from Grok Bot, Muse or another assistant?
        </p>
        <p className="agents-import-nudge__body">
          Bring your agents over, with their memory and routines.
        </p>
        <TextButton
          variant="primary"
          className="agents-import-nudge__action"
          rightIcon={<ArrowRightIcon size={12} />}
          onClick={onImport}
        >
          Import agents
        </TextButton>
      </div>
      <IconButton
        variant="ghost"
        size="compact"
        className="agents-import-nudge__close"
        icon={<CloseIcon size={12} />}
        aria-label="Dismiss"
        onClick={onDismiss}
      />
    </aside>
  );
}
