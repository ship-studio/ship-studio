/**
 * Agents bound to a project, the Chief's audit trail, and live state on
 * delegation lines. Built on the Agents team fixture (`./agents`).
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT } from './base';
import { AGENTS_TAB, MIN, TEAM, msg, messagesFor, now, overview, status } from './agents';

const ACME_PATH = `${HARNESS_ROOT}/acme-marketing`;

/** Acme Site works in acme-marketing; everyone else as in the team fixture. */
const boundTeam = (over: Record<string, Record<string, unknown>> = {}) =>
  TEAM.map((a) => ({
    ...a,
    ...(a.id === 'acme' ? { project: ACME_PATH, status: status('idle') } : {}),
    ...over[a.id],
  }));

const changes = (minutesAgo: number, files: Record<string, unknown>[], extra = {}) =>
  msg('changes', `Changed ${files.length} files in acme-marketing`, minutesAgo, {
    agentId: 'acme',
    changes: {
      project: ACME_PATH,
      branch: 'feat/pricing-page',
      from: 'a1b2c3',
      to: 'd4e5f6',
      files,
      fileCount: files.length,
      added: files.reduce((n, f) => n + Number(f.added ?? 0), 0),
      removed: files.reduce((n, f) => n + Number(f.removed ?? 0), 0),
      ...extra,
    },
  });

const ACME_BOUND_CHAT = [
  msg('note', 'Created by Chief of Staff', 300, {
    agentId: 'acme',
    peer: { id: 'chief', name: 'Chief of Staff' },
  }),
  msg('note', 'Instructions updated by Chief of Staff', 120, {
    agentId: 'acme',
    peer: { id: 'chief', name: 'Chief of Staff' },
  }),
  msg('user', 'The pricing cards overlap on mobile. Can you fix it?', 30, { agentId: 'acme' }),
  msg(
    'agent',
    'Fixed. The cards now stack below 640px and the “Most popular” badge no longer covers the price. I also removed the old pricing grid helper nothing used.',
    24,
    { agentId: 'acme' }
  ),
  changes(24, [
    { path: 'src/components/PricingTable.tsx', status: 'modified', added: 38, removed: 12 },
    { path: 'src/styles/pricing.css', status: 'modified', added: 21, removed: 4 },
    { path: 'src/components/PricingCard.tsx', status: 'added', added: 64 },
    { path: 'src/lib/pricingGrid.ts', status: 'deleted', added: 0, removed: 41 },
    { path: 'public/badges/popular.svg', status: 'modified' },
  ]),
  msg('user', 'And the footer year is still 2024.', 6, { agentId: 'acme' }),
  msg('agent', 'Updated to 2026.', 5, { agentId: 'acme' }),
  changes(5, [{ path: 'src/components/Footer.tsx', status: 'modified', added: 1, removed: 1 }]),
];

const CHANGE_DIFF = {
  filePath: 'src/components/Footer.tsx',
  isNewFile: false,
  isDeleted: false,
  isBinary: false,
  additions: 1,
  deletions: 1,
  content: [
    'diff --git a/src/components/Footer.tsx b/src/components/Footer.tsx',
    'index 3f2a1c4..9b8d7e2 100644',
    '--- a/src/components/Footer.tsx',
    '+++ b/src/components/Footer.tsx',
    '@@ -12,7 +12,7 @@ export function Footer() {',
    '       <nav className="footer__links">{links}</nav>',
    '       <p className="footer__legal">',
    '-        © 2024 Acme Inc. All rights reserved.',
    '+        © 2026 Acme Inc. All rights reserved.',
    '       </p>',
    '     </footer>',
    '   );',
  ].join('\n'),
};

const peer = (id: string, name: string) => ({ peer: { id, name } });

