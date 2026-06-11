/**
 * Hook for notification settings, attention tab tracking, and agent status sound alerts.
 *
 * Manages: notification sound settings, per-tab attention state,
 * agent status change detection (thinking -> waiting transitions),
 * and sound playback on completion.
 *
 * @module hooks/useNotifications
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  NotificationSettings,
  loadNotificationSettings,
  saveNotificationSettings,
  playSound,
} from '../lib/sounds';
import { sessionRegistry } from '../lib/sessionRegistry';
import type { AgentStatus } from '../components/Terminal';

export interface UseNotificationsParams {
  activeTerminalTab: number;
  /** Path of the currently-focused project. A tab belonging to this project
   *  AND matching `activeTerminalTab` is the one the user is actually looking
   *  at — attention stays clear for that tab only. */
  currentProjectPath: string | null;
}

export function useNotifications({
  activeTerminalTab,
  currentProjectPath,
}: UseNotificationsParams) {
  // Notification settings state
  const [notificationSettings, setNotificationSettings] =
    useState<NotificationSettings>(loadNotificationSettings);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);

  // Track previous agent status per (projectPath, tabId) to detect
  // transitions. Scoped by project since tab ids collide across projects.
  const prevAgentStatusMap = useRef<Map<string, AgentStatus>>(new Map());

  // Current-project tabs waiting for user attention. Kept as a local Set
  // so current-project sidebar rows can read it
  // without reaching into the registry for every render. Background
  // projects' attention flags live in sessionRegistry.
  const [attentionTabs, setAttentionTabs] = useState<Set<number>>(new Set());

  // Use ref for notification settings to avoid re-creating callback
  const notificationSettingsRef = useRef(notificationSettings);
  useEffect(() => {
    notificationSettingsRef.current = notificationSettings;
  }, [notificationSettings]);

  // Ref for activeTerminalTab so the callback doesn't need to be recreated
  const activeTerminalTabRef = useRef(activeTerminalTab);
  useEffect(() => {
    activeTerminalTabRef.current = activeTerminalTab;
  }, [activeTerminalTab]);

  const currentProjectPathRef = useRef(currentProjectPath);
  useEffect(() => {
    currentProjectPathRef.current = currentProjectPath;
  }, [currentProjectPath]);

  // Handle agent status changes per (project, tab) — play sounds, mark
  // attention, and mirror status into sessionRegistry so background
  // projects' sidebars reflect the state too.
  const createTabStatusHandler = useCallback(
    (projectPath: string, tabId: number) => (status: AgentStatus, _title: string) => {
      const settings = notificationSettingsRef.current;
      const mapKey = `${projectPath}::${tabId}`;
      const prevStatus = prevAgentStatusMap.current.get(mapKey) ?? 'idle';
      const wasThinking = prevStatus === 'thinking';

      const isFocusedTab =
        currentProjectPathRef.current === projectPath && activeTerminalTabRef.current === tabId;

      sessionRegistry.setAgentStatus(projectPath, status, isFocusedTab);

      // Fold agent activity into the tab's lifecycle status. `thinking` /
      // `waiting` live alongside `running` / `exited` / `crashed` on the
      // tab — one authoritative field the sidebar reads for its dot.
      // `idle` maps to `running` (PTY is alive but not mid-turn).
      const tabStatus: 'running' | 'thinking' | 'waiting' =
        status === 'thinking' ? 'thinking' : status === 'waiting' ? 'waiting' : 'running';
      sessionRegistry.patchTerminalTab(projectPath, tabId, { status: tabStatus });

      // When agent transitions from thinking to waiting (finished processing)
      if (wasThinking && status === 'waiting') {
        if (settings.enabled) {
          void playSound(settings.sound);
        }
        if (!isFocusedTab) {
          sessionRegistry.setTerminalTabAttention(projectPath, tabId, true);
          if (currentProjectPathRef.current === projectPath) {
            setAttentionTabs((prev) => new Set(prev).add(tabId));
          }
        }
      }

      prevAgentStatusMap.current.set(mapKey, status);
    },
    []
  );

  // Save notification settings when they change
  const handleSaveNotificationSettings = useCallback((settings: NotificationSettings) => {
    setNotificationSettings(settings);
    saveNotificationSettings(settings);
  }, []);

  return {
    // State
    notificationSettings,
    showNotificationSettings,
    setShowNotificationSettings,
    attentionTabs,
    setAttentionTabs,

    // Handlers
    createTabStatusHandler,
    handleSaveNotificationSettings,
  };
}
