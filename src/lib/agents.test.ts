import { describe, expect, it } from 'vitest';
import { agentInitials, distinctInitials } from '../components/agents/AgentAvatar';
import {
  buildChatItems,
  describeScope,
  errorRemedy,
  filterFiles,
  isCodePath,
  isQueued,
  lastUserMessage,
  failureLine,
  retryNote,
  whenAt,
  snippetAround,
  localPathFromHref,
  PROSE_PATH,
  describeCheckInTime,
  describeRepeat,
  formatWhen,
  splitScheduleInput,
  scheduleWhenPhrase,
  sortCheckIns,
  formatDivider,
  formatUsage,
  groupHits,
  highlightRuns,
  modelLabel,
  peerGroupLabel,
  sortAgents,
  splitQuotes,
  withQuotes,
  type Agent,
  type AgentMessage,
  type SearchHit,
  type SharedFile,
  type UsageTotals,
  mentionAt,
  mentionCandidates,
  mentionedAgents,
  mentionRuns,
  replyPreview,
  summarizeTeam,
  teamSubtitle,
} from './agents';

const msg = (id: string, kind: AgentMessage['kind'], ts: number, peer?: string): AgentMessage => ({
  id,
  agentId: 'chief',
  ts,
  kind,
  text: id,
  ...(peer ? { peer: { id: peer, name: peer.toUpperCase() } } : {}),
});

describe('buildChatItems', () => {
  it('collapses consecutive lines with the same agent into one group', () => {
    const items = buildChatItems([
      msg('a', 'agent', 1000),
      msg('b', 'sent_to_agent', 1001, 'acme'),
      msg('c', 'from_agent', 1002, 'acme'),
      msg('d', 'sent_to_agent', 1003, 'finance'),
      msg('e', 'agent', 1004),
    ]);
    const kinds = items.map((i) =>
      i.type === 'peer-group' ? `group:${i.messages.length}` : i.type
    );
    expect(kinds).toEqual(['day', 'message', 'group:2', 'group:1', 'message']);
  });

  it('does not merge groups across a regular message', () => {
    const items = buildChatItems([
      msg('a', 'sent_to_agent', 1000, 'acme'),
      msg('b', 'agent', 1001),
      msg('c', 'from_agent', 1002, 'acme'),
    ]);
    expect(items.filter((i) => i.type === 'peer-group')).toHaveLength(2);
  });

  it('prints a time divider for a new sitting, not a pause', () => {
    const hour = 60 * 60 * 1000;
    const morning = new Date(2026, 10, 3, 8).getTime();
    const days = (messages: AgentMessage[]) =>
      buildChatItems(messages).filter((i) => i.type === 'day').length;
    // An hour's pause: still one sitting.
    expect(days([msg('a', 'user', morning), msg('b', 'agent', morning + hour)])).toBe(1);
    // Four hours of quiet: a new one.
    expect(days([msg('a', 'user', morning), msg('b', 'agent', morning + 4 * hour)])).toBe(2);
    // Across midnight, however short the gap.
    const lateNight = new Date(2026, 10, 3, 23, 50).getTime();
    expect(days([msg('a', 'user', lateNight), msg('b', 'agent', lateNight + hour / 3)])).toBe(2);
  });
});

describe('peerGroupLabel', () => {
  it('says what happened', () => {
    expect(peerGroupLabel([msg('a', 'sent_to_agent', 0, 'x')])).toBe('Messaged');
    expect(peerGroupLabel([msg('a', 'from_agent', 0, 'x')])).toBe('Message from');
    expect(
      peerGroupLabel([msg('a', 'from_agent', 0, 'x'), msg('b', 'sent_to_agent', 1, 'x')])
    ).toBe('2 messages with');
  });
});

describe('formatDivider', () => {
  it('names today and yesterday', () => {
    const now = new Date(2026, 10, 3, 15, 0).getTime();
    expect(formatDivider(new Date(2026, 10, 3, 9, 5).getTime(), now)).toMatch(/^Today /);
    expect(formatDivider(new Date(2026, 10, 2, 9, 5).getTime(), now)).toMatch(/^Yesterday /);
    expect(formatDivider(new Date(2026, 9, 20, 9, 5).getTime(), now)).not.toMatch(
      /^(Today|Yesterday)/
    );
  });
});