/** The Chief's chat after building a team and handing out work. */
const CHIEF_AUDIT_CHAT = [
  msg('user', 'Set up an agent for the books, and one for the Acme site.', 200),
  msg(
    'note',
    'Created Finance · Invoices, expenses and the books.',
    199,
    peer('finance', 'Finance')
  ),
  msg(
    'note',
    'Created Acme Site · Owns the Acme marketing site · works in acme-marketing',
    199,
    peer('acme', 'Acme Site')
  ),
  msg('agent', 'Done. Finance and Acme Site are set up and briefed.', 198),
  msg(
    'user',
    'Social Posts isn’t pulling its weight. Remove it, and chase the overdue invoices.',
    30
  ),
  msg('note', 'Deleted Social Posts', 29),
  msg(
    'sent_to_agent',
    'Northwind ($4,200) and Globex ($1,150) are overdue. Draft a firmer reminder for each and send them once the user approves.',
    28,
    peer('finance', 'Finance')
  ),
  msg('note', 'Updated Acme Site’s instructions', 20, peer('acme', 'Acme Site')),
  msg(
    'sent_to_agent',
    'Check every footer link on staging and fix what’s broken.',
    19,
    peer('acme', 'Acme Site')
  ),
  msg(
    'sent_to_agent',
    'Find five agencies in Lisbon worth an intro.',
    15,
    peer('leadgen', 'Lead Gen')
  ),
  msg(
    'agent',
    'Finance is drafting the reminders, Acme Site is on the footer links, and Lead Gen is looking for Lisbon agencies.',
    14
  ),
];

/** Finance, working on the brief the Chief just sent. */
const FINANCE_DRIVEN_CHAT = [
  msg('note', 'Created by Chief of Staff', 199, {
    agentId: 'finance',
    peer: { id: 'chief', name: 'Chief of Staff' },
  }),
  msg('user', 'What’s outstanding this month?', 60, { agentId: 'finance' }),
  msg('agent', 'Two invoices are overdue: Northwind ($4,200) and Globex ($1,150).', 59, {
    agentId: 'finance',
  }),
  msg(
    'from_agent',
    'Northwind ($4,200) and Globex ($1,150) are overdue. Draft a firmer reminder for each and send them once the user approves.',
    1,
    { agentId: 'finance', ...peer('chief', 'Chief of Staff') }
  ),
];

const LEADGEN_FAILED_CHAT = [
  msg('from_agent', 'Find five agencies in Lisbon worth an intro.', 15, {
    agentId: 'leadgen',
    ...peer('chief', 'Chief of Staff'),
  }),
  msg(
    'error',
    'Claude Code’s usage limit is reached, so AI generation isn’t available right now. It resets at 3:00 PM.',
    14,
    { agentId: 'leadgen' }
  ),
];

const auditTeam = () =>
  overview(
    boundTeam({
      finance: { status: status('waiting', 'Waiting for your OK'), pendingApprovals: 1 },
      acme: { status: status('working', 'Reading src/components/Footer.tsx') },
      leadgen: { status: status('idle'), lastActivityAt: now - 14 * MIN },
    }).filter((a) => a.id !== 'social')
  );

const openAcme = {
  openSelector: AGENTS_TAB,
  steps: [{ click: '[data-agent-id="acme"]' }],
};

