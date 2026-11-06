import { useEffect, useRef } from 'react';
import {
  updateDiscordPresence,
  clearDiscordPresence,
  getDiscordPresenceEnabled,
} from '../lib/discord';

interface UseDiscordPresenceOptions {
  projectName?: string | null;
  activeFilePath?: string | null;
  isEditing?: boolean;
  enabled?: boolean;
}

export function useDiscordPresence({
  projectName,
  activeFilePath,
  isEditing = false,
  enabled = true,
}: UseDiscordPresenceOptions) {
  const startTimestampRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      void clearDiscordPresence();
      return;
    }

    if (startTimestampRef.current === null) {
      startTimestampRef.current = Math.floor(Date.now() / 1000);
    }

    let isSubscribed = true;

    async function syncPresence() {
      const isEnabled = await getDiscordPresenceEnabled().catch(() => true);
      if (!isSubscribed || !isEnabled) return;

      const filename = activeFilePath ? activeFilePath.split(/[/\\]/).pop() : undefined;
      const stateStr =
        isEditing && filename
          ? projectName
            ? `In ${projectName}: ${filename}`
            : `Editing ${filename}`
          : projectName
            ? `Working on ${projectName}`
            : 'In Dashboard';

      void updateDiscordPresence({
        details: "🚢'in with Ship Studio",
        state: stateStr,
        filename: isEditing ? filename : undefined,
        projectName: projectName || undefined,
        isEditing,
        startTimestamp: startTimestampRef.current ?? undefined,
      });
    }

    void syncPresence();

    return () => {
      isSubscribed = false;
    };
  }, [projectName, activeFilePath, isEditing, enabled]);
}
