/** The composer's rules, pure so they're tested (components/Composer.tsx draws them). */

import type { Agent } from '@shipstudio/companion-protocol';
import { needsYou } from './agents';

/** What the main button does now. */
export type SendMode = 'send' | 'queue' | 'stop' | 'none';

/** The composer's state machine, pure so it is tested. */
export function sendMode(agent: Agent, hasContent: boolean): SendMode {
  const busy = agent.status.state !== 'idle';
  if (hasContent) return busy ? 'queue' : 'send';
  // Waiting on an approval: the card is the control, not Stop.
  if (busy && !needsYou(agent)) return 'stop';
  return 'none';
}

/** The `@partial` being typed at the end of the text, if any. */
export function mentionQuery(text: string): string | null {
  const m = /(?:^|\s)@([\w.-]{0,24})$/.exec(text);
  return m ? m[1] : null;
}