describe('sortAgents', () => {
  const a = (id: string, lastActivityAt: number, pinned = false) =>
    ({ id, lastActivityAt, pinned }) as Agent;
  it('puts pinned first, then most recent', () => {
    const sorted = sortAgents([a('old', 1), a('pinned-old', 0, true), a('new', 5)]);
    expect(sorted.map((x) => x.id)).toEqual(['pinned-old', 'new', 'old']);
  });
});

describe('quotes', () => {
  it('sends each quote as a blockquote ahead of the typed text', () => {
    expect(withQuotes(['one', 'two\nlines'], 'Why?')).toBe('> one\n\n> two\n> lines\n\nWhy?');
    expect(withQuotes(['only'], '')).toBe('> only');
  });

  it('reads blockquotes back out of a user message', () => {
    expect(splitQuotes('> one\n\n> two\n> lines\n\nWhy?')).toEqual([
      { kind: 'quote', text: 'one' },
      { kind: 'quote', text: 'two\nlines' },
      { kind: 'text', text: 'Why?' },
    ]);
    expect(splitQuotes('> a\n>\n> b')).toEqual([{ kind: 'quote', text: 'a\n\nb' }]);
    expect(splitQuotes('no quotes > here')).toEqual([{ kind: 'text', text: 'no quotes > here' }]);
  });
});

describe('schedule helpers', () => {
  // Times are written in the user's locale, like everything else on screen.
  const at = (hour: number, minute: number) =>
    new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });

  it("describes routines in the backend's words, with locale times", () => {
    expect(describeRepeat({ kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })).toBe(
      `Every weekday at ${at(9, 0)}`
    );
    expect(describeRepeat({ kind: 'days', days: [0, 1, 2, 3, 4, 5, 6], hour: 7, minute: 45 })).toBe(
      `Every day at ${at(7, 45)}`
    );
    expect(describeRepeat({ kind: 'days', days: [1, 4], hour: 8, minute: 30 })).toBe(
      `Every Monday and Thursday at ${at(8, 30)}`
    );
    expect(describeRepeat({ kind: 'days', days: [1, 3, 5], hour: 8, minute: 30 })).toBe(
      `Every Monday, Wednesday and Friday at ${at(8, 30)}`
    );
    expect(describeRepeat({ kind: 'every', minutes: 120 })).toBe('Every 2 hours');
    expect(describeRepeat({ kind: 'every', minutes: 60 })).toBe('Every hour');
    expect(describeRepeat({ kind: 'every', minutes: 90 })).toBe('Every 90 minutes');
  });

  it('splits "when: what" at the first colon that is followed by a space', () => {
    expect(splitScheduleInput('every weekday 9am: brief me on Acme')).toEqual({
      when: 'every weekday 9am',
      note: 'brief me on Acme',
    });
    expect(splitScheduleInput('tomorrow 9:30: check: the invoices')).toEqual({
      when: 'tomorrow 9:30',
      note: 'check: the invoices',
    });
    expect(splitScheduleInput('every weekday 9:30')).toEqual({
      when: 'every weekday 9:30',
      note: '',
    });
    expect(splitScheduleInput('tomorrow 9am:')).toEqual({ when: 'tomorrow 9am', note: '' });
  });

  it('words a row: next time, how it repeats, paused', () => {
    const now = new Date(2026, 10, 4, 15, 0).getTime();
    const nextAt = new Date(2026, 10, 5, 9, 0).getTime();
    const repeat = { kind: 'days' as const, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 };
    const base = { id: 'x', note: 'n', nextAt, createdAt: 0, paused: false };
    expect(describeCheckInTime(base, now)).toBe(`Tomorrow ${at(9, 0)}`);
    expect(describeCheckInTime({ ...base, repeat }, now)).toBe(
      `Every weekday at ${at(9, 0)} · next tomorrow ${at(9, 0)}`
    );
    expect(describeCheckInTime({ ...base, repeat, paused: true }, now)).toBe(
      `Paused · Every weekday at ${at(9, 0)}`
    );
  });

  it('names today and tomorrow, and dates further out', () => {
    const now = new Date(2026, 10, 4, 15, 0).getTime();
    expect(formatWhen(new Date(2026, 10, 4, 18, 0).getTime(), now)).toMatch(/^Today /);
    expect(formatWhen(new Date(2026, 10, 5, 9, 0).getTime(), now)).toMatch(/^Tomorrow /);
    expect(formatWhen(new Date(2026, 10, 9, 9, 0).getTime(), now)).not.toMatch(/Today|Tomorrow/);
  });

  it('lists the soonest first and paused ones last', () => {
    const c = (id: string, nextAt: number, paused = false) => ({
      id,
      note: id,
      nextAt,
      createdAt: 0,
      paused,
    });
    expect(
      sortCheckIns([c('late', 3), c('paused', 1, true), c('soon', 2)]).map((x) => x.id)
    ).toEqual(['soon', 'late', 'paused']);
  });
});

