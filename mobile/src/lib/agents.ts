/**
 * The desktop's list rules, so the phone orders and labels agents exactly as
 * the Agents view does. Copied from src/lib/agents.ts and
 * src/components/agents/AgentAvatar.tsx; they are pure and belong in
 * @shipstudio/companion-protocol next to the quote helpers (P2 moves them).
 */

import type {
  Agent,
  AgentMessage,
  Failure,
  PermissionScope,
  SessionMark,
  UsageTotals,
} from '@shipstudio/companion-protocol';

/** Pinned first, then most recently active. */
export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActivityAt - a.lastActivityAt;
  });
}

/** Waiting on you: mid-turn on a card, or paused with one still open. */
export const needsYou = (agent: Agent) =>
  agent.status.state === 'waiting' || (agent.pendingApprovals ?? 0) > 0;

/** Its last turn failed, and nothing has been said since. */
export const failedTurn = (agent: Agent): Failure | null =>
  agent.failure && agent.status.state === 'idle' ? agent.failure : null;

export const needsAttention = (agent: Agent) => needsYou(agent) || failedTurn(agent) !== null;

export function failureLine(failure: Failure, preview: string | null): string {
  if (failure.kind === 'usage_limit') {
    return failure.resetsAt
      ? `Usage limit · resets ${formatClock(failure.resetsAt)}`
      : 'Usage limit reached';
  }
  if (failure.kind === 'signed_out') return 'Claude Code is signed out';
  const clause = (preview ?? '').split(/(?<=[.!?:])\s/)[0].replace(/[.:]$/, '');
  return clause ? `Didn’t finish: ${clause}` : 'Didn’t finish';
}

/** The row's second line, as the sidebar writes it. */
export function subtitle(agent: Agent): string {
  if (needsYou(agent)) return 'Needs your OK';
  if (agent.status.state === 'working') return agent.status.activity ?? 'Working…';
  const failure = failedTurn(agent);
  if (failure) return failureLine(failure, agent.preview);
  return agent.preview ?? agent.role ?? '';
}

export type LineState = 'waiting' | 'working' | 'failed' | 'limited' | undefined;

export function lineState(agent: Agent): LineState {
  if (needsYou(agent)) return 'waiting';
  if (agent.status.state === 'working') return 'working';
  const failure = failedTurn(agent);
  if (failure) return failure.kind === 'usage_limit' ? 'limited' : 'failed';
  return undefined;
}

/** A message of yours sent after the turn in progress began: queued for the next one. */
export function isQueued(message: Pick<AgentMessage, 'kind' | 'ts'>, agent: Agent): boolean {
  const { state, since } = agent.status;
  return message.kind === 'user' && state !== 'idle' && since != null && message.ts > since;
}

/** "Chief of Staff" → "CS", "Agent 3" → "A3", "Finance" → "FI". */
export function agentInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter(
      (w) => /[A-Za-z0-9]/.test(w) && !['of', 'the', 'and', 'for', '&'].includes(w.toLowerCase())
    );
  const number = words.length >= 2 ? words[words.length - 1] : '';
  if (/^\d+$/.test(number)) {
    return number.length >= 2 ? number.slice(-2) : (words[0][0] + number).toUpperCase();
  }
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? name.trim();
  return word.slice(0, 2).toUpperCase();
}

function consonantInitials(name: string): string {
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  const next = letters.slice(1).match(/[b-df-hj-np-tv-z0-9]/i)?.[0] ?? letters[1] ?? '';
  return (letters[0] + next).toUpperCase();
}

/** Initials that don't collide with an agent listed before this one. */
export function distinctInitials(name: string, names: string[]): string {
  const own = agentInitials(name);
  const index = names.indexOf(name);
  const earlier = index === -1 ? names : names.slice(0, index);
  return earlier.some((n) => n !== name && agentInitials(n) === own)
    ? consonantInitials(name)
    : own;
}

