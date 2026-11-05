import type { AgentMessage, AgentsOverview, MacStatus } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import {
  addPending,
  applyEvent,
  confirmSend,
  emptySync,
  mergePage,
  type SyncState,
} from '../src/lib/sync';
import { msg } from './helpers';

const epoch = 'e1';
const at = (s: SyncState, seq: number, message: AgentMessage) =>
  applyEvent(s, { type: 'agents.message', message }, { epoch, seq });

describe('messages', () => {
  it('upserts by id, so a replayed message never doubles', () => {
    let s = at(emptySync(), 1, msg('m1', 10));
    s = at(s, 2, msg('m2', 20));
    s = at(s, 1, msg('m1', 10)); // replayed
    expect(s.chats.a.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(s.cursor).toEqual({ epoch, seq: 1 });
  });

  it('keeps an answered approval that arrived during a fetch (the stale-read race)', () => {
    const pending = msg('card', 10, {
      kind: 'approval',
      approval: { requestId: 'r', title: 't', detail: '', status: 'pending' },
    });
    const answered = { ...pending, approval: { ...pending.approval!, status: 'allowed' as const } };
    let s = applyEvent(emptySync(), { type: 'sync.caughtUp', cursor: { epoch, seq: 4 } });
    // The event (seq 5) lands while a fetch read at seq 4 is in flight.
    s = at(s, 5, answered);
    s = mergePage(
      s,
      'a',
      { messages: [pending, msg('m0', 5)], asOf: { epoch, seq: 4 }, more: false },
      false
    );
    expect(s.chats.a.messages.find((m) => m.id === 'card')?.approval?.status).toBe('allowed');
    expect(s.chats.a.messages.map((m) => m.id)).toEqual(['m0', 'card']);
  });

  it('lets a newer read overwrite an older event', () => {
    let s = at(emptySync(), 3, msg('m1', 10, { text: 'old' }));
    s = mergePage(
      s,
      'a',
      { messages: [msg('m1', 10, { text: 'new' })], asOf: { epoch, seq: 9 }, more: true },
      false
    );
    expect(s.chats.a.messages[0].text).toBe('new');
  });
});

describe('drafts', () => {
  const draft = (s: SyncState, from: number, text: string, id = 'd') =>
    applyEvent(s, { type: 'agents.draft', agentId: 'a', id, from, text });

  it('appends at the right offset and drops on a gap', () => {
    let s = draft(emptySync(), 0, 'Hel');
    s = draft(s, 3, 'lo');
    expect(s.drafts.a.text).toBe('Hello');
    s = draft(s, 9, 'x'); // out of step
    expect(s.drafts.a).toBeUndefined();
    s = draft(s, 0, 'Hello, w'); // the restart from 0 on a new connection
    expect(s.drafts.a.text).toBe('Hello, w');
  });

  it('gives way to the finished message with the same id', () => {
    let s = draft(emptySync(), 0, 'Hi');
    s = at(s, 1, msg('d', 10, { text: 'Hi there' }));
    expect(s.drafts.a).toBeUndefined();
    expect(s.chats.a.messages[0].text).toBe('Hi there');
  });
});

describe('sends', () => {
  it('settles the optimistic bubble once, whether the event or the response comes first', () => {
    const p = { clientId: 'c1', agentId: 'a', text: 'hello', ts: 1, failed: false };
    const real = msg('u1', 2, { kind: 'user', text: 'hello' });
    let s = addPending(emptySync(), p);
    s = at(s, 1, real);
    expect(s.pending.a).toHaveLength(0);
    s = confirmSend(s, 'c1', real);
    expect(s.chats.a.messages).toHaveLength(1);

    let t = addPending(emptySync(), p);
    t = confirmSend(t, 'c1', real);
    expect(t.pending.a).toHaveLength(0);
    expect(t.chats.a.messages).toHaveLength(1);
  });

  it('matches the echoed clientId, not the text, when the Mac sends one', () => {
    const twin = { clientId: 'c2', agentId: 'a', text: 'ok', ts: 1, failed: false };
    const first = { ...twin, clientId: 'c1' };
    let s = addPending(addPending(emptySync(), first), twin);
    // Two bubbles with the same text: the second one's echo settles the second.
    s = at(s, 1, msg('u2', 2, { kind: 'user', text: 'ok', clientId: 'c2' }));
    expect(s.pending.a.map((p) => p.clientId)).toEqual(['c1']);
    // An echo for a send this phone didn't make settles nothing, even with the same text.
    s = at(s, 2, msg('u3', 3, { kind: 'user', text: 'ok', clientId: 'elsewhere' }));
    expect(s.pending.a.map((p) => p.clientId)).toEqual(['c1']);
  });
});

describe('projects', () => {
  const project = (path: string, dirtyFiles = 0) => ({
    path,
    name: path,
    dirtyFiles,
    sessions: [],
  });

  it('take the snapshot’s list, then changes and removals by path', () => {
    let s = applyEvent(emptySync(), {
      type: 'sync.snapshot',
      cursor: { epoch, seq: 1 },
      overview: { agents: [], engineReady: true, engines: [] } as AgentsOverview,
      status: {} as MacStatus,
      projects: [project('/a'), project('/b')],
    });
    s = applyEvent(s, { type: 'projects.changed', project: project('/a', 3) }, { epoch, seq: 2 });
    s = applyEvent(s, { type: 'projects.changed', project: project('/c') }, { epoch, seq: 3 });
    s = applyEvent(s, { type: 'projects.removed', path: '/b' }, { epoch, seq: 4 });
    expect(s.projects?.map((p) => [p.path, p.dirtyFiles])).toEqual([
      ['/a', 3],
      ['/c', 0],
    ]);
  });
});

describe('snapshot', () => {
  it('replaces the overview and forgets seqs and drafts from the old epoch', () => {
    let s = at(emptySync(), 7, msg('m1', 10));
    s = applyEvent(s, { type: 'agents.draft', agentId: 'a', id: 'd', from: 0, text: 'x' });
    s = applyEvent(s, {
      type: 'sync.snapshot',
      cursor: { epoch: 'e2', seq: 1 },
      overview: { agents: [], engineReady: true, engines: [] } as AgentsOverview,
      status: {} as MacStatus,
      projects: [],
    });
    expect(s.cursor).toEqual({ epoch: 'e2', seq: 1 });
    expect(s.drafts).toEqual({});
    expect(s.seqs).toEqual({});
    expect(s.chats.a.loaded).toBe(false);
    expect(s.chats.a.messages).toHaveLength(1); // still readable until the re-fetch
  });
});

describe('the Mac’s real output (fixtures.gen.ts)', () => {
  it('applies every generated event frame and page without losing a message', () => {
    let s = emptySync();
    let n = 0;
    for (const f of real.frames) {
      if (f.t !== 'evt') continue;
      const cursor =
        'seq' in f && typeof f.seq === 'number' ? { epoch: 'e', seq: f.seq } : undefined;
      s = applyEvent(s, f.event, cursor);
      n++;
    }
    expect(n).toBeGreaterThan(0);
    const page = real.agentsMessages;
    s = mergePage(s, 'a1', { ...page, asOf: { ...page.asOf, epoch: 'e' } }, false);
    const ids = new Set(page.messages.map((m) => m.id));
    expect(s.chats.a1.messages.filter((m) => ids.has(m.id))).toHaveLength(ids.size);
  });
});
