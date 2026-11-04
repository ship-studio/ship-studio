import { describe, expect, it } from 'vitest';
import {
  buildChatItems,
  drivingBriefId,
  folderName,
  lastOutcome,
  newestPeerGroups,
  peerState,
  type Agent,
  type AgentMessage,
  type AgentStatus,
} from './agents';

const msg = (id: string, kind: AgentMessage['kind'], ts: number, peer?: string): AgentMessage => ({
  id,
  agentId: 'fin',
  ts,
  kind,
  text: id,
  ...(peer ? { peer: { id: peer, name: peer } } : {}),
});

const agent = (status: Partial<AgentStatus>, pendingApprovals = 0) =>
  ({
    id: 'fin',
    name: 'Finance',
    pendingApprovals,
    status: { state: 'idle', activity: null, since: null, ...status },
  }) as Agent;

describe('peerState', () => {
  it('says what a working agent is doing', () => {
    expect(peerState(agent({ state: 'working', activity: 'Reading Gmail' }))).toEqual({
      kind: 'working',
      label: 'reading Gmail',
    });
    expect(peerState(agent({ state: 'working' })).label).toBe('working');
  });

  it('puts a waiting card first, even when its turn has ended', () => {
    expect(peerState(agent({ state: 'waiting' })).kind).toBe('waiting');
    expect(peerState(agent({}, 1)).label).toBe('needs your OK');
  });

  it('only says failed when its newest line is known to be an error', () => {
    const idle = agent({});
    expect(peerState(idle, msg('e', 'error', 1)).kind).toBe('failed');
    expect(peerState(idle, msg('a', 'agent', 1)).kind).toBe('idle');
    expect(peerState(idle, null).kind).toBe('idle');
  });

  it('reads past notes and change cards to the line that says how the turn went', () => {
    expect(
      lastOutcome([msg('e', 'error', 1), msg('n', 'note', 2), msg('c', 'changes', 3)])?.id
    ).toBe('e');
    expect(lastOutcome([])).toBeNull();
  });
});

describe('drivingBriefId', () => {
  const items = buildChatItems([
    msg('old', 'from_agent', 100, 'chief'),
    msg('reply', 'agent', 200),
    msg('brief', 'from_agent', 1000, 'chief'),
    msg('during', 'agent', 1500),
  ]);

  it('is the brief that arrived just before the turn began', () => {
    expect(drivingBriefId(items, agent({ state: 'working', since: 1001 }))).toBe('brief');
    expect(drivingBriefId(items, agent({ state: 'waiting', since: 1001 }))).toBe('brief');
  });

  it('is nothing when idle, or when your message started the turn', () => {
    expect(drivingBriefId(items, agent({}))).toBeNull();
    const yours = buildChatItems([
      msg('brief', 'from_agent', 1000, 'chief'),
      msg('you', 'user', 1001),
    ]);
    expect(drivingBriefId(yours, agent({ state: 'working', since: 1002 }))).toBeNull();
  });
});

describe('newestPeerGroups', () => {
  it('marks only the newest hand-off to each peer, never work that came in', () => {
    const items = buildChatItems([
      msg('f1', 'sent_to_agent', 1, 'finance'),
      msg('x', 'agent', 2),
      msg('a1', 'sent_to_agent', 3, 'acme'),
      msg('y', 'agent', 4),
      msg('f2', 'sent_to_agent', 5, 'finance'),
      msg('z', 'agent', 6),
      msg('c1', 'from_agent', 7, 'chief'),
    ]);
    expect([...newestPeerGroups(items)].sort()).toEqual(['a1', 'f2']);
  });
});

it('names a project by its folder', () => {
  expect(folderName('/Users/me/ShipStudio/acme/')).toBe('acme');
});
