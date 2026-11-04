import { describe, expect, it } from 'vitest';
import {
  deviceLine,
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
