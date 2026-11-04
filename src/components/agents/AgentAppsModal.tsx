/**
 * Apps your agents can use. Every agent turn is a Claude Code process, and
 * Claude Code brings the user's MCP servers into it, so this lists what
 * Claude Code is connected to (with its own health check), adds one of a
 * short list of official remote servers for every agent, and removes what it
 * added. Sign-in is Claude Code's own: "Sign in…" opens it in a terminal,
 * where /mcp authenticates in the browser.
 *
 * Opened from the agent editor and ⌘K → "Connect an app for agents…".
 *
 * @module components/agents/AgentAppsModal
 */

import { useEffect, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Spinner } from '../primitives/Spinner';
import { OnboardingTerminal } from '../setup/OnboardingTerminal';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  addAgentApp,
  appManagedWhere,
  appStatusLabel,
  appTarget,
  appTitle,
  listAgentApps,
  removeAgentApp,
  type AgentApp,
  type AgentAppSuggestion,
} from '../../lib/agentApps';

interface AgentAppsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AgentAppsModal({ isOpen, onClose }: AgentAppsModalProps) {
  const list = useAsyncState(listAgentApps);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const { execute: load } = list;

  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  const change = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setActionError(formatCommandError(asCommandError(err)));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const apps = list.data;
  const firstLoad = list.isLoading && !apps;

  return (
    <>
      <ModalFrame
        isOpen={isOpen && !signingIn}
        onClose={onClose}
        title="Apps your agents can use"
        className="agent-apps"
      >
        <div className="agent-apps__body">
          <p className="agent-apps__lead">
            Agents run on your Claude Code, so they can use any app Claude Code is connected to.
            Adding one here adds it for every agent.
          </p>

          <section className="agent-apps__section" aria-labelledby="agent-apps-connected">
            <h3 id="agent-apps-connected" className="agent-apps__heading">
              Connected
              {list.isLoading && apps && <Spinner size="sm" />}
            </h3>
            {firstLoad && (
              <p className="agent-apps__quiet">
                <Spinner size="sm" /> Asking Claude Code…
              </p>
            )}
            {list.error && (
              <p className="agent-apps__error" role="alert">
                {list.error.message}{' '}
                <TextButton tabIndex={0} onClick={() => void load()}>
                  Try again
                </TextButton>
              </p>
            )}
            {apps && apps.connected.length === 0 && (
              <p className="agent-apps__quiet">Nothing yet. Add one below.</p>
            )}
            {apps && apps.connected.length > 0 && (
              <ul className="agent-apps__list">
                {apps.connected.map((app) => (
                  <ConnectedRow
                    key={app.name}
                    app={app}
                    busy={busy !== null}
                    confirming={confirming === app.name}
                    onSignIn={() => setSigningIn(appTitle(app))}
                    onRemove={() =>
                      confirming === app.name
                        ? void change(app.name, () => removeAgentApp(app.name))
                        : setConfirming(app.name)
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          {apps && (
            <section className="agent-apps__section" aria-labelledby="agent-apps-add">
              <h3 id="agent-apps-add" className="agent-apps__heading">
                Add an app
              </h3>
              <ul className="agent-apps__list agent-apps__list--grid">
                {apps.suggestions.map((s) => (
                  <SuggestionRow
                    key={s.serverName}
                    suggestion={s}
                    adding={busy === s.serverName}
                    disabled={busy !== null}
                    onAdd={() => void change(s.serverName, () => addAgentApp(s.serverName))}
                  />
                ))}
              </ul>
            </section>
          )}

          {actionError && (
            <p className="agent-apps__error" role="alert">
              {actionError}
            </p>
          )}

          <div className="agent-apps__notes">
            <p>
              A new app signs in once, in your browser, through Claude Code: use Sign in… when it
              says Needs sign-in.
            </p>
            <p>
              Gmail, Google Calendar and Slack come from claude.ai: connect them there under
              Settings → Connectors. A project’s MCP servers screen edits these same settings.
            </p>
          </div>

          <div className="agent-apps__actions">
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </ModalFrame>

      {signingIn && (
        <ModalFrame
          isOpen
          onClose={() => {
            setSigningIn(null);
            void load();
          }}
          title={`Sign in to ${signingIn}`}
          className="agents-panel-terminal-modal"
        >
          <p className="agent-apps__terminal-hint">
            Type /mcp, choose {signingIn}, then Authenticate. Close this once it says connected.
          </p>
          <div className="agents-panel-terminal-body">
            <OnboardingTerminal
              command="claude"
              args={[]}
              onExit={() => {
                setSigningIn(null);
                void load();
              }}
            />
          </div>
        </ModalFrame>
      )}
    </>
  );
}

function ConnectedRow({
  app,
  busy,
  confirming,
  onSignIn,
  onRemove,
}: {
  app: AgentApp;
  busy: boolean;
  confirming: boolean;
  onSignIn: () => void;
  onRemove: () => void;
}) {
  const status = appStatusLabel(app.status);
  const managed = appManagedWhere(app.source);
  return (
    <li className="agent-apps__row">
      <div className="agent-apps__text">
        <span className="agent-apps__name">{appTitle(app)}</span>
        <span className="agent-apps__meta">
          {appTarget(app.target)}
          {managed && ` · ${managed}`}
        </span>
      </div>
      {status && (
        <span className="agent-apps__status" data-status={app.status}>
          {status}
        </span>
      )}
      {app.status === 'needs_auth' && (
        <TextButton tabIndex={0} onClick={onSignIn} disabled={busy}>
          Sign in…
        </TextButton>
      )}
      {app.source === 'user' && (
        <TextButton
          tabIndex={0}
          className="agent-apps__remove"
          data-confirming={confirming || undefined}
          onClick={onRemove}
          disabled={busy}
          aria-label={confirming ? `Confirm removing ${app.name}` : `Remove ${app.name}`}
        >
          {confirming ? 'Remove?' : 'Remove'}
        </TextButton>
      )}
    </li>
  );
}

function SuggestionRow({
  suggestion,
  adding,
  disabled,
  onAdd,
}: {
  suggestion: AgentAppSuggestion;
  adding: boolean;
  disabled: boolean;
  onAdd: () => void;
}) {
  return (
    <li className="agent-apps__row">
      <div className="agent-apps__text">
        <span className="agent-apps__name">{suggestion.title}</span>
        <span className="agent-apps__meta">{suggestion.blurb}</span>
      </div>
      {suggestion.added ? (
        <span className="agent-apps__quiet">Added</span>
      ) : (
        <Button
          variant="secondary"
          size="compact"
          onClick={onAdd}
          disabled={disabled}
          leftIcon={adding ? <Spinner size="sm" /> : undefined}
          aria-label={`Add ${suggestion.title}`}
        >
          Add
        </Button>
      )}
    </li>
  );
}