describe('search results', () => {
  const hit = (agentId: string, messageId: string): SearchHit => ({
    agentId,
    agentName: agentId,
    agentColor: 'blue',
    messageId,
    ts: 0,
    kind: 'agent',
    snippet: '',
  });

  it('groups by agent in the order of each agent’s newest hit', () => {
    const groups = groupHits([hit('b', '1'), hit('a', '2'), hit('b', '3')]);
    expect(groups.map((g) => [g.agentId, g.hits.map((h) => h.messageId)])).toEqual([
      ['b', ['1', '3']],
      ['a', ['2']],
    ]);
  });

  it('highlights every word, case-insensitively, without regex surprises', () => {
    const runs = highlightRuns('Invoice for Northwind (Q3)', 'northwind invoice (q3');
    expect(runs.filter((r) => r.match).map((r) => r.text)).toEqual(['Invoice', 'Northwind', '(Q3']);
    expect(runs.map((r) => r.text).join('')).toBe('Invoice for Northwind (Q3)');
    expect(highlightRuns('plain', ' ')).toEqual([{ text: 'plain', match: false }]);
  });
});

describe('formatUsage', () => {
  const totals = (over: Partial<UsageTotals>): UsageTotals => ({
    turns: 2,
    inputTokens: 10,
    outputTokens: 500,
    cacheReadTokens: 30_000,
    cacheWriteTokens: 9_490,
    costUsd: 0.4231,
    pricedTurns: 2,
    durationMs: 185_000,
    ...over,
  });

  it('prints only what was reported', () => {
    expect(formatUsage(totals({}))).toBe('$0.42 · 40k tokens · 2 turns · 3 min');
    expect(formatUsage(totals({ turns: 0 }))).toBeNull();
  });

  it('drops the cost when any turn reported none, rather than under-reporting it', () => {
    expect(formatUsage(totals({ pricedTurns: 1, durationMs: 0 }))).toBe('40k tokens · 2 turns');
  });

  it('labels models by alias and passes unknown ids through', () => {
    expect(modelLabel(null)).toBe('Default');
    expect(modelLabel('opus')).toBe('Opus');
    expect(modelLabel('claude-x')).toBe('claude-x');
  });
});

describe('distinctInitials', () => {
  it('lets the earlier agent keep its initials', () => {
    const names = ['Chief of Staff', 'Finance', 'Client Sites QA'];
    expect(distinctInitials('Chief of Staff', names)).toBe('CS');
    expect(distinctInitials('Client Sites QA', names)).toBe('CL');
    expect(distinctInitials('Finance', names)).toBe('FI');
    expect(distinctInitials('Cool Stuff', names)).toBe('CL');
  });
});

describe('agentInitials', () => {
  it('takes two words, skipping filler', () => {
    expect(agentInitials('Chief of Staff')).toBe('CS');
    expect(agentInitials('Finance')).toBe('FI');
  });

  it('keeps numbers apart', () => {
    expect(agentInitials('Agent 3')).toBe('A3');
    expect(agentInitials('Agent 10')).toBe('10');
    expect(agentInitials('Agent 19')).toBe('19');
  });
});

