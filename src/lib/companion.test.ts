import { describe, expect, it } from 'vitest';
import {
  activityLine,
  deviceLine,
  phoneCapabilities,
  expiresIn,
  phoneStep,
  presenceLine,
  requestPairOnOpen,
  takePairOnOpen,
  type Device,
  type PhoneStatus,
} from './companion';

const status = (over: Partial<PhoneStatus> = {}): PhoneStatus => ({
  enabled: true,
  running: true,
  serve: { state: 'on', url: 'https://mac.ts.net:47443' },
  tailscale: { state: 'connected', dnsName: 'mac.ts.net' },
  devices: [],
  pairing: { active: false },
  activity: {},
  methods: [],
  push: { available: false, enabled: false },
  ...over,
});

describe('phoneStep', () => {
  it('is off before anything else', () => {
    expect(phoneStep(status({ enabled: false, tailscale: { state: 'notInstalled' } }))).toEqual({
      kind: 'off',
    });
  });

  it('puts Tailscale itself before our route', () => {
    expect(phoneStep(status({ tailscale: { state: 'notInstalled' } })).kind).toBe(
      'installTailscale'
    );
    expect(phoneStep(status({ tailscale: { state: 'needsLogin' } })).kind).toBe('signInTailscale');
  });

  it('is ready only when the serve handler was read back', () => {
    expect(phoneStep(status())).toEqual({ kind: 'ready', url: 'https://mac.ts.net:47443' });
    expect(phoneStep(status({ serve: { state: 'off' } })).kind).toBe('starting');
    expect(phoneStep(status({ serve: { state: 'needsApproval', url: 'https://x' } }))).toEqual({
      kind: 'approveHttps',
      url: 'https://x',
    });
    expect(
      phoneStep(
        status({ serve: { state: 'off' }, tailscale: { state: 'unknown', detail: 'no answer' } })
      )
    ).toEqual({ kind: 'failed', detail: 'no answer' });
  });
});

const device = (over: Partial<Device> = {}): Device => ({
  id: 'd1',
  name: 'Julian’s iPhone',
  platform: 'ios',
  model: 'iPhone 16 Pro',
  appVersion: '1.0.0',
  build: 'official',
  pairedAt: 0,
  connected: false,
  ...over,
});

describe('wording', () => {
  it('describes a device without repeating its name', () => {
    expect(deviceLine(device())).toBe('iPhone 16 Pro · app 1.0.0');
    expect(deviceLine(device({ name: 'Pixel 9', model: 'Pixel 9', build: 'self' }))).toBe(
      'app 1.0.0 · built on this Mac'
    );
    expect(deviceLine(device({ model: undefined, platform: 'android' }))).toBe(
      'Android phone · app 1.0.0'
    );
  });

  it('says connected, last seen, or never — never a guess', () => {
    const now = 10 * 60 * 60_000;
    expect(presenceLine(device({ connected: true }), now)).toBe('Connected now');
    expect(presenceLine(device(), now)).toBe('Hasn’t connected yet');
    expect(
      presenceLine(device({ lastSeenAt: now - 5 * 60_000, lastRoute: 'tailscale' }), now)
    ).toBe('Last seen 5 min ago over Tailscale');
    expect(presenceLine(device({ lastSeenAt: now - 3 * 60 * 60_000 }), now)).toBe(
      'Last seen 3 h ago'
    );
  });

  it('counts a code down and then stops', () => {
    expect(expiresIn(300_000, 0)).toBe('5:00');
    expect(expiresIn(300_000, 299_001)).toBe('0:01');
    expect(expiresIn(300_000, 300_000)).toBeNull();
  });
});

describe('pair on open', () => {
  it('is taken once', () => {
    expect(takePairOnOpen()).toBe(false);
    requestPairOnOpen();
    expect(takePairOnOpen()).toBe(true);
    expect(takePairOnOpen()).toBe(false);
  });
});

describe('activityLine', () => {
  const now = 10 * 60_000;
  const at = now - 3 * 60_000;
  it('says what the phone did and when', () => {
    expect(activityLine({ tool: 'agents.send', detail: 'hi', ok: true, atMs: at }, now)).toBe(
      'Sent a message · 3 min ago'
    );
  });
  it('tells an allow from a deny, and a pause from a resume', () => {
    const a = (tool: string, detail: string) =>
      activityLine({ tool, detail, ok: true, atMs: now }, now);
    expect(a('agents.answerApproval', 'always allow')).toBe('Allowed a request · just now');
    expect(a('agents.answerApproval', 'deny with note: no')).toBe('Denied a request · just now');
    expect(a('agents.schedule.pause', 'resume c1')).toBe('Resumed a check-in · just now');
  });
  it('says when it was refused, and falls back to the method name', () => {
    expect(activityLine({ tool: 'agents.send', detail: '', ok: false, atMs: now }, now)).toBe(
      'Sent a message, refused · just now'
    );
    expect(activityLine({ tool: 'agents.new', detail: '', ok: true, atMs: now }, now)).toBe(
      'agents.new · just now'
    );
  });
});

describe('phoneCapabilities', () => {
  it('lists only what this Mac serves, and is honest about the rest', () => {
    const p1 = phoneCapabilities(['agents.send', 'agents.answerApproval']);
    expect(p1.can).toEqual(['Chat with agents and answer what they ask']);
    expect(p1.cannot).toContain('Push to git');
    expect(p1.cannot).not.toContain('Type into project sessions');

    const p2 = phoneCapabilities([
      'agents.send',
      'agents.answerApproval',
      'agents.files',
      'agents.search',
      'projects.list',
      'sessions.read',
    ]);
    expect(p2.can).toContain('See projects and read their agent sessions');
    expect(p2.cannot[0]).toBe('Type into project sessions');
  });
});
