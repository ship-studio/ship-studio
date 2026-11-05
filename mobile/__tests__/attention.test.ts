import type { Agent, AgentMessage, UsageTotals } from '@shipstudio/companion-protocol';
import type { NotificationRequest } from 'expo-notifications';
import {
  attentionCounts,
  describeScope,
  needsLine,
  nextNeedsYou,
  usageLine,
} from '../src/lib/agents';
import { diffLineKind, questionContext } from '../src/lib/diff';
import { EMPTY_DRAFT, FILE_KEEP_MS, expiredFiles, putDraft } from '../src/lib/drafts';
import { badgeCount, notificationId, targetOf } from '../src/lib/notify';
import { agent } from './helpers';

const named = (id: string, over: Partial<Agent> = {}) =>
  agent({ id, name: id, hidden: false, pinned: false, ...over });
const approval = (id: string, status: 'pending' | 'allowed', detail = 'pnpm run deploy --prod') =>
  ({
    id,
    agentId: 'a',
    ts: 1,
    kind: 'approval',
    text: '',
    approval: { requestId: `r-${id}`, title: 'Run a command', detail, status },
  }) as AgentMessage;

describe('notifications', () => {
  const request = (data: unknown, trigger: unknown = null) =>
    ({ identifier: 'n', content: { data }, trigger }) as unknown as NotificationRequest;

  it('reads what a local alert, an APNs push and an FCM push are about', () => {
    expect(targetOf(request({ agentId: 'a', messageId: 'm', kind: 'approval' }))).toEqual({
      agentId: 'a',
      messageId: 'm',
      kind: 'approval',
    });
    expect(
      targetOf(request({}, { payload: { body: { agentId: 'b', kind: 'needs_you' } } }))
    ).toEqual({ agentId: 'b', kind: 'needs_you' });
    expect(targetOf(request(undefined, { remoteMessage: { data: { agentId: 'c' } } }))).toEqual({
      agentId: 'c',
    });
    expect(targetOf(request({ agentId: '' }))).toBeNull();
    expect(targetOf(undefined)).toBeNull();
  });

  it('gives the same alert the same identifier, so it replaces instead of stacking', () => {
    const alert = {
      agentId: 'a',
      messageId: 'm1',
      title: 'A',
      body: 'b',
      kind: 'approval',
    } as const;
    expect(notificationId(alert)).toBe('approval:m1');
    expect(notificationId({ ...alert, messageId: undefined })).toBeUndefined();
  });

  it('counts the badge as the desk does: unread plus approvals, hidden agents left out', () => {
    expect(
      badgeCount([
        named('a', { unread: 2, pendingApprovals: 1 }),
        named('b', { unread: 3, hidden: true }),
        named('c', { unread: 1, muted: true }),
      ])
    ).toBe(4);
  });
});

describe('attention', () => {
  it('says what a waiting agent is asking, only when the saved chat knows', () => {
    const a = named('a', { pendingApprovals: 1 });
    expect(needsLine(a, [approval('m1', 'pending')])).toBe(
      'Needs your OK · pnpm run deploy --prod'
    );
    expect(needsLine(a, [approval('m1', 'allowed')])).toBe('Needs your OK');
    expect(needsLine(a, undefined)).toBe('Needs your OK');
  });

  it('counts who needs you and who is working, and finds the next card', () => {
    const agents = [
      named('idle'),
      named('busy', { status: { state: 'working', activity: null, since: 1 } }),
      named('old', { pendingApprovals: 1, lastActivityAt: 1 }),
      named('new', { pendingApprovals: 1, lastActivityAt: 9 }),
      named('gone', { pendingApprovals: 1, hidden: true, lastActivityAt: 99 }),
    ];
    expect(attentionCounts(agents)).toEqual({ needYou: 2, working: 1 });
    expect(nextNeedsYou(agents, { new: { messages: [approval('m9', 'pending')] } })).toEqual({
      agentId: 'new',
      messageId: 'm9',
    });
    expect(nextNeedsYou(agents.slice(0, 2), {})).toBeNull();
  });

  it('says where an always-allow can be revoked, except beside Revoke itself', () => {
    const scope = { kind: 'command_prefix', value: 'pnpm build', label: 'pnpm build' } as const;
    expect(describeScope(scope, 'Acme')).toMatch(/Revoke it any time from Acme’s sheet\.$/);
    expect(describeScope(scope, 'Acme', false)).not.toMatch(/Revoke/);
  });
});