export const agentsProjectScenarios: Scenario[] = [
  {
    id: 'agents-project-bound',
    title: 'Agents — an agent that works in a project, with change cards',
    looksRightWhen:
      'Acme Site’s header has a quiet folder chip “acme-marketing” beside the name. Its chat opens with quiet centred notes “Created by Chief of Staff” and “Instructions updated by Chief of Staff” (the name a link). After each reply sits a compact card on the left: “Changed 5 files in acme-marketing +124 −58” with the branch “feat/pricing-page” on the right, then “View diff” and “Open preview”. No deploy or hosting status anywhere.',
    requires: '.agent-changes',
    ...openAcme,
    commands: {
      agents_overview: overview(boundTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_BOUND_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-project-files',
    title: 'Agents — a change card’s files listed',
    looksRightWhen:
      'The five-file card is expanded: one row per file, path in mono (start truncated if long) with green +n and red −n on the right; the deleted file is struck through; the SVG reads “binary”. The toggle reads “Hide files”, after “View diff”.',
    requires: '.agent-changes__files',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }, { click: '.agent-changes__toggle-files' }],
    commands: {
      agents_overview: overview(boundTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_BOUND_CHAT.slice(0, 5) : messagesFor(args),
    },
  },
  {
    id: 'agents-project-diff',
    title: 'Agents — View diff on a one-file change',
    looksRightWhen:
      'The app’s own diff modal, titled src/components/ Footer.tsx · Modified, focus on the diff (not Close): +1 −1, then the hunk “export function Footer() {” and old/new line numbers 12–18, one − before 2024 in red and one + before 2026 in green. No diff --git / index / --- / +++ lines.',
    requires: '.diff-modal-content .diff-line-add',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-changes .agent-changes__actions button' },
    ],
    commands: {
      agents_overview: overview(boundTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme'
          ? ACME_BOUND_CHAT.filter((m) => !m.text.startsWith('Changed 5'))
          : messagesFor(args),
      agents_change_diff: CHANGE_DIFF,
    },
  },
  {
    id: 'agents-project-diff-files',
    title: 'Agents — View diff on a five-file change, stepped to the second file',
    looksRightWhen:
      'The diff modal for the five-file card, moved on once with Next: the title reads src/styles/ pricing.css · Modified, the bar under it reads +1 −1 on the left and “2 of 5” with Previous and Next arrows on the right, both enabled.',
    requires: '.diff-nav',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-changes .agent-changes__actions button' },
      { click: '.diff-nav [aria-label="Next file"]' },
    ],
    commands: {
      agents_overview: overview(boundTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_BOUND_CHAT.slice(0, 5) : messagesFor(args),
      agents_change_diff: (args: Record<string, unknown>) => ({
        ...CHANGE_DIFF,
        filePath: String(args.path),
      }),
    },
  },
  {
    id: 'agents-project-editor',
    title: 'Agents — choosing the project an agent works in',
    looksRightWhen:
      'Editing Acme Site: under Model, “Works in” with a menu button reading acme-marketing; the menu is open listing No project, a divider, then acme-marketing (checked), portfolio-site and docs-astro. The hint under it says the project’s CLAUDE.md and settings apply.',
    requires: '.agent-project-menu',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]:nth-child(6)' },
      { click: '.agent-editor__project' },
    ],
    commands: {
      agents_overview: overview(boundTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_BOUND_CHAT : messagesFor(args),
      agents_instructions: 'Owns the Acme marketing site.',
      agents_usage: null,
    },
  },
  {
    id: 'agents-chief-audit',
    title: 'Agents — what the Chief did, and how its delegations are going',
    looksRightWhen:
      'The Chief’s chat: quiet centred notes “Created Finance · …”, “Created Acme Site · … · works in acme-marketing”, “Deleted Social Posts” (no link) and “Updated Acme Site’s instructions”, each agent name a link. The newest line with each agent carries its live state after a dot: Finance amber “needs your OK”, Acme Site the pixel loader and “reading src/components/Footer.tsx”, Lead Gen red “didn’t finish”. Older lines with the same agent carry none.',
    command: 'agents.open',
    requires: '.agent-peer__state[data-state="failed"]',
    commands: {
      agents_overview: auditTeam(),
      agents_messages: (args: Record<string, unknown>) => {
        if (args.agentId === 'chief') return CHIEF_AUDIT_CHAT;
        if (args.agentId === 'leadgen') return LEADGEN_FAILED_CHAT;
        return messagesFor(args);
      },
    },
  },
  {
    id: 'agents-brief-in-progress',
    title: 'Agents — the brief an agent is working on, open',
    looksRightWhen:
      'Finance is Working. Its chat ends with “Message from Chief of Staff” (no live state: that is work coming in) already expanded, showing the brief about Northwind and Globex, then the working dots. The first line is a quiet “Created by Chief of Staff” with the name as a link.',
    requires: '.agent-peer__thread',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(
        boundTeam({
          finance: {
            status: {
              state: 'working',
              activity: 'Drafting the reminders',
              since: now - 0.5 * MIN,
            },
          },
        })
      ),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance' ? FINANCE_DRIVEN_CHAT : messagesFor(args),
    },
  },
];