/** Visible agents' names in creation order, Chief first: what `distinctInitials` compares. */
export const teamNames = (agents: Agent[]) =>
  agents
    .filter((a) => !a.hidden)
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.createdAt - b.createdAt)
    .map((a) => a.name);

/**
 * What "Always allow" will stop asking about, in a sentence. `revocable`:
 * end by saying where it can be taken back (not needed beside Revoke itself).
 */
export function describeScope(scope: PermissionScope, agentName: string, revocable = true): string {
  const what =
    scope.kind === 'command_prefix'
      ? `Any command starting with “${scope.label}”`
      : scope.kind === 'command'
        ? `Exactly “${scope.label}”`
        : scope.kind === 'domain'
          ? `Opening pages on ${scope.label}`
          : `“${scope.label}”`;
  const chained = scope.kind.startsWith('command')
    ? ' Commands chained with &&, ; or | still ask.'
    : '';
  const revoke = revocable ? ` Revoke it any time from ${agentName}’s sheet.` : '';
  return `${what} runs for ${agentName} without asking.${chained}${revoke}`;
}

const tokenCount = (t: UsageTotals) => {
  const n = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;
};

/** Turns, tokens and cost, as the Mac counts them. Cost only for the turns it could price. */
export function usageLine(t: UsageTotals): string {
  if (!t.turns) return 'Nothing yet';
  const cost =
    t.pricedTurns > 0
      ? `$${t.costUsd.toFixed(2)}${t.pricedTurns < t.turns ? ` for ${t.pricedTurns} of them` : ''}`
      : null;
  return [`${t.turns} turn${t.turns === 1 ? '' : 's'}`, `${tokenCount(t)} tokens`, cost]
    .filter(Boolean)
    .join(' · ');
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const CLI_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'Opencode',
};

/** "Claude Code 1": the tab as the project's tab bar names it. */
export function sessionLabel(mark: SessionMark): string {
  const cli = (mark.cli && CLI_NAMES[mark.cli]) ?? mark.cli ?? 'Session';
  return mark.tab ? `${cli} ${mark.tab}` : cli;
}

/** A project path's last folder: what the desktop calls a project with no name. */
export const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path;

/** "just now", "4 min ago", "2 h ago", or a date. */
export function formatAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** An agent's approval still waiting, as far as this phone's copy of its chat shows. */
export function pendingApproval(messages: AgentMessage[] | undefined): AgentMessage | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'approval' && messages[i].approval?.status === 'pending') {
      return messages[i];
    }
  }
  return undefined;
}

/**
 * The row's second line for an agent waiting on you: what it's asking, when
 * the saved chat says; only "Needs your OK" when it doesn't.
 */
export function needsLine(agent: Agent, messages: AgentMessage[] | undefined): string {
  const asking = pendingApproval(messages)?.approval;
  return asking?.detail
    ? `Needs your OK · ${asking.detail.split('\n')[0]}`
    : asking
      ? `Needs your OK · ${asking.title}`
      : subtitle(agent);
}

/** "2 need you · 3 working", over the agents shown on Home. */
export function attentionCounts(agents: Agent[]) {
  const shown = agents.filter((a) => !a.hidden);
  return {
    needYou: shown.filter(needsYou).length,
    working: shown.filter((a) => !needsYou(a) && a.status.state === 'working').length,
  };
}

/**
 * The next thing waiting on you, in Home's order: the agent and, when the
 * saved chat has it, the approval to open at.
 */
export function nextNeedsYou(
  agents: Agent[],
  chats: Record<string, { messages: AgentMessage[] } | undefined>
): { agentId: string; messageId?: string } | null {
  const next = sortAgents(agents.filter((a) => !a.hidden)).find(needsYou);
  if (!next) return null;
  const card = pendingApproval(chats[next.id]?.messages);
  return { agentId: next.id, ...(card ? { messageId: card.id } : {}) };
}
