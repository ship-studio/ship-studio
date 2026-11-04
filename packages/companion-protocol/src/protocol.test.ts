import { describe, expect, it } from 'vitest';
import { formatPairingLink, negotiate, parsePairingLink, type PairingLink } from './index';

describe('negotiate', () => {
  it('picks the highest version both speak', () => {
    expect(negotiate({ min: 1, max: 3 }, { min: 2, max: 2 })).toEqual({ ok: true, version: 2 });
    expect(negotiate({ min: 1, max: 2 }, { min: 1, max: 3 })).toEqual({ ok: true, version: 2 });
  });

  it('names the side that is behind', () => {
    expect(negotiate({ min: 1, max: 1 }, { min: 2, max: 3 })).toEqual({ ok: false, update: 'app' });
    expect(negotiate({ min: 3, max: 4 }, { min: 1, max: 2 })).toEqual({ ok: false, update: 'mac' });
  });
});

describe('pairing links', () => {
  const link: PairingLink = {
    v: 1,
    code: 'K7Q2MZX4A9PL3WRT8NBV6YHC5D',
    serverId: 'srv_1',
    name: 'Julian’s MacBook Pro',
    routes: [
      { kind: 'tailscale', url: 'https://mac.tail1234.ts.net:47443' },
      { kind: 'lan', url: 'https://192.168.1.20:47444', pin: 'b64pin' },
    ],
  };

  it('round-trips, including non-ASCII names', () => {
    expect(parsePairingLink(formatPairingLink(link))).toEqual(link);
  });

  it('refuses anything that is not a usable v1 link', () => {
    expect(parsePairingLink('https://example.com')).toBeNull();
    const unpinned = { ...link, routes: [{ kind: 'lan', url: 'https://192.168.1.20:47444' }] };
    expect(parsePairingLink(formatPairingLink(unpinned as PairingLink))).toBeNull();
    const plain = { ...link, routes: [{ kind: 'tailscale', url: 'http://mac.ts.net' }] };
    expect(parsePairingLink(formatPairingLink(plain as PairingLink))).toBeNull();
    expect(
      parsePairingLink(formatPairingLink({ ...link, v: 2 } as unknown as PairingLink))
    ).toBeNull();
  });
});
