import { describe, expect, it, beforeEach } from 'vitest';
import {
  androidSteps,
  buildIosInstallPrompt,
  expiryLine,
  iosBuildCommand,
  iosSteps,
  isFreeTeamExpiry,
  readInstallRecord,
  reminderDue,
  saveInstallRecord,
  xcodeBlocks,
  type AndroidInstallStatus,
  type IosInstallStatus,
} from './companionInstall';

const source = {
  path: '/Users/me/ShipStudio/.companion-build/mobile',
  present: false,
  installed: false,
  desktopVersion: '1.7.0',
};

/** This Mac, as the real checks read it: Xcode 26.1, no phone. */
const thisMac: IosInstallStatus = {
  xcode: { state: 'tooOld', version: '26.1' },
  xcodeMinimum: '26.4',
  clt: true,
  cocoapods: '1.16.2',
  node: 'v24.17.0',
  devices: [],
  signing: {
    teamId: 'H8NN6DM6G6',
    identity: 'Apple Development: me',
    bundleId: 'studio.ship.companion.a4c8c6',
  },
  source,
};

const iphone = {
  udid: '00008140-001',
  name: 'Julian’s iPhone',
  model: 'iPhone 16 Pro',
  osVersion: '26.1',
  connected: true,
  paired: true,
  developerMode: 'enabled',
};

const state = (steps: { id: string; state: string }[]) =>
  Object.fromEntries(steps.map((s) => [s.id, s.state]));

describe('iosSteps', () => {
  it('an old Xcode is the user’s, with the App Store, and blocks the agent', () => {
    const steps = iosSteps(thisMac, null);
    const xcode = steps.find((s) => s.id === 'xcode');
    expect(xcode?.state).toBe('you');
    expect(xcode?.detail).toContain('26.1');
    expect(xcode?.appStore).toBe('Update Xcode in the App Store');
    expect(xcodeBlocks(thisMac)).toBe(true);
    expect(state(steps)).toMatchObject({
      tools: 'done',
      phone: 'you',
      devmode: 'waiting',
      signing: 'done',
      build: 'waiting',
    });
  });

  it('first launch is the agent’s, not a block', () => {
    const s = { ...thisMac, xcode: { state: 'needsFirstLaunch' as const, version: '26.4' } };
    expect(xcodeBlocks(s)).toBe(false);
    expect(state(iosSteps(s, null)).xcode).toBe('agent');
  });

  it('a phone that hasn’t trusted the Mac, then Developer Mode, then the build', () => {
    const ok = { ...thisMac, xcode: { state: 'ok' as const, version: '26.4' } };
    const untrusted = iosSteps({ ...ok, devices: [{ ...iphone, paired: false }] }, null);
    expect(state(untrusted)).toMatchObject({ phone: 'you', devmode: 'waiting' });
    const devOff = iosSteps({ ...ok, devices: [{ ...iphone, developerMode: 'disabled' }] }, null);
    expect(state(devOff)).toMatchObject({ phone: 'done', devmode: 'you', build: 'agent' });
    const installed = iosSteps(
      { ...ok, devices: [iphone] },
      {
        installed: true,
        version: '0.1.0',
        expiresAt: null,
      }
    );
    expect(installed.every((s) => s.state === 'done')).toBe(true);
  });

  it('a disconnected phone doesn’t count', () => {
    const s = { ...thisMac, devices: [{ ...iphone, connected: false }] };
    expect(state(iosSteps(s, null)).phone).toBe('you');
  });
});

describe('androidSteps', () => {
  const base: AndroidInstallStatus = {
    adb: null,
    sdk: false,
    jdk: false,
    node: 'v24',
    devices: [],
    package: 'studio.ship.companion.self',
    source,
  };

  it('no adb: the agent installs it, and the phone waits', () => {
    expect(state(androidSteps(base, null))).toMatchObject({
      adb: 'agent',
      toolchain: 'agent',
      phone: 'waiting',
      build: 'waiting',
    });
  });

  it('an unauthorized phone asks the user to tap Allow', () => {
    const s = {
      ...base,
      adb: 'Android Debug Bridge version 1.0.41',
      devices: [{ serial: 'ZY22', state: 'unauthorized', model: null }],
    };
    const phone = androidSteps(s, null).find((x) => x.id === 'phone');
    expect(phone?.state).toBe('you');
    expect(phone?.detail).toContain('Allow');
  });
});

describe('the build', () => {
  it('builds Release for the chosen phone with the team’s bundle id', () => {
    const cmd = iosBuildCommand(thisMac, iphone);
    expect(cmd).toContain("cd '/Users/me/ShipStudio/.companion-build/mobile'");
    expect(cmd).toContain('SHIPSTUDIO_BUNDLE_ID=studio.ship.companion.a4c8c6');
    expect(cmd).toContain('APPLE_TEAM_ID=H8NN6DM6G6');
    expect(cmd).toContain('--device 00008140-001 --configuration Release');
    expect(iosBuildCommand({ ...thisMac, signing: null }, iphone)).toBeNull();
  });

  it('the prompt is one line, fetches the matching tag, and leaves done to the checklist', () => {
    const prompt = buildIosInstallPrompt(thisMac);
    expect(prompt).not.toContain('\n');
    expect(prompt.startsWith('-')).toBe(false);
    expect(prompt).toContain('--branch v1.7.0');
    expect(prompt).toContain('App Store');
    expect(prompt).toContain('do not claim success');
  });
});

describe('expiry', () => {
  const DAY = 86_400_000;
  const installedAt = Date.UTC(2026, 10, 4, 12); // noon, so any timezone reads the same day
  const record = {
    platform: 'ios' as const,
    deviceName: 'Julian’s iPhone',
    deviceId: 'u',
    installedAt,
    expiresAt: installedAt + 7 * DAY,
  };

  it('reminds once, in the last day', () => {
    expect(reminderDue(record, installedAt + 5 * DAY)).toBe(false);
    expect(reminderDue(record, installedAt + 6.5 * DAY)).toBe(true);
    expect(reminderDue({ ...record, remindedFor: record.expiresAt }, installedAt + 6.5 * DAY)).toBe(
      false
    );
    expect(reminderDue(record, installedAt + 8 * DAY)).toBe(false);
    expect(reminderDue({ ...record, expiresAt: undefined }, installedAt)).toBe(false);
  });

  it('says when, and tells a free team from a paid one', () => {
    expect(expiryLine(record.expiresAt, installedAt)).toBe('Works until Wed 11 Nov');
    expect(expiryLine(record.expiresAt, installedAt + 8 * DAY)).toBe(
      'Stopped opening on Wed 11 Nov'
    );
    expect(isFreeTeamExpiry(record)).toBe(true);
    expect(isFreeTeamExpiry({ installedAt, expiresAt: installedAt + 365 * DAY })).toBe(false);
  });

  describe('the record', () => {
    beforeEach(() => localStorage.clear());
    it('round-trips through local storage', () => {
      expect(readInstallRecord()).toBeNull();
      saveInstallRecord(record);
      expect(readInstallRecord()).toEqual(record);
    });
  });
});
