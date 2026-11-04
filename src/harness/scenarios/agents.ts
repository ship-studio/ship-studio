/**
 * Agents mode: the Grok Bot-style chat. Populated with a believable team so
 * truncation, ordering, badges and the agent-to-agent lines are reviewable.
 */

import { emit } from '@tauri-apps/api/event';
import type { Scenario } from '../types';

const MIN = 60_000;
const now = Date.now();

const status = (state: 'idle' | 'working' | 'waiting', activity: string | null = null) => ({
  state,
  activity,
  since: state === 'idle' ? null : now - 2 * MIN,
});

const agent = (
  id: string,
  name: string,
  over: Record<string, unknown> & { minutesAgo?: number } = {}
) => {
  const { minutesAgo = 60, ...rest } = over;
  return {
    id,
    name,
    role: '',
    shape: 0,
    color: 'purple',
    isMain: false,
    pinned: false,
    hidden: false,
    sessionId: 'session',
    createdAt: now - 30 * 24 * 60 * MIN,
    lastActivityAt: now - minutesAgo * MIN,
    preview: null,
    unread: 0,
    pendingApprovals: 0,
    model: null,
    status: status('idle'),
    ...rest,
  };
};

const TEAM = [
  agent('chief', 'Chief of Staff', {
    isMain: true,
    shape: 5,
    color: 'white',
    minutesAgo: 3,
    role: 'Runs the other agents, delegates work, and keeps track of everything in flight.',
    preview: 'Acme’s staging deploy is green. Want me to have Acme Site open the PR?',
  }),
  agent('acme', 'Acme Site', {
    shape: 0,
    color: 'green',
    minutesAgo: 4,
    role: 'Owns the Acme marketing site rebuild in ~/ShipStudio/acme-marketing.',
    status: status('working', 'Editing PricingTable.tsx'),
    preview: 'Fixing the pricing table on mobile now.',
  }),
  agent('finance', 'Finance', {
    shape: 1,
    color: 'orange',
    minutesAgo: 40,
    unread: 2,
    role: 'Invoices, expenses and the books.',
    preview: 'Two invoices are overdue: Northwind ($4,200) and Globex ($1,150).',
  }),
  agent('leadgen', 'Lead Gen', {
    shape: 8,
    color: 'teal',
    minutesAgo: 90,
    role: 'Finds and qualifies agency leads.',
    status: status('waiting', 'Waiting for your OK'),
    preview: 'Needs your OK: Use gmail: send email',
  }),
  agent('native', 'Native App', {
    shape: 2,
    color: 'amber',
    minutesAgo: 180,
    pinned: true,
    role: 'The Expo app: builds, TestFlight, store listings.',
    preview: 'Build 42 is on TestFlight.',
  }),
  agent('hiring', 'Hiring', {
    shape: 9,
    color: 'pink',
    minutesAgo: 60 * 26,
    role: 'Job posts, candidate screens and scheduling.',
    preview: 'Here are three replies you could send to Priya.',
  }),
  agent('social', 'Social Posts', {
    shape: 7,
    color: 'red',
    minutesAgo: 60 * 50,
    role: 'Drafts posts in your voice. Never publishes.',
    preview: 'Three drafts for Thursday are ready.',
  }),
  agent('clients', 'Client Sites QA', {
    shape: 11,
    color: 'blue',
    minutesAgo: 60 * 72,
    hidden: true,
    role: 'Weekly QA across client sites.',
    preview: 'The three QA fixes are done and pushed to branches.',
  }),
];

let n = 0;
const msg = (
  kind: string,
  text: string,
  minutesAgo: number,
  over: Record<string, unknown> = {}
) => ({
  id: `m${++n}`,
  agentId: 'chief',
  ts: now - minutesAgo * MIN,
  kind,
  text,
  ...over,
});

