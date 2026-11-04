/**
 * The secure input card an agent's `request_secret` leaves in its chat: what
 * it wants and why, a masked field per part, Save or Deny. The value goes
 * from here to the Keychain (`agents_save_secret`); the agent is woken with
 * the variable's name, never the value. Nobody waits on the card, so it can
 * be answered whenever.
 *
 * @module components/agents/AgentSecretCard
 */

import { memo, useState } from 'react';
import { Button } from '../primitives/Button';
import { TextField } from '../primitives/TextField';
import { LockedIcon } from '@/components/icons';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { saveSecret, secretVars } from '../../lib/agentSecrets';
import type { AgentMessage } from '../../lib/agents';

interface SecretCardProps {
  message: AgentMessage;
  agentName: string;
  onAnswer: (requestId: string, allow: boolean) => Promise<void>;
  arrived?: boolean;
}

export const SecretCard = memo(function SecretCard({
  message,
  agentName,
  onAnswer,
  arrived,
}: SecretCardProps) {
  const approval = message.approval;
  const request = approval?.secret;
  const [values, setValues] = useState<string[]>(() => request?.fields.map(() => '') ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openedPending] = useState(approval?.status === 'pending');
  if (!approval || !request) return null;
  const pending = approval.status === 'pending';
  const filled = values.every((v) => v.trim().length > 0);

  const save = async () => {
    if (!filled || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveSecret(message.agentId, approval.requestId, values);
      setValues(request.fields.map(() => ''));
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setBusy(false);
    }
  };
  // The chat's answer handler toasts a failure.
  const deny = async () => {
    setBusy(true);
    try {
      await onAnswer(approval.requestId, false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <form
        className="agent-approval agent-secret"
        data-status={approval.status}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="agent-approval__title">
          <LockedIcon size={14} className="agent-secret__icon" />
          <span>
            {agentName} asks for <code className="agent-secret__name">{request.name}</code>
          </span>
        </div>
        <p className="agent-secret__purpose">{request.purpose}</p>
        {pending ? (
          <>
            <div className="agent-secret__fields">
              {request.fields.map((field, i) => (
                <label key={field.env} className="agent-secret__field">
                  <span className="agent-secret__label">{field.label}</span>
                  <TextField
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={values[i] ?? ''}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value;
                      setValues((list) => list.map((v, j) => (j === i ? next : v)));
                    }}
                  />
                </label>
              ))}
            </div>
            <p className="agent-approval__note">
              Kept in your Keychain for {agentName} only. It gets {secretVars(request)}, never the
              value.
            </p>
            {error && (
              <p className="agent-editor__error" role="alert">
                {error}
              </p>
            )}
            <div className="agent-approval__actions">
              <Button tabIndex={0} variant="secondary" disabled={busy} onClick={() => void deny()}>
                Deny
              </Button>
              <Button tabIndex={0} type="submit" variant="primary" disabled={!filled || busy}>
                Save
              </Button>
            </div>
          </>
        ) : (
          <div
            className="agent-approval__outcome"
            data-resolved={(openedPending && !pending) || undefined}
          >
            {approval.status === 'allowed'
              ? `Saved to your Keychain · ${agentName} uses ${secretVars(request)}`
              : approval.status === 'denied'
                ? approval.note
                  ? `Declined · “${approval.note}”`
                  : `Declined · ${agentName} was told`
                : 'Not answered'}
          </div>
        )}
      </form>
    </div>
  );
});