describe('errorRemedy', () => {
  const line = (text: string) => ({ text });
  it('offers sign-in for expired logins only', () => {
    expect(
      errorRemedy(line("Claude Code isn't signed in anymore (its session expired). Open an agent"))
    ).toBe('sign-in');
    expect(errorRemedy(line('Invalid API key · Please run /login'))).toBe('sign-in');
    expect(errorRemedy(line('You should sign in again to Stripe'))).toBeNull();
    expect(errorRemedy(line('Stopped.'))).toBeNull();
  });
  it('trusts the backend’s tag over the words', () => {
    expect(
      errorRemedy({ text: 'Claude Code is signed out.', failure: { kind: 'signed_out' } })
    ).toBe('sign-in');
    expect(errorRemedy({ text: 'please run /login', failure: { kind: 'other' } })).toBeNull();
  });
});

describe('lastUserMessage', () => {
  const m = (kind: string, text: string, extra = {}) => ({
    id: text,
    agentId: 'a',
    ts: 0,
    kind,
    text,
    ...extra,
  });
  it('finds the last thing you sent before a line, files and all', () => {
    const files = [{ name: 'a.png', path: 'attachments/x/a.png', mime: 'image/png', size: 1 }];
    const list = [m('user', 'first'), m('agent', 'ok'), m('user', '', { attachments: files })];
    expect(lastUserMessage([...list, m('error', 'x')] as never, 3)?.attachments).toBe(files);
    expect(lastUserMessage(list as never, 0)).toBeNull();
    expect(lastUserMessage([m('user', ' '), m('error', 'x')] as never, 1)).toBeNull();
  });
});

describe('failure lines', () => {
  it('says what kind of failure, in the row’s few words', () => {
    expect(failureLine({ kind: 'signed_out' }, 'x')).toBe('Claude Code is signed out');
    expect(failureLine({ kind: 'usage_limit' }, 'x')).toBe('Usage limit reached');
    expect(failureLine({ kind: 'other' }, "Couldn't start Claude Code: no such file. More")).toBe(
      "Didn’t finish: Couldn't start Claude Code"
    );
  });
  it('a retry note keeps the ask and fits a check-in', () => {
    expect(retryNote('Send the invoices')).toContain('“Send the invoices”');
    expect(retryNote('x'.repeat(2000)).length).toBeLessThanOrEqual(600);
  });
  it('schedules a retry in whole minutes, never in the past', () => {
    expect(whenAt(10 * 60_000 + 1, 0)).toBe('in 11 minutes');
    expect(whenAt(0, 5)).toBe('in 1 minutes');
  });
});

describe('snippetAround', () => {
  it('starts a few words before the match', () => {
    const s = '… table fixed on mobile and the two dead footer links that pointed nowhere';
    const cut = snippetAround(s, 'footer');
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.indexOf('footer')).toBeLessThan(20);
  });
  it('leaves a snippet whose match is already near the start', () => {
    expect(snippetAround('The footer links', 'footer')).toBe('The footer links');
  });
});

