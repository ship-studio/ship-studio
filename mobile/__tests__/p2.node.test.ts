/**
 * P2 against the mock Mac, through the app's real transport: files both ways
 * over the HTTP routes (auth, limits, the send that carries them), the
 * echoed clientId, the Files list, search, check-ins and routines, and
 * projects with their sessions.
 */

import type { AgentMessage, CompanionEvent, Cursor } from '@shipstudio/companion-protocol';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { applyEvent, emptySync } from '../src/lib/sync';
import { DirectTransport, WireFailure, type HttpAdapter } from '../src/lib/transport';

jest.setTimeout(20_000);

const dir = mkdtempSync(join(tmpdir(), 'companion-p2-'));

/** `files.ts`'s job under Node: fetch and the file system. */
const nodeHttp: HttpAdapter = {
  async upload(url, uri, headers, onProgress) {
    const res = await fetch(url, { method: 'PUT', headers, body: readFileSync(uri) });
    onProgress?.(1);
    return { status: res.status, body: await res.text() };
  },
  async download(url, headers, key) {
    const res = await fetch(url, { headers });
    const uri = join(dir, key.replace(/[^\w.-]/g, '_'));
    if (res.ok) writeFileSync(uri, Buffer.from(await res.arrayBuffer()));
    return { status: res.status, uri };
  },
};

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('P2 against the mock Mac', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0, draftEveryMs: 10 });
  let url = '';
  let token = '';
  let t: DirectTransport;
  let state = emptySync();
  const events: CompanionEvent[] = [];

  beforeAll(async () => {
    url = await mock.listen();
    token = mock.issueToken().token;
    t = new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => state.cursor ?? undefined,
      foreground: true,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      http: nodeHttp,
    });
    t.onEvent((e: CompanionEvent, c?: Cursor) => {
      events.push(e);
      state = applyEvent(state, e, c);
    });
    await until(() => state.syncedAt != null);
  });

  afterAll(async () => {
    t.close();
    await mock.close();
  });

  const file = (name: string, bytes: Buffer | string) => {
    const uri = join(dir, name);
    writeFileSync(uri, bytes);
    return uri;
  };

  it('fills the snapshot’s projects', () => {
    expect(state.projects?.map((p) => p.name)).toEqual(['acme-site', 'docs', 'pricing-test']);
    const waiting = state.projects![0].sessions[0];
    expect(waiting.state).toBe('needs_decision');
    expect(waiting.question?.options.map((o) => o.key)).toEqual(['1', '2', '3']);
  });

  it('refuses the file routes without a paired token', async () => {
    const put = (auth?: string) =>
      fetch(`${url}/v1/blobs`, {
        method: 'PUT',
        headers: auth ? { Authorization: auth } : {},
        body: 'x',
      }).then((r) => r.status);
    expect(await put()).toBe(401);
    expect(await put('Bearer nope')).toBe(401);
    const get = await fetch(`${url}/v1/agents/site/attachments/attachments/site_p2_4/Phone.png`);
    expect(get.status).toBe(401);
  });

  it('refuses a file over the desktop’s limit, in the desktop’s words', async () => {
    const big = file('big.bin', Buffer.alloc(25 * 1024 * 1024 + 1));
    const failure = await t
      .upload({ uri: big, name: 'big.bin', mime: 'application/octet-stream' })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WireFailure);
    expect((failure as WireFailure).error).toMatchObject({ type: 'Protocol', code: 'too_large' });
    expect((failure as WireFailure).message).toContain('25 MB');
  });

  it('uploads, sends by blob id, echoes the clientId, and serves the file back', async () => {
    const progress: number[] = [];
    const ref = await t.upload(
      { uri: file('notes.md', '# Launch notes\n'), name: 'notes.md', mime: 'text/markdown' },
      (f) => progress.push(f)
    );
    expect(ref).toMatchObject({ name: 'notes.md', mime: 'text/markdown', size: 15 });
    expect(progress.at(-1)).toBe(1);

    const sent = await t.request('agents.send', {
      agentId: 'qa',
      text: 'Read this',
      clientId: 'client-1',
      attachments: [{ blobId: ref.blobId }],
    });
    expect(sent.clientId).toBe('client-1');
    expect(sent.attachments?.[0]).toMatchObject({ name: 'notes.md', size: 15 });
    const echoed = events.find(
      (e): e is Extract<CompanionEvent, { type: 'agents.message' }> =>
        e.type === 'agents.message' && e.message.id === sent.id
    );
    expect(echoed?.message.clientId).toBe('client-1');

    // A retry with the same clientId is the same message, and the blob isn't reused.
    const again = await t.request('agents.send', {
      agentId: 'qa',
      text: 'Read this',
      clientId: 'client-1',
      attachments: [{ blobId: ref.blobId }],
    });
    expect(again.id).toBe(sent.id);
    await expect(
      t.request('agents.send', {
        agentId: 'qa',
        text: 'Again',
        clientId: 'client-2',
        attachments: [{ blobId: ref.blobId }],
      })
    ).rejects.toBeInstanceOf(WireFailure);

    const local = await t.download({ agentId: 'qa', path: sent.attachments![0].path });
    expect(readFileSync(local, 'utf8')).toBe('# Launch notes\n');
  });

  it('lists a conversation’s files both ways, as the desktop’s Files list does', async () => {
    expect(
      (await t.request('agents.files', { agentId: 'qa' })).map((f) => [f.name, f.from])
    ).toEqual([['notes.md', 'user']]);
    const site = await t.request('agents.files', { agentId: 'site' });
    expect(site.map((f) => [f.name, f.from])).toEqual([['Lighthouse report.pdf', 'agent']]);
    // A preview screenshot rides on its session card, not in Files.
    const shot = await t.download({ agentId: 'site', path: 'attachments/site_p2_4/Phone.png' });
    expect(readFileSync(shot).subarray(1, 4).toString()).toBe('PNG');
  });

  it('searches every chat, and a hit can be paged back to', async () => {
    const hits = await t.request('agents.search', { query: 'morning check-in #3:' });
    expect(hits[0]).toMatchObject({ agentId: 'chief', agentName: 'Chief of Staff' });
    // The hit is far back in a long chat: page with `before` until it's there.
    let page = await t.request('agents.messages', { agentId: 'chief', limit: 20 });
    const seen: AgentMessage[] = [...page.messages];
    while (!seen.some((m) => m.id === hits[0].messageId) && page.more) {
      page = await t.request('agents.messages', {
        agentId: 'chief',
        limit: 20,
        before: seen[0].id,
      });
      seen.unshift(...page.messages);
    }
    expect(seen.some((m) => m.id === hits[0].messageId)).toBe(true);
  });

  it('adds, pauses, runs now, edits and cancels a routine, all seen through the registry', async () => {
    const preview = await t.request('agents.schedule.preview', { when: 'every weekday at 9am' });
    expect(preview.repeat).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 });
    const bad = await t
      .request('agents.schedule.preview', { when: 'whenever' })
      .catch((e: WireFailure) => e.error);
    expect(bad).toMatchObject({ type: 'Validation', field: 'when' });

    const checkIns = () => state.overview!.agents.find((a) => a.id === 'qa')!.checkIns ?? [];
    const made = await t.request('agents.schedule.create', {
      agentId: 'qa',
      when: 'every 2 hours',
      note: 'Check the error rate',
    });
    await until(() => checkIns().some((c) => c.id === made.id));
    await t.request('agents.schedule.pause', { agentId: 'qa', id: made.id, paused: true });
    await until(() => checkIns().find((c) => c.id === made.id)?.paused === true);
    await t.request('agents.schedule.update', {
      agentId: 'qa',
      id: made.id,
      when: 'tomorrow at 8:30',
      note: 'Check the error rate once',
    });
    await until(() => checkIns().find((c) => c.id === made.id)?.repeat === undefined);
    await t.request('agents.schedule.runNow', { agentId: 'qa', id: made.id });
    await until(() =>
      (state.chats.qa?.messages ?? []).some(
        (m) => m.kind === 'check_in' && m.text === 'Check the error rate once'
      )
    );
    await t.request('agents.schedule.cancel', { agentId: 'qa', id: made.id });
    await until(() => !checkIns().some((c) => c.id === made.id));
  });

  it('lists projects and reads a session’s screen', async () => {
    const projects = await t.request('projects.list', {});
    expect(projects[0].sessions.map((s) => s.tab)).toEqual([2, 1]);
    const screen = await t.request('sessions.read', { sessionId: 'pty-docs-1' });
    expect(screen.session.state).toBe('finished');
    expect(screen.screen).toContain('broken links');
    expect(screen.reply).toContain('0 broken');
  });

  it('answers and types into a session, and hears each change as an event', async () => {
    const tab = (id: string) =>
      state.projects?.flatMap((p) => p.sessions).find((x) => x.sessionId === id);
    // Typing into a tab that's asking a question would answer it: refused.
    await expect(
      t.request('sessions.send', {
        project: '/Users/you/ShipStudio/acme-site',
        sessionId: 'pty-site-2',
        text: 'hello',
        clientId: 's1',
      })
    ).rejects.toThrow(/waiting for your answer/);
    // A digit only answers while a question shows.
    await expect(t.request('sessions.key', { sessionId: 'pty-docs-1', key: '1' })).rejects.toThrow(
      /isn’t asking/
    );
    await t.request('sessions.key', { sessionId: 'pty-site-2', key: '1' });
    await until(() => tab('pty-site-2')?.state === 'working' && !tab('pty-site-2')?.question);
    // Typed, once per clientId, and refused like agents.send.
    const sent = await t.request('sessions.send', {
      project: '/Users/you/ShipStudio/docs',
      sessionId: 'pty-docs-1',
      text: 'Check the links again',
      clientId: 's2',
    });
    expect(sent.sessionId).toBe('pty-docs-1');
    await until(() => tab('pty-docs-1')?.state === 'working');
    await expect(
      t.request('sessions.send', {
        project: '/Users/you/ShipStudio/docs',
        sessionId: 'pty-docs-1',
        text: '!rm -rf /',
        clientId: 's3',
      })
    ).rejects.toBeInstanceOf(WireFailure);
    expect(events.some((e) => e.type === 'projects.changed')).toBe(true);
  });

  it('pins, mutes, hides and edits instructions, and nothing else', async () => {
    const qa = () => state.overview?.agents.find((a) => a.id === 'qa');
    await t.request('agents.update', { agentId: 'qa', input: { muted: true } });
    await until(() => qa()?.muted === true);
    await expect(
      t.request('agents.update', { agentId: 'qa', input: { name: 'Renamed' } })
    ).rejects.toThrow(/pin, mute, hide and the instructions/);
    await t.request('agents.update', { agentId: 'qa', input: { muted: false } });
    await until(() => qa()?.muted === false);
  });

  it('serves the agent sheet: instructions, usage and revoking a permission', async () => {
    const site = () => state.overview?.agents.find((a) => a.id === 'site');
    expect(await t.request('agents.instructions', { agentId: 'site' })).toMatch(/Acme Site/);
    await t.request('agents.update', {
      agentId: 'site',
      input: { instructions: 'Ship it small.' },
    });
    expect(await t.request('agents.instructions', { agentId: 'site' })).toBe('Ship it small.');
    const usage = await t.request('agents.usage', { agentId: 'site' });
    expect(usage.week.turns).toBeGreaterThan(0);
    await until(() => (site()?.permissions?.length ?? 0) === 2);
    await t.request('agents.revokePermission', { agentId: 'site', ruleId: 'rule_build' });
    await until(
      () =>
        site()
          ?.permissions?.map((r) => r.id)
          .join() === 'rule_docs'
    );
  });

  it('opens a change card’s diff, starts a session and photographs a preview', async () => {
    const diff = await t.request('agents.changeDiff', {
      agentId: 'site',
      messageId: 'site_p2_7',
      path: 'src/components/Hero.tsx',
    });
    expect(diff.content).toMatch(/^@@/);
    const project = '/Users/you/ShipStudio/acme-site';
    const started = await t.request('sessions.start', {
      project,
      prompt: 'Add a footer',
      clientId: 'st1',
    });
    const again = await t.request('sessions.start', {
      project,
      prompt: 'Add a footer',
      clientId: 'st1',
    });
    expect(again.sessionId).toBe(started.sessionId);
    await until(
      () =>
        state.projects?.some((p) => p.sessions.some((x) => x.sessionId === started.sessionId)) ??
        false
    );
    const shot = await t.request('preview.screenshot', { project, device: 'phone' });
    expect(shot.mime).toBe('image/png');
    const local = await t.download({ blobId: shot.blobId });
    expect(readFileSync(local).subarray(1, 4).toString()).toBe('PNG');
  });
});