const CHIEF_CHAT = [
  msg('user', 'Morning. What’s on fire?', 190),
  msg(
    'agent',
    'Nothing’s on fire. Three things need you today:\n\n1. **Finance** found two overdue invoices, $5,350 total. It has reminder emails drafted.\n2. **Acme Site** is fixing the pricing table on mobile; the client flagged it yesterday.\n3. **Lead Gen** wants to email 12 new leads and is waiting for your OK on the first one.',
    189
  ),
  msg('user', 'Get Acme to also check the footer links, the client said a couple are dead.', 70),
  msg('agent', 'On it. I’ve added the footer to Acme Site’s list.', 69),
  msg(
    'sent_to_agent',
    'The client also says a couple of footer links are dead. Check every footer link on staging, fix what’s broken, and include it in the same PR as the pricing table.',
    69,
    { peer: { id: 'acme', name: 'Acme Site' } }
  ),
  msg(
    'from_agent',
    'Two dead links: /careers (page was removed) and the old Twitter URL. Fixed both on the pricing branch. Staging deploy is building.',
    12,
    { peer: { id: 'acme', name: 'Acme Site' } }
  ),
  msg('sent_to_agent', 'Good. Tell me when staging is green.', 11, {
    peer: { id: 'acme', name: 'Acme Site' },
  }),
  msg(
    'from_agent',
    'Staging is green: [acme-staging.vercel.app](https://example.com). Pricing table checked at 375px and 768px.',
    4,
    { peer: { id: 'acme', name: 'Acme Site' } }
  ),
  msg(
    'agent',
    'Acme’s staging deploy is green, with the pricing table fixed on mobile and the two dead footer links (`/careers` and the old Twitter URL) repaired. Want me to have Acme Site open the PR?',
    3
  ),
];

const LEADGEN_CHAT = [
  msg('user', 'Send the intro email to the new leads from this morning.', 15, {
    agentId: 'leadgen',
  }),
  msg('agent', 'Starting with Northwind Studio. Here’s the first one for your OK.', 14, {
    agentId: 'leadgen',
  }),
  msg('approval', '', 14, {
    agentId: 'leadgen',
    approval: {
      requestId: 'req-1',
      title: 'Use gmail: send email',
      detail:
        '{\n  "to": "hello@northwind.example",\n  "subject": "Your site, faster",\n  "body": "Hi Sam — I build marketing sites for studios like yours…"\n}',
      status: 'pending',
      tool: 'mcp__gmail__send_email',
      input: {
        to: 'hello@northwind.example',
        subject: 'Your site, faster',
        body: 'Hi Sam — I build marketing sites for studios like yours…',
      },
    },
  }),
];

const overview = (agents = TEAM, engineReady = true) => ({ agents, engineReady });

/**
 * Sending, so the motion of a send can be watched (and recorded) in the
 * harness: the message comes back as the backend's would, and for a few
 * seconds afterwards the overview reports that agent as the most recent and
 * working, so the next `agents_overview` moves its row to the top and shows
 * the typing indicator. Nothing replies; there is no event channel here.
 */
const SENT: Record<string, ReturnType<typeof msg>[]> = {};
let lastSend: { agentId: string; at: number } | null = null;

const sendMessage = (args: Record<string, unknown>) => {
  const agentId = String(args.agentId);
  const sent = { ...msg('user', String(args.text), 0, { agentId }), ts: Date.now() };
  (SENT[agentId] ??= []).push(sent);
  lastSend = { agentId, at: Date.now() };
  return sent;
};

const liveOverview = () => {
  const send = lastSend;
  if (!send) return overview();
  const working = Date.now() - send.at < 4000;
  return overview(
    TEAM.map((a) =>
      a.id === send.agentId
        ? {
            ...a,
            lastActivityAt: send.at,
            status: working ? status('working', 'Reading the message') : status('idle'),
          }
        : a
    )
  );
};

const messagesFor = (args: Record<string, unknown>) => {
  const sent = SENT[String(args.agentId)] ?? [];
  if (args.agentId === 'chief') return [...CHIEF_CHAT, ...sent];
  if (args.agentId === 'leadgen') return [...LEADGEN_CHAT, ...sent];
  return sent;
};