describe('@mentions', () => {
  const named = (id: string, name: string) => ({ id, name }) as Agent;
  const team = [
    named('chief', 'Chief of Staff'),
    named('acme', 'Acme Site'),
    named('fin', 'Finance'),
  ];

  it('finds the mention being typed at the caret', () => {
    expect(mentionAt('ask @fin', 8)).toEqual({ start: 4, query: 'fin' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('ask @Acme Si', 12)).toEqual({ start: 4, query: 'Acme Si' });
    expect(mentionAt('mail me@example.com', 19)).toBeNull();
    expect(mentionAt('@fin\nmore', 9)).toBeNull();
    expect(mentionAt('@ fin', 5)).toBeNull();
  });

  it('matches names from the start, then any word', () => {
    expect(mentionCandidates(team, 'fi').map((a) => a.id)).toEqual(['fin']);
    expect(mentionCandidates(team, 's').map((a) => a.id)).toEqual(['chief', 'acme']);
    expect(mentionCandidates(team, 'acme s').map((a) => a.id)).toEqual(['acme']);
    expect(mentionCandidates(team, '').length).toBe(3);
  });

  it('reads which agents a message mentions, whole names only', () => {
    const found = mentionedAgents('@Finance and @acme site, not @Fin or a@Finance', team);
    expect(found.map((a) => a.id)).toEqual(['fin', 'acme']);
    expect(mentionedAgents('@Financed', team)).toEqual([]);
  });

  it('splits a bubble around its recorded mentions', () => {
    const runs = mentionRuns('Ask @Finance, then me', [{ id: 'fin', name: 'Finance' }]);
    expect(runs).toEqual([
      { text: 'Ask ' },
      { text: '@Finance', mention: { id: 'fin', name: 'Finance' } },
      { text: ', then me' },
    ]);
    expect(mentionRuns('plain')).toEqual([{ text: 'plain' }]);
  });
});

describe('Team overview', () => {
  const base = {
    hidden: false,
    pinned: false,
    pendingApprovals: 0,
    lastActivityAt: 0,
    status: { state: 'idle', activity: null, since: null },
  };
  const make = (id: string, over: Partial<Agent> = {}) =>
    ({ ...base, id, name: id, ...over }) as Agent;
  const line = (id: string, agentId: string, kind: AgentMessage['kind'], ts: number, text = 'x') =>
    ({ id, agentId, kind, ts, text }) as AgentMessage;

  it('reads a reply as one plain line', () => {
    expect(replyPreview('\n## **Done**: see [PR 12](https://x)\nmore')).toBe('Done: see PR 12');
    expect(replyPreview('| a | b |\n1. `npm` ran')).toBe('npm ran');
  });

  it('sorts the team into working, needs-you, next and recent', () => {
    const agents = [
      make('a', { status: { state: 'working', activity: 'Editing x', since: 1 } }),
      make('b', { pendingApprovals: 1 }),
      make('c', {
        checkIns: [
          { id: 'late', note: 'n', nextAt: 30, createdAt: 0, paused: false },
          { id: 'soon', note: 'n', nextAt: 10, createdAt: 0, paused: false },
          { id: 'off', note: 'n', nextAt: 5, createdAt: 0, paused: true },
        ],
      }),
      make('h', { hidden: true, status: { state: 'working', activity: null, since: 1 } }),
    ];
    const card = {
      ...line('card', 'b', 'approval', 5),
      approval: { requestId: 'r', title: 't', detail: '', status: 'pending' as const },
    };
    const summary = summarizeTeam(agents, {
      a: [line('a1', 'a', 'agent', 3), line('a2', 'a', 'user', 9)],
      b: [card, line('b1', 'b', 'agent', 7)],
      h: [line('h1', 'h', 'agent', 99)],
    });
    expect(summary.working.map((a) => a.id)).toEqual(['a']);
    expect(summary.needsYou.map((n) => [n.agent.id, n.approvals.map((m) => m.id)])).toEqual([
      ['b', ['card']],
    ]);
    expect(summary.scheduled.map((s) => s.checkIn.id)).toEqual(['soon', 'late']);
    expect(summary.replies.map((r) => r.message.id)).toEqual(['b1', 'a1']);
    expect(teamSubtitle(agents)).toBe('1 working · 1 needs you');
    expect(teamSubtitle([make('q')])).toBe('Nothing in flight');
  });

  it('lists a failed turn under Needs you, with its line, and counts it', () => {
    const failed = make('f', { failure: { kind: 'other' } });
    const limited = make('l', { failure: { kind: 'usage_limit' } });
    const retrying = make('r', {
      failure: { kind: 'other' },
      status: { state: 'working', activity: null, since: 1 },
    });
    const summary = summarizeTeam([failed, limited, retrying], {
      f: [line('f1', 'f', 'user', 1), line('f2', 'f', 'error', 2)],
    });
    expect(summary.needsYou.map((n) => [n.agent.id, n.failure?.id ?? null])).toEqual([
      ['f', 'f2'],
      ['l', null],
    ]);
    expect(teamSubtitle([failed, limited, retrying])).toBe('1 working · 1 failed');
  });
});

describe('local paths in agent prose', () => {
  it('reads local hrefs and leaves web links alone', () => {
    expect(localPathFromHref('~/ShipStudio/acme/report.md')).toBe('~/ShipStudio/acme/report.md');
    expect(localPathFromHref('/Users/me/Q3%20report.pdf')).toBe('/Users/me/Q3 report.pdf');
    expect(localPathFromHref('file:///Users/me/a.csv')).toBe('/Users/me/a.csv');
    expect(localPathFromHref('report.md')).toBe('report.md');
    expect(localPathFromHref('https://example.com/a')).toBeNull();
    expect(localPathFromHref('mailto:a@b.c')).toBeNull();
    expect(localPathFromHref('javascript:alert(1)')).toBeNull();
    expect(localPathFromHref('#top')).toBeNull();
    expect(localPathFromHref('//evil.example/x')).toBeNull();
  });

  it('finds written-out paths but not routes or "and/or"', () => {
    const found = (text: string) => PROSE_PATH.exec(text)?.[0] ?? null;
    expect(found('Saved to ~/ShipStudio/acme/report.md.')).toBe('~/ShipStudio/acme/report.md');
    expect(found('see /Users/me/Desktop/notes.txt, then')).toBe('/Users/me/Desktop/notes.txt');
    expect(found('the /careers page')).toBeNull();
    expect(found('this and/or that')).toBeNull();
    expect(isCodePath('~/ShipStudio/acme/Q3 report.md')).toBe(true);
    expect(isCodePath('/careers')).toBe(false);
    expect(isCodePath('npm run build')).toBe(false);
  });

  it('filters the Files list by who shared it', () => {
    const file = (from: SharedFile['from']): SharedFile => ({
      messageId: from,
      ts: 1,
      from,
      name: 'a.pdf',
      path: 'attachments/x/a.pdf',
      mime: 'application/pdf',
      size: 1,
    });
    const files = [file('user'), file('agent')];
    expect(filterFiles(files, 'all')).toHaveLength(2);
    expect(filterFiles(files, 'agent').map((f) => f.from)).toEqual(['agent']);
    expect(filterFiles(files, 'user').map((f) => f.from)).toEqual(['user']);
  });
});

describe('isQueued', () => {
  const working = { status: { state: 'working', activity: null, since: 1000 } } as Agent;
  const user = (ts: number) => msg('u', 'user', ts);
  it('is a message you sent after the turn in progress began', () => {
    expect(isQueued(user(1500), working)).toBe(true);
    expect(isQueued(user(500), working)).toBe(false);
    expect(isQueued(msg('a', 'agent', 1500), working)).toBe(false);
  });
  it('is nothing once the agent is idle', () => {
    const idle = { status: { state: 'idle', activity: null, since: null } } as Agent;
    expect(isQueued(user(1500), idle)).toBe(false);
  });
});

describe('describeScope', () => {
  it('says exactly what stops asking, and that chains still ask', () => {
    const text = describeScope(
      { kind: 'command_prefix', value: 'npm test', label: 'npm test' },
      'Acme Site'
    );
    expect(text).toContain('Any command starting with “npm test” runs for Acme Site');
    expect(text).toContain('still ask');
    expect(describeScope({ kind: 'domain', value: 'a.com', label: 'a.com' }, 'X')).not.toContain(
      'still ask'
    );
  });
});

describe('scheduleWhenPhrase', () => {
  it('writes a schedule back in words the grammar reads as the same schedule', () => {
    const at = (repeat: Parameters<typeof scheduleWhenPhrase>[0]['repeat']) =>
      scheduleWhenPhrase({ repeat, nextAt: 0 });
    expect(at({ kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })).toBe(
      'every weekday at 09:00'
    );
    expect(at({ kind: 'days', days: [6, 0], hour: 10, minute: 5 })).toBe(
      'every weekend day at 10:05'
    );
    expect(at({ kind: 'days', days: [5, 1, 4], hour: 17, minute: 30 })).toBe(
      'every monday, thursday and friday at 17:30'
    );
    expect(at({ kind: 'every', minutes: 120 })).toBe('every 2 hours');
    expect(at({ kind: 'every', minutes: 45 })).toBe('every 45 minutes');
    const once = new Date(2026, 10, 20, 9, 5).getTime();
    expect(scheduleWhenPhrase({ nextAt: once })).toBe('2026-11-20 09:05');
  });
});
