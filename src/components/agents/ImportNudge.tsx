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
import { CloseIcon, DownloadIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
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

interface ImportNudgeProps {
  agentCount: number;
  onImport: () => void;
}

export function ImportNudge({ agentCount, onImport }: ImportNudgeProps) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed || agentCount >= SET_UP_TEAM_SIZE) return null;

  return (
    <aside className="agents-import-nudge" aria-label="Import agents">
      <IconButton
        variant="ghost"
        size="compact"
        className="agents-import-nudge__close"
        icon={<CloseIcon size={12} />}
        aria-label="Dismiss"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
      />
      <p className="agents-import-nudge__title">Coming from Grok Bot, Muse or another assistant?</p>
      <p className="agents-import-nudge__body">
        Bring your agents over with their instructions, memory and routines. It takes a couple of
        minutes.
      </p>
      <Button variant="secondary" size="compact" onClick={onImport}>
        <DownloadIcon size={12} />
        Import agents
      </Button>
    </aside>
  );
}
