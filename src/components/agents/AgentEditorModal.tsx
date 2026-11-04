/**
 * Create a new agent, or edit one. Creating asks only what Grok Bot asks —
 * a name and a face — plus the model it runs on, with the role and briefing
 * one disclosure away, because
 * most agents are created by the Chief of Staff and briefed in conversation.
 *
 * @module components/agents/AgentEditorModal
 */

import { useEffect, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextArea, TextField } from '../primitives/TextField';
import { TextButton } from '../primitives/TextButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { AgentAvatar } from './AgentAvatar';
import {
  AGENT_COLORS,
  type AgentColor,
  AGENT_MODELS,
  createAgent,
  formatUsage,
  getAgentInstructions,
  getAgentUsage,
  revokePermission,
  SCOPE_KIND_LABEL,
  updateAgent,
  type Agent,
  type PermissionRule,
  type UsageSummary,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAsyncState } from '../../hooks/useAsyncState';

/** This week and all time, as Claude Code reported them; nothing before any turn. */
function UsageLines({ usage }: { usage: UsageSummary | null }) {
  const week = usage && formatUsage(usage.week);
  const allTime = usage && formatUsage(usage.allTime);
  if (!allTime) return null;
  return (
    <dl className="agent-editor__usage">
      <dt>This week</dt>
      <dd>{week ?? 'No turns'}</dd>
      <dt>All time</dt>
      <dd>{allTime}</dd>
    </dl>
  );
}

/**
 * What this agent may do without asking, each with Revoke. Revoking is
 * immediate, not part of Save: it's a permission, not a draft.
 */
function Permissions({ agent }: { agent: Agent }) {
  const [rules, setRules] = useState<PermissionRule[]>(agent.permissions ?? []);
  const [error, setError] = useState<string | null>(null);
  const revoke = async (rule: PermissionRule) => {
    setError(null);
    try {
      await revokePermission(agent.id, rule.id);
      setRules((list) => list.filter((r) => r.id !== rule.id));
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  };
  return (
    <div className="agent-editor__label" role="group" aria-label="Permissions">
      Permissions
      {rules.length === 0 ? (
        <p className="agent-editor__hint">
          Nothing is always allowed. Choose “Always allow” on a request in the chat to add one.
        </p>
      ) : (
        <ul className="agent-permissions">
          {rules.map((rule) => (
            <li key={rule.id} className="agent-permissions__rule">
              <span className="agent-permissions__what">
                {SCOPE_KIND_LABEL[rule.kind] && `${SCOPE_KIND_LABEL[rule.kind]} `}
                {rule.kind.startsWith('command') ? <code>{rule.label}</code> : rule.label}
              </span>
              <TextButton
                tabIndex={0}
                className="agent-permissions__revoke"
                onClick={() => void revoke(rule)}
              >
                Revoke
              </TextButton>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="agent-editor__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface AgentEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Edit this agent; omit to create one. */
  agent?: Agent | null;
  onSaved: (agentId: string) => void;
  onDelete?: (agent: Agent) => void;
  /** Colours other agents already wear, so a new one starts on a free one. */
  takenColors?: string[];
}

/** The first colour nobody has yet; white and gray are left for the user to pick. */
function freeColor(taken: string[] = []): string {
  return AGENT_COLORS.find((c) => c !== 'white' && c !== 'gray' && !taken.includes(c)) ?? 'purple';
}

export function AgentEditorModal({
  isOpen,
  onClose,
  agent,
  onSaved,
  onDelete,
  takenColors,
}: AgentEditorModalProps) {
  const editing = Boolean(agent);
  // Keyed by the caller per open, so these start fresh each time.
  const [name, setName] = useState(agent?.name ?? '');
  const [color, setColor] = useState<string>(() => agent?.color ?? freeColor(takenColors));
  const [role, setRole] = useState(agent?.role ?? '');
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState(agent?.model ?? '');
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [showBriefing, setShowBriefing] = useState(Boolean(agent));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) return;
    let live = true;
    getAgentInstructions(agent.id)
      .then((text) => {
        if (live) setInstructions(text);
      })
      .catch(() => undefined);
    getAgentUsage(agent.id)
      .then((summary) => {
        if (live) setUsage(summary);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agent]);

  const save = useAsyncState(async () => {
    setError(null);
    try {
      if (agent) {
        await updateAgent(agent.id, { name, color, role, instructions, model });
        onSaved(agent.id);
      } else {
        const created = await createAgent({ name, color, role, instructions, model });
        onSaved(created.id);
      }
      onClose();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  });

  const canSave = name.trim().length > 0 && !save.isLoading;

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? `Edit ${agent?.name}` : 'New agent'}
      className="agent-editor"
    >
      <form
        className="agent-editor__body"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save.execute();
        }}
      >
        <div className="agent-editor__identity">
          <AgentAvatar name={name} color={color} size="field" selected />
          <TextField
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Agent name"
            maxLength={40}
            autoFocus
          />
        </div>

        {/* One Tab stop; the arrows move focus and the choice together, as radios do. */}
        <div
          className="agent-editor__colors"
          role="radiogroup"
          aria-label="Colour"
          onKeyDown={(e) => {
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            if (!step) return;
            e.preventDefault();
            const at = AGENT_COLORS.indexOf(color as AgentColor);
            const next = AGENT_COLORS[(at + step + AGENT_COLORS.length) % AGENT_COLORS.length];
            setColor(next);
            e.currentTarget.querySelector<HTMLElement>(`[data-color="${next}"]`)?.focus();
          }}
        >
          {AGENT_COLORS.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              tabIndex={
                color === key ||
                (key === AGENT_COLORS[0] && !AGENT_COLORS.includes(color as AgentColor))
                  ? 0
                  : -1
              }
              aria-checked={color === key}
              aria-label={key}
              className="agent-editor__swatch"
              data-color={key}
              data-selected={color === key || undefined}
              onClick={() => setColor(key)}
            />
          ))}
        </div>

        <div className="agent-editor__label" role="group" aria-label="Model">
          Model
          <SegmentedControl
            value={model}
            options={AGENT_MODELS}
            onValueChange={setModel}
            aria-label="Model"
          />
        </div>

        {showBriefing ? (
          <div className="agent-editor__briefing">
            <label className="agent-editor__label">
              Role
              <TextField
                placeholder="What is this agent responsible for?"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                disabled={agent?.isMain}
              />
            </label>
            <label className="agent-editor__label">
              Instructions
              <TextArea
                rows={6}
                placeholder="Brief it like a new hire: context, standing rules, who's who, where things live."
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </label>
            {editing && (
              <p className="agent-editor__hint">
                What it remembers is kept separately and isn't changed here.
              </p>
            )}
            <UsageLines usage={usage} />
            {agent && <Permissions agent={agent} />}
          </div>
        ) : (
          <TextButton className="agent-editor__more" onClick={() => setShowBriefing(true)}>
            Add a role and instructions
          </TextButton>
        )}

        {error && (
          <p className="agent-editor__error" role="alert">
            {error}
          </p>
        )}

        <div className="agent-editor__actions">
          {editing && agent && !agent.isMain && onDelete && (
            <Button
              variant="danger"
              className="agent-editor__delete"
              onClick={() => onDelete(agent)}
            >
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!canSave}>
            {editing ? 'Save' : 'Create'}
          </Button>
        </div>
      </form>
    </ModalFrame>
  );
}