describe('usage', () => {
  const totals = (over: Partial<UsageTotals>): UsageTotals => ({
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    pricedTurns: 0,
    durationMs: 0,
    ...over,
  });
  it('prices only the turns the Mac could price', () => {
    expect(usageLine(totals({}))).toBe('Nothing yet');
    expect(usageLine(totals({ turns: 3, inputTokens: 1500, costUsd: 0.4, pricedTurns: 3 }))).toBe(
      '3 turns · 2k tokens · $0.40'
    );
    expect(
      usageLine(totals({ turns: 4, inputTokens: 2_500_000, costUsd: 1, pricedTurns: 2 }))
    ).toBe('4 turns · 2.5M tokens · $1.00 for 2 of them');
    expect(usageLine(totals({ turns: 1, outputTokens: 10 }))).toBe('1 turn · 10 tokens');
  });
});

describe('diffs', () => {
  it('tints unified and Claude Code lines, not file headers', () => {
    expect(['@@ -1 +1 @@', '+a', '-b', ' c', '+++ b/x', '--- a/x'].map(diffLineKind)).toEqual([
      'hunk',
      'add',
      'del',
      'context',
      'context',
      'context',
    ]);
    expect(diffLineKind(' 13 -   return <header>')).toBe('del');
    expect(diffLineKind(' 14 +     <header className="sticky">')).toBe('add');
    expect(diffLineKind(' 12   export function Header() {')).toBe('context');
  });

  const question = {
    question: 'Do you want to make this edit to Header.tsx?',
    options: [{ key: '1', label: 'Yes', highlighted: true }],
  };

  it('finds the edit a session is asking about, out of its box', () => {
    const screen = [
      '> Make the header sticky.',
      '',
      '⏺ Update(src/components/Header.tsx)',
      '',
      '╭──────────────────────╮',
      '│ src/components/Header.tsx │',
      '│ 13 -   return <header> │',
      '│ 13 +   return <nav>    │',
      '╰──────────────────────╯',
      '',
      '  Do you want to make this edit to Header.tsx?',
      '  ❯ 1. Yes',
    ].join('\n');
    expect(questionContext(screen, question)).toEqual([
      'src/components/Header.tsx',
      '13 -   return <header>',
      '13 +   return <nav>',
    ]);
  });

  it('shows nothing when the question has scrolled off the screen', () => {
    expect(questionContext('⏺ Read(a)\n  ⎿ done', question)).toEqual([]);
  });
});

describe('draft files', () => {
  const file = (blobId: string, stagedAt: number) => ({
    blobId,
    uri: `file:///${blobId}`,
    name: `${blobId}.png`,
    mime: 'image/png',
    size: 1,
    stagedAt,
  });

  it('keeps a draft that is only a file, and drops it once the file is removed', () => {
    const d = putDraft({}, 'a', { files: [file('b1', 0)] });
    expect(d.a.files).toHaveLength(1);
    expect(putDraft(d, 'a', { files: [] })).toEqual({});
  });

  it('lets go of files the Mac no longer keeps', () => {
    const d = { ...EMPTY_DRAFT, files: [file('old', 0), file('new', FILE_KEEP_MS)] };
    expect(expiredFiles(d, FILE_KEEP_MS + 1).map((f) => f.blobId)).toEqual(['old']);
    // A draft saved before files were kept has none to lose.
    expect(expiredFiles({ text: 'x', quotes: [], mentions: [] })).toEqual([]);
  });
});