/** Dictation mid-sentence: a partial in the draft, the meter at a speaking level. */
const startListening = () => {
  setTimeout(() => {
    void emit('dictation://event', {
      kind: 'partial',
      session: 1,
      text: 'Can you ask Finance to send the Northwind reminder',
    });
    void emit('dictation://event', { kind: 'level', session: 1, level: 0.55 });
  }, 50);
  return { status: 'listening', session: 1 };
};

export const agentsScenarios: Scenario[] = [
  {
    id: 'agents-team',
    title: 'Agents — a working team, Chief of Staff open',
    looksRightWhen:
      'Reads like Grok Bot: agent list with blob avatars on the left (pinned first, then most recent), Chief of Staff conversation on the right with the name pill on top. “2 messages with Acme Site” style lines sit centred between bubbles. Acme Site shows what it is doing; Lead Gen shows it needs your OK; Finance shows 2 unread.',
    command: 'agents.open',
    requires: '.agent-chat .agent-bubble--agent',
    commands: {
      agents_overview: liveOverview,
      agents_messages: messagesFor,
      agents_send: sendMessage,
    },
  },
  {
    id: 'agents-approval',
    title: 'Agents — an approval waiting in the chat',
    looksRightWhen:
      'The Lead Gen chat ends in an Allow / Deny card showing exactly what will be sent; the composer is still usable.',
    // Steps run before a palette command, so this one walks in through the
    // sidebar nav and then picks the agent.
    requires: '.agent-approval',
    openSelector: '.workspace-sidebar-agents',
    steps: [{ click: '[data-agent-id="leadgen"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-first-run',
    title: 'Agents — first open, only the Chief of Staff',
    looksRightWhen:
      'One agent, the Chief of Staff, with its avatar, name and role centred in an empty conversation and the composer ready.',
    command: 'agents.open',
    requires: '.agent-chat__empty',
    commands: {},
  },
  {
    id: 'agents-new',
    title: 'Agents — creating an agent',
    looksRightWhen:
      'A badge beside the name field that updates as you type and pick a colour; eleven colours; role and instructions one link away.',
    command: 'agents.new',
    requires: '.agent-editor__colors',
    commands: {},
  },
  {
    id: 'agents-import',
    title: 'Agents — import from Grok Bot',
    looksRightWhen:
      'Explains the two steps (connect via Remote access, send the message), shows the exact message to send, and a Copy button.',
    command: 'agents.import',
    requires: '.agents-import__prompt',
    commands: {},
  },
  {
    id: 'agents-dictating',
    title: 'Agents — dictating into the composer',
    looksRightWhen:
      'The words arriving sit in the composer in the secondary text colour, not yet settled. The mic is tinted and a soft halo behind it shows the voice level; the composer border is tinted to match. Nothing reads as an error, and Send is unchanged.',
    // Steps run before a palette command, so walk in through the sidebar.
    openSelector: '.workspace-sidebar-agents',
    requires: '.agent-composer[data-dictation="listening"]',
    steps: [{ click: '.agent-composer__mic' }],
    mockEvents: true,
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      start_dictation: startListening,
      cancel_dictation: null,
      stop_dictation: null,
    },
  },
  {
    id: 'agents-dictation-blocked',
    title: 'Agents — dictation without microphone access',
    looksRightWhen:
      'One quiet line above the composer says Ship Studio needs microphone access, with a link to open System Settings. The composer still works for typing.',
    // Steps run before a palette command, so walk in through the sidebar.
    openSelector: '.workspace-sidebar-agents',
    requires: '.agent-composer__notice',
    steps: [{ click: '.agent-composer__mic' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      start_dictation: { status: 'blocked', reason: 'microphone' },
    },
  },
  {
    id: 'agents-no-engine',
    title: 'Agents — Claude Code not installed',
    looksRightWhen:
      'A banner says agents need Claude Code and offers to set it up; the composer is disabled with a reason instead of letting a message fail.',
    command: 'agents.open',
    requires: '.agents-banner',
    commands: {
      agents_overview: { ...overview(TEAM.slice(0, 1)), engineReady: false },
    },
  },
];
