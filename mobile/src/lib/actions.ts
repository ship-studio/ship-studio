/**
 * What a long-press (and a swipe) offers, as data: the same list drives the
 * iOS context menu, the Android sheet and the tests. The handlers live with
 * the screens; this only decides what's on offer for what's pressed.
 */

import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';
import type { SymbolViewProps } from 'expo-symbols';

type SFSymbol = Extract<SymbolViewProps['name'], string>;

export type AgentAction = 'pin' | 'unpin' | 'markUnread' | 'mute' | 'unmute' | 'hide' | 'unhide';
export type MessageAction = 'copy' | 'copyMarkdown' | 'quote' | 'select';

export interface Action<Id extends string> {
  id: Id;
  title: string;
  icon: SFSymbol;
  destructive?: boolean;
}

/** What the Mac lets this phone change (`welcome.methods`). */
export interface AgentCaps {
  update: boolean;
  markUnread: boolean;
}

export function agentActions(agent: Agent, caps: AgentCaps): Action<AgentAction>[] {
  const out: Action<AgentAction>[] = [];
  if (caps.update) {
    out.push(
      agent.pinned
        ? { id: 'unpin', title: 'Unpin', icon: 'pin.slash' }
        : { id: 'pin', title: 'Pin', icon: 'pin' }
    );
  }
  // Mark unread means nothing for a chat that's already unread.
  if (caps.markUnread && agent.unread === 0) {
    out.push({ id: 'markUnread', title: 'Mark as Unread', icon: 'message.badge' });
  }
  if (caps.update) {
    out.push(
      agent.muted
        ? { id: 'unmute', title: 'Unmute', icon: 'bell' }
        : { id: 'mute', title: 'Mute', icon: 'bell.slash' }
    );
    // The Chief of Staff runs the team; the desk doesn't let it be hidden either.
    if (!agent.isMain) {
      out.push(
        agent.hidden
          ? { id: 'unhide', title: 'Unhide', icon: 'eye' }
          : { id: 'hide', title: 'Hide', icon: 'eye.slash', destructive: true }
      );
    }
  }
  return out;
}

/** The toggle an action sets, for `agents.update`. */
export function toggleFor(
  id: AgentAction
): Partial<Record<'pinned' | 'muted' | 'hidden', boolean>> | null {
  switch (id) {
    case 'pin':
      return { pinned: true };
    case 'unpin':
      return { pinned: false };
    case 'mute':
      return { muted: true };
    case 'unmute':
      return { muted: false };
    case 'hide':
      return { hidden: true };
    case 'unhide':
      return { hidden: false };
    default:
      return null;
  }
}

/** Messages with words in them; cards and lines have their own controls. */
export function messageActions(
  message: Pick<AgentMessage, 'kind' | 'text'>
): Action<MessageAction>[] {
  if (!message.text.trim()) return [];
  if (message.kind !== 'agent' && message.kind !== 'user') return [];
  const out: Action<MessageAction>[] = [{ id: 'copy', title: 'Copy', icon: 'doc.on.doc' }];
  if (message.kind === 'agent' && /[*_`#>[\]|-]/.test(message.text)) {
    out.push({ id: 'copyMarkdown', title: 'Copy as Markdown', icon: 'text.badge.checkmark' });
  }
  out.push(
    { id: 'quote', title: 'Quote', icon: 'text.quote' },
    { id: 'select', title: 'Select Text', icon: 'selection.pin.in.out' }
  );
  return out;
}

/**
 * A reply as plain words, for Copy: markdown's marks dropped, its text and
 * structure (paragraphs, list items, code) kept.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/gm, '$1')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .trim();
}
