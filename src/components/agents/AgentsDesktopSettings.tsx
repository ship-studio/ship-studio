/**
 * Settings → General: the Agents menu-bar icon and the quick-message shortcut.
 *
 * The icon is on by default once Agents has been used (a message sent to any
 * agent, or agents imported) or while "Keep running when closed" is on, so
 * someone who never touches Agents never gets a new icon. Quick message stays
 * opt-in, following "Keep running when closed": ⌥Space is taken from every
 * other app. Either can be set on its own.
 *
 * The shortcut field records the next combination pressed. The backend
 * refuses one macOS keeps for itself, a plain ⌘-letter every app uses, or one
 * the system won't hand over, and the reason shows under the field.
 *
 * macOS only; renders nothing elsewhere, or until the backend has answered.
 *
 * @module components/agents/AgentsDesktopSettings
 */

import { useState, type KeyboardEvent } from 'react';
import { useAsyncState } from '../../hooks/useAsyncState';
import {
  acceleratorFromEvent,
  getDesktopSettings,
  setDesktopSettings,
  type DesktopSettingsChange,
} from '../../lib/agentsDesktop';
import { asCommandError, formatCommandError } from '../../lib/errors';

function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      className={`settings-toggle ${on ? 'on' : 'off'}`}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label={label}
    >
      <span className="settings-toggle-track">
        <span className="settings-toggle-thumb" />
      </span>
    </button>
  );
}

export function AgentsDesktopSettings() {
  const settings = useAsyncState(getDesktopSettings, { immediate: true });
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const s = settings.data;
  if (!s?.supported) return null;

  const change = async (next: DesktopSettingsChange) => {
    try {
      settings.setData(await setDesktopSettings(next));
      setProblem(null);
    } catch (error) {
      setProblem(formatCommandError(asCommandError(error)));
    }
  };

  const onRecordKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(false);
      return;
    }
    const accelerator = acceleratorFromEvent(e.nativeEvent);
    if (!accelerator) return; // only modifiers so far
    setRecording(false);
    void change({ shortcut: accelerator, quickEntry: true });
  };

  return (
    <div className="settings-section agents-desktop-settings">
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Agents in the menu bar</span>
          <span className="settings-row-description">
            Shows the agents that need you and the ones working, and keeps Ship Studio a click away
            with its window closed. On by default once you've used Agents, or while Keep running
            when closed is on.
          </span>
        </div>
        <Toggle
          on={s.menuBarIcon}
          label="Agents in the menu bar"
          onChange={(on) => void change({ menuBarIcon: on })}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Quick message</span>
          <span className="settings-row-description">
            Press {s.shortcutLabel} in any app to message the Chief of Staff, or start with @name
            for another agent. You can dictate or attach a screenshot; macOS asks for Screen
            Recording permission the first time you attach one.
          </span>
          {s.quickEntry && (
            <button
              type="button"
              className="agents-shortcut-field"
              data-recording={recording || undefined}
              onClick={() => {
                setProblem(null);
                setRecording(true);
              }}
              onBlur={() => setRecording(false)}
              onKeyDown={onRecordKey}
              aria-label={`Quick message shortcut: ${s.shortcutLabel}. Click to change.`}
            >
              {recording ? 'Press a shortcut… (Esc to cancel)' : s.shortcutLabel}
            </button>
          )}
          {problem && (
            <span className="agents-shortcut-problem" role="alert">
              {problem}
            </span>
          )}
        </div>
        <Toggle
          on={s.quickEntry}
          label="Quick message"
          onChange={(on) => void change({ quickEntry: on })}
        />
      </div>
    </div>
  );
}
