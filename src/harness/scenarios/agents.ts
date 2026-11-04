/**
 * Agents mode: the Grok Bot-style chat. Populated with a believable team so
 * truncation, ordering, badges and the agent-to-agent lines are reviewable.
 */

import type { Scenario } from '../types';

const MIN = 60_000;
const DEMO_HOME = '/harness/agents-demo';
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
    // Served by the harness's dev server, so attachment images load over HTTP.
    home: DEMO_HOME,
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

const shot = (name: string, size: number) => ({
  name,
  path: `attachments/m-att1/${name}`,
  mime: 'image/jpeg',
  size,
});

const ACME_CHAT = [
  msg(
    'user',
    'The client sent these. The pricing cards overlap on mobile and two footer links 404.',
    50,
    {
      agentId: 'acme',
      attachments: [
        shot('Pricing on mobile.jpg', 40_266),
        shot('Footer links.jpg', 36_471),
        shot('Hero crop.jpg', 27_238),
      ],
    }
  ),
  msg(
    'agent',
    'Got them. The cards overlap below 400px because the grid keeps three columns; I’ll stack them. Checking the footer next.',
    49,
    { agentId: 'acme' }
  ),
  msg(
    'user',
    '> The cards overlap below 400px because the grid keeps three columns\n\nStack them below 640px too. The tablet layout breaks the same way.',
    48,
    { agentId: 'acme' }
  ),
  msg('user', '', 20, {
    agentId: 'acme',
    attachments: [
      {
        name: 'Acme brand guidelines 2026.pdf',
        path: 'attachments/m-att2/Acme brand guidelines 2026.pdf',
        mime: 'application/pdf',
        size: 4_812_330,
      },
      {
        name: 'footer-links.csv',
        path: 'attachments/m-att2/footer-links.csv',
        mime: 'text/csv',
        size: 2_140,
      },
    ],
  }),
  msg(
    'agent',
    'Read both. The guidelines want 24px gutters on mobile, so the stacked cards use that. The CSV lists 31 links; **2 are dead**: `/careers` and the old Twitter URL.\n\nFixing them on the pricing branch.',
    19,
    { agentId: 'acme' }
  ),
];

/** What the paperclip "picks" in the harness, and what the backend says about it. */
const PICKED = [
  `${DEMO_HOME}/attachments/m-att1/Pricing on mobile.jpg`,
  '/Users/harness/Desktop/QA notes from the client call.md',
];
const inspectFiles = (args: Record<string, unknown>) =>
  (args.paths as string[]).map((path) => {
    const name = path.split('/').pop() ?? path;
    const image = name.endsWith('.jpg');
    return {
      path,
      name,
      mime: image ? 'image/jpeg' : 'text/markdown',
      size: image ? 40_266 : 6_220,
    };
  });

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
  if (args.agentId === 'acme') return [...ACME_CHAT, ...sent];
  return sent;
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
    id: 'agents-attachments',
    title: 'Agents — attachments sent and staged',
    looksRightWhen:
      'Acme Site’s chat: a user message carrying three screenshots as a right-aligned thumbnail row above its text, then a reply that quotes the agent (a quote bar inside the bubble above the user’s words), then a files-only message as two same-height chips (PDF, CSV) side by side against the right edge. The composer holds one staged image thumbnail and one file chip of the same height above the text field, with the paperclip and Send on the same bottom line.',
    requires: '.agent-composer__attachments',
    openSelector: '.workspace-sidebar-agents',
    steps: [{ click: '[data-agent-id="acme"]' }, { click: '.agent-composer__attach' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_inspect_files: inspectFiles,
      'plugin:dialog|open': PICKED,
      agents_send: sendMessage,
    },
  },
  {
    id: 'agents-attachment-view',
    title: 'Agents — a sent screenshot opened full size',
    looksRightWhen:
      'A dialog titled with the file name shows the screenshot at full size, with an Open button beside the close button.',
    requires: '.agent-lightbox__image',
    openSelector: '.workspace-sidebar-agents',
    steps: [{ click: '[data-agent-id="acme"]' }, { click: '.agent-attachments__image' }],
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
