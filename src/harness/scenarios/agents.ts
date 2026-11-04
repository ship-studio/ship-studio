/**
 * Agents mode: the Grok Bot-style chat. Populated with a believable team so
 * truncation, ordering, badges and the agent-to-agent lines are reviewable.
 */

import { emit } from '@tauri-apps/api/event';
import type { Scenario } from '../types';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';

const MIN = 60_000;
const DEMO_HOME = '/harness/agents-demo';
const now = Date.now();

/** Tomorrow at a local wall-clock time, so fixtures agree with their own "at 09:00". */
const tomorrowAt = (hour: number, minute = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};

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
    model: null as string | null,
    muted: false,
    status: status('idle'),
    // Served by the harness's dev server, so attachment images load over HTTP.
    home: DEMO_HOME,
    ...rest,
  };
};

const TEAM = [
  agent('chief', 'Chief of Staff', {
    isMain: true,
    // Created pinned: the one agent you're told to talk to doesn't move.
    pinned: true,
    shape: 5,
    color: 'white',
    minutesAgo: 3,
    role: 'Runs the other agents and keeps track of what’s in flight.',
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
    checkIns: [
      {
        id: 'ci1',
        note: 'See whether Northwind paid the $4,200 invoice; if not, draft a firmer reminder.',
        nextAt: tomorrowAt(9),
        createdAt: now - 60 * MIN,
        paused: false,
      },
      {
        id: 'ci2',
        note: 'Brief me on what came in and went out yesterday, and anything overdue.',
        repeat: { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
        nextAt: tomorrowAt(9),
        createdAt: now - 7 * 24 * 60 * MIN,
        paused: false,
      },
      {
        id: 'ci3',
        note: 'Reconcile the month against the bank export.',
        repeat: { kind: 'days', days: [1], hour: 8, minute: 30 },
        nextAt: now + 5 * 24 * 60 * MIN,
        createdAt: now - 30 * 24 * 60 * MIN,
        paused: true,
      },
    ],
    role: 'Invoices, expenses and the books.',
    preview: 'Two invoices are overdue: Northwind ($4,200) and Globex ($1,150).',
  }),
  agent('leadgen', 'Lead Gen', {
    shape: 8,
    color: 'teal',
    minutesAgo: 90,
    role: 'Finds and qualifies agency leads.',
    status: status('waiting', 'Waiting for your OK'),
    preview: 'Needs your OK: Send an email · Gmail',
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
    muted: true,
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
  msg(
    'user',
    'Get @Acme Site to also check the footer links, the client said a couple are dead.',
    70,
    {
      mentions: [{ id: 'acme', name: 'Acme Site' }],
    }
  ),
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
      title: 'Send an email · Gmail',
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

const FINANCE_CHAT = [
  msg('user', 'Chase Northwind if they haven’t paid by tomorrow.', 70, { agentId: 'finance' }),
  msg(
    'agent',
    'Will do. I’ll check back tomorrow at 9:00 and draft a firmer reminder if it’s still open.',
    69,
    { agentId: 'finance' }
  ),
  msg('user', 'What’s outstanding this month?', 60, { agentId: 'finance' }),
  msg(
    'agent',
    [
      'Two invoices are overdue:',
      '',
      '| Client | Amount | Days late |',
      '| --- | --- | --- |',
      '| Northwind | $4,200 | 18 |',
      '| Globex | $1,150 | 6 |',
      '',
      '> Northwind said last week the payment was “in the next run”.',
      '',
      'The reminder I drafted uses your usual template:',
      '',
      '```',
      'Hi Sam, a quick nudge on invoice #1042 ($4,200), due Oct 17.',
      'Let me know if anything is holding it up.',
      '```',
      '',
      '---',
      '',
      '#### Next',
      '- Send both reminders',
      '- Re-check on Friday',
    ].join('\n'),
    45,
    { agentId: 'finance' }
  ),
  msg('check_in', 'Brief me on what came in and went out yesterday, and anything overdue.', 41, {
    agentId: 'finance',
    checkIn: { dueAt: tomorrowAt(9) - 24 * 60 * MIN, late: true, repeats: false },
  }),
  msg(
    'agent',
    'Two invoices are overdue: **Northwind** ($4,200, 9 days) and **Globex** ($1,150, 3 days). Nothing else needs you.',
    40,
    { agentId: 'finance' }
  ),
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

/**
 * What Acme Site handed back with `share_file`: a caption and a PDF, a CSV on
 * its own, a screenshot (shown inline), then prose naming paths on disk,
 * which render as links that open the file.
 */
const shared = (id: string, name: string, mime: string, size: number, path?: string) => ({
  name,
  path: path ?? `attachments/${id}/${name}`,
  mime,
  size,
});
const ACME_SHARED = [
  msg('user', 'Can you send me the QA report and the fixed hero?', 12, { agentId: 'acme' }),
  msg('agent', 'QA report for the pricing branch: 31 links checked, 2 fixed.', 11, {
    agentId: 'acme',
    attachments: [shared('m-s1', 'Acme QA report.pdf', 'application/pdf', 1_284_400)],
  }),
  msg('agent', '', 11, {
    agentId: 'acme',
    attachments: [shared('m-s2', 'footer-links-checked.csv', 'text/csv', 2_480)],
  }),
  msg('agent', 'The hero at 375px, after the fix.', 10, {
    agentId: 'acme',
    attachments: [
      shared('m-s3', 'Hero at 375px.jpg', 'image/jpeg', 27_238, 'attachments/m-att1/Hero crop.jpg'),
    ],
  }),
  msg(
    'agent',
    'Both are also in the project: the report is at ~/ShipStudio/acme-marketing/qa/report.md and the raw crawl is `~/ShipStudio/acme-marketing/qa/crawl 2026-11-04.json`. The `/careers` route now redirects.',
    9,
    { agentId: 'acme' }
  ),
];

/** The Files list for Acme Site: both directions, newest first. */
type Shared = ReturnType<typeof shared>;
const filesOf = (messages: Record<string, unknown>[], from: 'user' | 'agent') =>
  messages.flatMap((m) =>
    ((m.attachments as Shared[] | undefined) ?? []).map((a) => ({
      ...a,
      messageId: m.id,
      ts: m.ts as number,
      from,
    }))
  );
const ACME_FILES = [...filesOf(ACME_SHARED, 'agent'), ...filesOf(ACME_CHAT, 'user')].sort(
  (a, b) => b.ts - a.ts
);

const withShared = (args: Record<string, unknown>) =>
  args.agentId === 'acme' ? [...ACME_CHAT, ...ACME_SHARED] : messagesFor(args);

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
const schedulePreview = (args: Record<string, unknown>) => {
  const when = String(args.when).toLowerCase();
  if (when.startsWith('every'))
    return {
      nextAt: tomorrowAt(9),
      repeat: { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
    };
  if (when.includes('tomorrow')) return { nextAt: tomorrowAt(9), repeat: null };
  throw new Error('Give it a day and a time.');
};

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
  // As the backend does: the mentioned agents, by the names they have now.
  const mentions = ((args.mentions as string[] | undefined) ?? []).flatMap((id) => {
    const found = TEAM.find((a) => a.id === id);
    return found ? [{ id, name: found.name }] : [];
  });
  const sent = { ...msg('user', String(args.text), 0, { agentId, mentions }), ts: Date.now() };
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
  if (args.agentId === 'finance') return [...FINANCE_CHAT, ...sent];
  if (args.agentId === 'acme') return [...ACME_CHAT, ...sent];
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

/**
 * A reply streaming in, played the way the backend sends it: drafts every
 * 40ms carrying the text so far, then the finished message under the draft's
 * id, the working line ("Editing …") while a tool runs, and a second block.
 * Frozen (the default capture) it stops mid-way through the second block, so
 * the screenshot is deterministic; with `?freeze=off` it plays in real time.
 */
const STREAM_ASK = msg('user', 'Where are we on the Acme pricing fix?', 0);
const STREAM_BLOCKS = [
  'Checking with Acme Site now. The pricing cards were stacking at 400px but **not at tablet widths**, which is the bug the client saw.',
  'Fixed. The cards now stack below 640px, and the footer links point at the right pages:\n\n- `/careers` goes to the new jobs page\n- the old Twitter link is now the X profile\n\nStaging redeploys in a minute; I’ll send you the link.',
];
let streamStarted = false;

const playStream = () => {
  const frozen = document.documentElement.hasAttribute('data-harness-freeze');
  const at = (ms: number, fn: () => void) => (frozen ? fn() : void setTimeout(fn, ms));
  const working = (activity: string | null) =>
    void emit('agents://status', {
      agentId: 'chief',
      status: { state: 'working', activity, since: Date.now() },
    });
  // Real deltas are a word or three.
  const chunks = (text: string) =>
    text
      .match(/\S+\s*|\s+/g)
      ?.flatMap((w, i, all) => (i % 2 === 0 ? [w + (all[i + 1] ?? '')] : [])) ?? [text];
  let t = 600;
  STREAM_BLOCKS.forEach((block, b) => {
    const id = `stream-${b}`;
    const parts = chunks(block);
    const last = b === STREAM_BLOCKS.length - 1;
    // Frozen, the second block stops a little over halfway, still writing.
    const shown = frozen && last ? Math.ceil(parts.length * 0.6) : parts.length;
    let text = '';
    for (let i = 0; i < shown; i++) {
      text += parts[i];
      const draft = text;
      at((t += 45), () => void emit('agents://draft', { agentId: 'chief', id, text: draft }));
    }
    if (shown < parts.length) return;
    at((t += 60), () => {
      void emit('agents://message', {
        ...STREAM_ASK,
        id,
        ts: Date.now(),
        kind: 'agent',
        text: block,
      });
      if (!last) working('Editing PricingCards.tsx');
      else void emit('agents://status', { agentId: 'chief', status: status('idle') });
    });
    t += 1600;
  });
};

const streamMessages = () => {
  if (!streamStarted) {
    streamStarted = true;
    setTimeout(playStream, 300);
  }
  return [...CHIEF_CHAT, { ...STREAM_ASK, ts: Date.now() }];
};

/**
 * A plain scan like the backend's: every word, any case, newest first, with
 * the snippet cut around the first match.
 */
const searchFor = (args: Record<string, unknown>) => {
  const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
  const names: Record<string, [string, string]> = {
    chief: ['Chief of Staff', 'white'],
    leadgen: ['Lead Gen', 'teal'],
  };
  return [...CHIEF_CHAT, ...LEADGEN_CHAT]
    .filter((m) => m.kind !== 'approval' && words.every((w) => m.text.toLowerCase().includes(w)))
    .sort((a, b) => b.ts - a.ts)
    .map((m) => {
      const at = Math.max(0, m.text.toLowerCase().indexOf(words[0]) - 40);
      return {
        agentId: m.agentId,
        agentName: names[m.agentId][0],
        agentColor: names[m.agentId][1],
        messageId: m.id,
        ts: m.ts,
        kind: m.kind,
        peerName: (m as { peer?: { name: string } }).peer?.name,
        snippet:
          (at > 0 ? '…' : '') +
          m.text
            .replace(/\*\*|`/g, '')
            .replace(/\s+/g, ' ')
            .slice(at),
      };
    });
};

/** A usage limit that resets in two hours, as Claude Code reported it. */
const RESETS_AT = Math.ceil((now + 2 * 60 * MIN) / (15 * MIN)) * 15 * MIN;
const resetClock = new Date(RESETS_AT).toLocaleTimeString(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const usageLimit = (minutesAgo: number) =>
  msg('error', `Claude Code’s usage limit is reached. It resets at ${resetClock}.`, minutesAgo, {
    agentId: 'finance',
    failure: { kind: 'usage_limit', resetsAt: RESETS_AT },
  });

const ERROR_CHAT = [
  msg('user', 'Send Northwind the firmer reminder.', 30, { agentId: 'finance' }),
  usageLimit(29),
  msg('user', 'Try again now.', 5, { agentId: 'finance' }),
  msg('error', 'Claude Code is signed out.', 4, {
    agentId: 'finance',
    failure: { kind: 'signed_out' },
  }),
];

/** The newest line is the usage limit, with the files the failed message carried. */
const LIMIT_CHAT = [
  msg('user', 'Here are the March receipts: reconcile them against the ledger.', 6, {
    agentId: 'finance',
    attachments: [
      {
        name: 'receipts-march.pdf',
        path: 'attachments/m-limit/receipts-march.pdf',
        mime: 'application/pdf',
        size: 482_000,
      },
    ],
  }),
  usageLimit(5),
];

/** Finance at its usage limit, Lead Gen's turn failed outright. */
const failingOverview = () => ({
  engineReady: true,
  agents: TEAM.map((a) =>
    a.id === 'finance'
      ? {
          ...a,
          unread: 0,
          preview: `Claude Code’s usage limit is reached. It resets at ${resetClock}.`,
          failure: { kind: 'usage_limit', resetsAt: RESETS_AT },
        }
      : a.id === 'leadgen'
        ? {
            ...a,
            pendingApprovals: 0,
            status: status('idle'),
            preview: 'Couldn’t start Claude Code: the agent’s folder is missing. Recreate it.',
            failure: { kind: 'other' },
          }
        : a
  ),
});
const LEADGEN_FAILED = [
  msg('user', 'Pull this week’s inbound leads into the sheet.', 3, { agentId: 'leadgen' }),
  msg('error', 'Couldn’t start Claude Code: the agent’s folder is missing. Recreate it.', 2, {
    agentId: 'leadgen',
    failure: { kind: 'other' },
  }),
];

/** Acme Site mid-turn: a call it was always allowed, then one it asks about. */
const ALWAYS_CHAT = [
  msg('user', 'Run the tests before you push the pricing fix.', 6, { agentId: 'acme' }),
  msg('note', 'Allowed automatically: npm run lint · Always allowed', 5, { agentId: 'acme' }),
  msg('approval', '', 4, {
    agentId: 'acme',
    approval: {
      requestId: 'req-2',
      title: 'Run a command',
      detail: 'npm test -- --run pricing',
      status: 'pending',
      tool: 'Bash',
      input: { command: 'npm test -- --run pricing' },
      always: { kind: 'command_prefix', value: 'npm test', label: 'npm test' },
    },
  }),
];

/** "Always allow" on one card, which also answered the other card it covers. */
const ALWAYS_ALLOWED_CHAT = [
  msg('user', 'Run the tests before you push the pricing fix.', 6, { agentId: 'acme' }),
  ...[
    ['req-3', 'npm test -- --run pricing', 4],
    ['req-4', 'npm test -- --run checkout', 3],
  ].map(([requestId, command, ago]) =>
    msg('approval', '', ago as number, {
      agentId: 'acme',
      approval: {
        requestId,
        title: 'Run a command',
        detail: command,
        status: 'allowed',
        tool: 'Bash',
        input: { command },
        always: { kind: 'command_prefix', value: 'npm test', label: 'npm test' },
        alwaysAllowed: true,
      },
    })
  ),
];

/** Earlier, an interruption; now a message queued behind the turn in progress. */
const QUEUED_CHAT = [
  msg('user', 'Fix the pricing cards on mobile.', 30, { agentId: 'acme' }),
  msg('agent', 'Looking at the grid now. The cards keep three columns below', 29, {
    agentId: 'acme',
    stopped: true,
  }),
  msg('note', 'Interrupted to read your new message', 29, { agentId: 'acme' }),
  msg('user', 'Do the tablet layout first, the client is demoing on an iPad.', 29, {
    agentId: 'acme',
  }),
  msg(
    'agent',
    'Tablet first, then. The cards now stack at 768px; I’ll carry on with mobile after.',
    20,
    { agentId: 'acme' }
  ),
  msg('user', 'Also check the footer links once that’s done.', 0.5, { agentId: 'acme' }),
];

const acmeWith = (over: Record<string, unknown>) =>
  overview(TEAM.map((a) => (a.id === 'acme' ? { ...a, ...over } : a)));

/** The Agents half of the sidebar's Projects | Agents toggle. */
const AGENTS_TAB = '.mode-toggle [data-tab-value="agents"]';

const totals = (turns: number, tokens: number, cost: number, minutes: number) => ({
  turns,
  inputTokens: Math.round(tokens * 0.01),
  outputTokens: Math.round(tokens * 0.04),
  cacheReadTokens: Math.round(tokens * 0.7),
  cacheWriteTokens: Math.round(tokens * 0.25),
  costUsd: cost,
  pricedTurns: turns,
  durationMs: minutes * MIN,
});

export const agentsScenarios: Scenario[] = [
  {
    id: 'agents-team',
    title: 'Agents — a working team, Chief of Staff open',
    looksRightWhen:
      'Agent list under the Projects | Agents toggle and conversation search (pinned first, then most recent), one hairline per row; the Chief of Staff conversation with its name centred in the header band. “2 messages with Acme Site” lines sit centred between bubbles. Acme Site shows what it is doing; Lead Gen shows it needs your OK; Finance shows unread.',
    command: 'agents.open',
    requires: '.agent-chat .agent-bubble--agent',
    commands: {
      agents_overview: liveOverview,
      agents_messages: messagesFor,
      agents_send: sendMessage,
      // ⌘F works here too, including at compact width.
      agents_search: searchFor,
    },
  },
  {
    id: 'agents-approval',
    title: 'Agents — an approval waiting in the chat',
    looksRightWhen:
      'The Lead Gen chat ends in an Allow / Deny card showing exactly what will be sent; the composer is still usable.',
    // Steps run before a palette command, so this one walks in through the
    // mode toggle and then picks the agent.
    requires: '.agent-approval',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="leadgen"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-markdown',
    title: 'Agents — a reply with a table, a quote and a code block',
    looksRightWhen:
      'Agent replies are unboxed prose on the canvas at a reading measure; only your messages are bubbles. The table has ruled rows and a quiet header; the quote has a rule on its left; the code block is a panel with Copy on hover; the rule is a hairline with room above and below.',
    requires: '.agent-code',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-check-in',
    title: 'Agents — a scheduled check-in fired in the chat',
    looksRightWhen:
      'The Finance chat shows a centred “Scheduled check-in · late, was due …” line with the note under it, then the reply. The header shows “3 scheduled” beside the … menu.',
    requires: '.agent-checkin',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-error',
    title: 'Agents — a usage limit, then an expired login',
    looksRightWhen:
      'Finance’s chat: an older usage-limit notice in quiet amber with its reset time and no buttons (something was said after it), then the newest error, “Claude Code is signed out.” in red, carrying “Sign in to Claude Code” and a quieter Retry.',
    requires: '.agent-bubble__remedy',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance' ? ERROR_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-usage-limit',
    title: 'Agents — a usage limit with a reset time Claude Code reported',
    looksRightWhen:
      'Finance’s chat ends in a quiet amber notice (not a red alarm): “Claude Code’s usage limit is reached. It resets at <time>.” with “Retry at <time>” and a ghost “Retry now”. Finance’s sidebar row reads “Usage limit · resets <time>” in muted text with an amber dot; Lead Gen’s row reads “Didn’t finish: …” in red with a red dot.',
    requires: '.agent-bubble--error[data-failure="usage_limit"]',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: failingOverview,
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance'
          ? LIMIT_CHAT
          : args.agentId === 'leadgen'
            ? LEADGEN_FAILED
            : messagesFor(args),
      agents_schedule_create: (args: Record<string, unknown>) => ({
        id: 'retry',
        note: String(args.note),
        nextAt: RESETS_AT,
        createdAt: now,
        paused: false,
      }),
    },
  },
  {
    id: 'agents-team-failures',
    title: 'Agents — Team lists turns that didn’t finish',
    looksRightWhen:
      'The Team row says “1 working · 1 failed” (a usage limit heals on its own, so it isn’t counted). Needs you lists Lead Gen (“Didn’t finish: …”, red dot) with its error and Retry, and Finance (“Usage limit · resets <time>”, amber dot) with the quiet notice, “Retry at <time>” and “Retry now”. Each card spans from the name to the meta edge.',
    openSelector: AGENTS_TAB,
    requires: '.agents-team .agent-bubble--error',
    steps: [{ click: '[data-agent-id="__team"]' }],
    commands: {
      agents_overview: failingOverview,
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance'
          ? LIMIT_CHAT
          : args.agentId === 'leadgen'
            ? LEADGEN_FAILED
            : messagesFor(args),
    },
  },
  {
    id: 'agents-collapsed',
    title: 'Agents — sidebar collapsed to the rail',
    looksRightWhen:
      'The rail shows each agent’s badge with its status on the corner; the conversation header’s name is clear of the floating nav row.',
    requires: '.workspace-sidebar.is-hidden .agents-list__row',
    openSelector: AGENTS_TAB,
    steps: [{ click: '.workspace-sidebar-toggle' }],
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
    openSelector: AGENTS_TAB,
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
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }, { click: '.agent-attachments__image' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-shared-file',
    title: 'Agents — files an agent shared back',
    looksRightWhen:
      'Acme Site’s chat ends with what it handed over, against the left edge under its words: a caption with a PDF chip, a CSV chip on its own, a caption with the screenshot as an inline thumbnail, then prose whose two paths on disk read as links (the code-formatted one keeps its code look; `/careers` is not a link). Chips and thumbnail are the same family as the user’s attachments on the right.',
    requires: '.agent-attachments[data-side="agent"]',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: withShared,
    },
  },
  {
    id: 'agents-files',
    title: 'Agents — the Files list for a conversation',
    looksRightWhen:
      'Opened from the header’s … menu: a “Files” dialog with All / From you / From Acme Site, All chosen. Rows newest first: the screenshot as a small thumbnail, the others as type glyphs, each with name, then kind · size · date · who sent it, and Show in Finder and Open at the end.',
    requires: '.agent-files__row',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]:nth-child(4)' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: withShared,
      agents_files: ACME_FILES,
    },
  },
  {
    id: 'agents-files-filtered',
    title: 'Agents — the Files list, only what you sent',
    looksRightWhen:
      '“From you” is chosen; only the four files you attached are listed, without a sender in their meta line.',
    requires: '.agent-files__row',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]:nth-child(4)' },
      { click: '.agent-files__filter button:nth-child(2)' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: withShared,
      agents_files: ACME_FILES,
    },
  },
  {
    id: 'agents-scheduled',
    title: 'Agents — the schedule popover',
    looksRightWhen:
      'Clicking “3 scheduled” in the Finance header opens a popover under it: the one-time check-in, the weekday routine with its next time, and the paused Monday routine muted and last, each note on its own line with the time quieter beneath. Below, one composer line with “every weekday 9am: brief me on Acme” typed and the time read back under it, then a one-sentence footnote.',
    requires: '.agent-schedule__item',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '.agent-chat__scheduled' },
      { fill: '.agent-schedule__composer input', value: 'every weekday 9am: brief me on Acme' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_schedule_preview: schedulePreview,
    },
  },
  {
    id: 'agents-schedule-empty',
    title: 'Agents — scheduling for an agent with nothing scheduled',
    looksRightWhen:
      'The header shows a quiet clock button, not a chip. Open, it says nothing is scheduled yet, with the composer focused and its hint under it.',
    requires: '.agent-schedule__empty',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="leadgen"]' },
      { click: '.agent-chat__header [aria-label^="Schedule a check-in"]' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-search',
    title: 'Agents — searching every conversation',
    looksRightWhen:
      'The sidebar’s top field (where the palette trigger sits elsewhere) holds “footer”; there is no second search field and no magnifier on the mode toggle. The agent rows give way to hits grouped by agent: the badge in the rows’ avatar column, the name beside it, and each two-line snippet on the text column with “footer” highlighted, who said it, and a time. Agent-to-agent lines show the peer.',
    openSelector: AGENTS_TAB,
    requires: '.agents-search__hit',
    steps: [{ fill: '.agents-top-search input', value: 'footer' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_search: searchFor,
    },
  },
  {
    id: 'agents-search-jump',
    title: 'Agents — a search hit opened',
    looksRightWhen:
      'Clicking the “dead links” hit opens the Chief of Staff chat with the agent-to-agent thread expanded and centred, ringed briefly in the agent’s colour.',
    openSelector: AGENTS_TAB,
    requires: '.agents-search__hit',
    steps: [
      { fill: '.agents-top-search input', value: 'dead links' },
      { click: '.agents-search__hit:nth-of-type(2)' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_search: searchFor,
    },
  },
  {
    id: 'agents-edit-usage',
    title: 'Agents — editing an agent: model and usage',
    looksRightWhen:
      'The editor shows a Default / Opus / Sonnet / Haiku control with Sonnet chosen, and under it quiet This week / All time lines: cost, tokens, turns and time, as reported.',
    openSelector: AGENTS_TAB,
    requires: '.agent-editor__usage',
    steps: [
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]:nth-child(6)' },
    ],
    commands: {
      agents_overview: overview(
        TEAM.map((a) => (a.id === 'chief' ? { ...a, model: 'sonnet' } : a))
      ),
      agents_messages: messagesFor,
      agents_instructions: 'Keep the team moving.',
      agents_usage: {
        week: totals(14, 412_000, 3.81, 22),
        allTime: totals(161, 5_930_000, 47.2, 274),
      },
    },
  },
  {
    id: 'agents-model-menu',
    title: 'Agents — the model menu in the chat header',
    looksRightWhen:
      'A quiet “Default model” control sits between the schedule clock and the … menu; open, it lists Default, Opus, Sonnet and Haiku in plain text with a check on Default, and no item ringed or highlighted.',
    openSelector: AGENTS_TAB,
    requires: '.ss-dropdown__item',
    steps: [{ click: '.agent-chat__model' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-first-run',
    title: 'Agents — first open, only the Chief of Staff',
    looksRightWhen:
      'One agent, the Chief of Staff: its avatar and name centred in an empty conversation, one sentence saying it builds and runs your team, and three one-click starters under it (Set up my team, What can you do?, Import agents…). The composer is ready.',
    command: 'agents.open',
    requires: '.agent-chat__empty',
    commands: {},
  },
  {
    id: 'agents-new',
    title: 'Agents — creating an agent',
    looksRightWhen:
      'A badge beside the name field that updates as you type and pick a colour; eleven colours; the Default / Opus / Sonnet / Haiku control; role and instructions one link away.',
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
    id: 'agents-streaming',
    title: 'Agents — a reply streaming in',
    looksRightWhen:
      'The first reply is complete; below it the second is still being written: plain agent bubble, same width and type as the rest, a soft dot breathing at the end of its last line, no typing dots under it. The header still says Working and the composer offers Stop. With ?freeze=off it plays live: words arrive every 40ms, the bubble grows without re-animating, and “Editing PricingCards.tsx” shows between the two blocks.',
    command: 'agents.open',
    requires: '.agent-bubble[data-streaming]',
    mockEvents: true,
    commands: {
      agents_overview: overview(
        TEAM.map((a) => (a.id === 'chief' ? { ...a, status: status('working') } : a))
      ),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? streamMessages() : messagesFor(args),
    },
  },
  {
    id: 'agents-team-overview',
    title: 'Agents — Team: what’s in flight',
    looksRightWhen:
      'The Team row heads the agent list, selected, saying “1 working · 1 needs you”. The main column shows four sections in a fixed order: Needs you (Lead Gen, with its Gmail card answerable in place), Working now (Acme Site, “Editing PricingTable.tsx”, with the loader), Scheduled next (Finance’s two active check-ins, soonest first, the paused one absent), Recent replies (newest first, one plain line each, with times). Rows share the sidebar’s badge and type.',
    openSelector: AGENTS_TAB,
    requires: '.agents-team .agent-approval',
    steps: [{ click: '[data-agent-id="__team"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-mention',
    title: 'Agents — @ in the composer offers the team',
    looksRightWhen:
      'Typing “@fi” opens the app’s menu surface upward from the composer’s left edge: Finance first (its name starts with “fi”), each row a mini badge, the name, and the role muted. The first row is highlighted; the field keeps focus. Earlier in the chat, “@Acme Site” in your bubble is tinted green.',
    openSelector: AGENTS_TAB,
    requires: '.agent-mention-menu',
    steps: [{ fill: '.agent-composer__input', value: 'Can you ask @fi' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-dictating',
    title: 'Agents — dictating into the composer',
    looksRightWhen:
      'The words arriving sit in the composer in the full text colour, never mistakable for the placeholder. The mic is green with a green halo sized by the voice level; the composer border is tinted green; in the paperclip’s place a pulsing dot says Listening with a Cancel beside it. Nothing reads as an error, and Send is unchanged.',
    // Steps run before a palette command, so walk in through the sidebar.
    openSelector: AGENTS_TAB,
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
    openSelector: AGENTS_TAB,
    requires: '.agent-composer__notice',
    steps: [{ click: '.agent-composer__mic' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      start_dictation: { status: 'blocked', reason: 'microphone' },
    },
  },
  {
    id: 'agents-always-allow',
    title: 'Agents — Always allow on an approval, and a call it allowed itself',
    looksRightWhen:
      'Acme Site’s chat: a quiet centred “Allowed automatically: npm run lint · Always allowed” line, then a “Run a command” card for npm test -- --run pricing. Deny and Allow sit on the right; on the left, apart and muted, “Always allow npm test” with npm test in mono. Its tooltip says any command starting with npm test runs without asking and that chained commands still ask.',
    requires: '.agent-approval__always',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }],
    commands: {
      agents_overview: acmeWith({ status: status('waiting', 'Waiting for your OK') }),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ALWAYS_CHAT : messagesFor(args),
      agents_answer_approval: null,
    },
  },
  {
    id: 'agents-always-allowed',
    title: 'Agents — two cards answered by one Always allow',
    looksRightWhen:
      'Acme Site’s chat: two “Run a command” cards (npm test -- --run pricing, then npm test -- --run checkout), both resolved, each reading “Always allowed · npm test” with npm test in mono, where the buttons were.',
    requires: '.agent-approval__outcome',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }],
    commands: {
      agents_overview: acmeWith({ status: status('working', 'Running npm test') }),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ALWAYS_ALLOWED_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-permissions',
    title: 'Agents — what an agent may do without asking',
    looksRightWhen:
      'Editing Acme Site, under usage: a Permissions group listing “Commands starting with npm test”, “Commands starting with npm run lint”, “Web pages on vercel.com” and “Send an email · Gmail”, hairline-separated, each with a quiet Revoke on the right.',
    openSelector: AGENTS_TAB,
    requires: '.agent-permissions__rule',
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]:nth-child(6)' },
    ],
    commands: {
      agents_overview: acmeWith({
        permissions: [
          ['command_prefix', 'npm test'],
          ['command_prefix', 'npm run lint'],
          ['domain', 'vercel.com'],
          ['tool', 'mcp__gmail__send_email', 'Send an email · Gmail'],
        ].map(([kind, value, label], i) => ({
          id: `rule-${i}`,
          kind,
          value,
          label: label ?? value,
          createdAt: now - i * MIN,
        })),
      }),
      agents_messages: messagesFor,
      agents_instructions: 'Owns the Acme marketing site.',
      agents_usage: { week: totals(6, 120_000, 1.2, 9), allTime: totals(40, 900_000, 9.4, 70) },
      agents_revoke_permission: null,
    },
  },
  {
    id: 'agents-queued',
    title: 'Agents — a message queued while the agent works',
    looksRightWhen:
      'Acme Site is Working. Earlier: a reply cut off with “Stopped”, a quiet centred “Interrupted to read your new message”, then the message that interrupted it and the reply. Then the working dots with “Editing PricingTable.tsx”, and only under them your newest message, slightly dimmed, with “Queued, sends when Acme Site finishes · Interrupt and send now” under it. The composer holds a second message, and beside the mic a faint “↵ queues · ⌘↵ interrupts and sends now”.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat__queued',
    steps: [
      { click: '[data-agent-id="acme"]' },
      { fill: '.agent-composer__input', value: 'And the 404 page.' },
    ],
    commands: {
      agents_overview: acmeWith({ status: status('working', 'Editing PricingTable.tsx') }),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? QUEUED_CHAT : messagesFor(args),
      agents_interrupt: true,
    },
  },
  {
    id: 'agents-no-engine',
    title: 'Agents — Claude Code not installed',
    looksRightWhen:
      'The composer’s slot says agents need Claude Code and offers to set it up; the header band is undisturbed and there is no send button.',
    command: 'agents.open',
    requires: '.agent-composer--blocked',
    commands: {
      // A fresh Mac: the Chief has no history, so its row has no preview either.
      agents_overview: {
        ...overview([{ ...TEAM[0], preview: null }]),
        engineReady: false,
      },
    },
  },

  // ---------------------------------------------------- the mode toggle
  {
    id: 'mode-toggle-home',
    title: 'Mode toggle — on the dashboard, an agent waiting',
    looksRightWhen:
      'A text-only “Projects | Agents” segmented control directly above Search, 30px tall like it, with exactly Search’s left and right edges. Projects is selected. A small amber badge sits in the Agents segment’s top-right corner and both labels are centred in their halves. No Agents row under Search and no + beside the toggle.',
    requires: '.mode-toggle .mode-toggle__dot',
    commands: { agents_overview: overview() },
  },
  {
    id: 'mode-toggle-tooltip',
    title: 'Mode toggle — the Agents tooltip names who wants you',
    looksRightWhen: 'Hovering Agents shows “Lead Gen needs your OK · 1 unread (⌘⇧A)”.',
    requires: '.mode-toggle .mode-toggle__dot',
    steps: [{ hover: AGENTS_TAB }],
    commands: { agents_overview: overview() },
  },
  {
    id: 'mode-toggle-workspace',
    title: 'Mode toggle — inside a project',
    looksRightWhen:
      'The toggle sits above Search in the project sidebar, Projects selected, the amber badge on Agents. The titlebar has no Agents button. The hairline under Search continues the preview toolbar’s bottom hairline in one straight line.',
    project: WORKSPACE_PROJECT,
    requires: '.workspace-body .mode-toggle .mode-toggle__dot',
    storage: {
      elementTreeVisible: '0',
      [`shipstudio.layout.project:${WORKSPACE_PROJECT}`]: JSON.stringify({
        order: ['agent', 'preview'],
        floating: [],
        widths: {},
      }),
    },
    commands: {
      ...workspaceCommands,
      // A feature branch, so the "editing main" banner doesn't sit between
      // the header and the toolbar whose hairline the sidebar's must meet.
      get_current_branch: 'feat/pricing-page',
      get_hide_main_branch_warning: true,
      agents_overview: overview(),
    },
  },
  {
    id: 'mode-toggle-agents',
    title: 'Mode toggle — Agents mode, reached by the toggle',
    looksRightWhen:
      'Agents is selected and carries no badge (the list shows who wants you). Conversation search sits where Search was, at the same edges. The list ends in a “New agent” row like the project list’s “Open project”.',
    openSelector: AGENTS_TAB,
    requires: '.agents-list [data-agent-id="chief"]',
    commands: { agents_overview: overview(), agents_messages: messagesFor },
  },
  {
    id: 'mode-toggle-collapsed',
    title: 'Mode toggle — collapsed sidebar',
    looksRightWhen:
      'In the rail the toggle is two stacked icons (folder, agents) in one 30px-wide segmented column, Projects selected, the amber badge on the agents icon’s corner. Search sits under it as an icon.',
    requires: '.workspace-sidebar.is-hidden .mode-toggle--stacked .mode-toggle__dot',
    steps: [{ click: '.workspace-sidebar-toggle' }],
    commands: { agents_overview: overview() },
  },
  {
    id: 'mode-toggle-agents-collapsed',
    title: 'Mode toggle — collapsed sidebar in Agents mode',
    looksRightWhen:
      'The stacked icon toggle has Agents selected and no badge; the agent badges follow below.',
    openSelector: AGENTS_TAB,
    requires:
      '.workspace-sidebar.is-hidden .mode-toggle--stacked [data-tab-value="agents"].is-active',
    steps: [{ click: '.workspace-sidebar-toggle' }],
    commands: { agents_overview: overview(), agents_messages: messagesFor },
  },
  {
    id: 'mode-toggle-compact-home',
    title: 'Mode toggle — compact window, dashboard',
    looksRightWhen:
      'No sidebar below 750px, so the toggle is a folder | agents icon pair at the top-left, clear of the traffic lights, 24px tall like the compact top bar’s controls. Projects is selected; the amber badge straddles the agents segment’s corner.',
    viewport: { width: 700, height: 800 },
    requires: '.project-card',
    commands: { agents_overview: overview() },
  },
  {
    id: 'mode-toggle-compact-agents',
    title: 'Mode toggle — compact window, Agents',
    looksRightWhen:
      'The icon pair replaces the old Home button at the header’s leading edge, Agents selected, at the same x as on the dashboard. The title stays centred; Home is still in the agent switcher.',
    viewport: { width: 700, height: 800 },
    command: 'agents.open',
    requires: '.agent-chat',
    commands: { agents_overview: overview(), agents_messages: messagesFor },
  },
  {
    id: 'mode-toggle-compact-workspace',
    title: 'Mode toggle — compact window, project',
    looksRightWhen:
      'The compact top bar leads with the icon pair (Projects selected, badge on agents), then the dev-server dot, pin, ⌘K and the project picker on the right. Same height as those controls.',
    viewport: { width: 700, height: 800 },
    project: WORKSPACE_PROJECT,
    requires: '.compact-topbar',
    commands: { ...workspaceCommands, agents_overview: overview() },
  },
];
