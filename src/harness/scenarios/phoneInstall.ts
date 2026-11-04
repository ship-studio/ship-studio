/**
 * "Install on my phone" in the Phone panel: the route choice, the iPhone
 * checklist on this Mac as the real checks read it (Xcode 26.1, too old),
 * no phone plugged in, Claude Code building, done and straight into
 * pairing, Android, and the Reinstall entry with its expiry.
 */

import type { Scenario, ScenarioStep } from '../types';
import { PHONE_PAIRING_LINK, PHONE_QR } from '../fixtures/phoneQr';
import { phoneStatus } from './phone';

const DAY = 24 * 60 * 60 * 1000;
const DNS = 'studio-mac.tail1234.ts.net';

const source = {
  path: '/Users/julian/ShipStudio/.companion-build/mobile',
  present: false,
  installed: false,
  desktopVersion: '1.7.0',
};

/** This Mac, as `companion_install_ios_status` read it on 4 Nov 2026. */
const THIS_MAC = {
  xcode: { state: 'tooOld', version: '26.1' },
  xcodeMinimum: '26.4',
  clt: true,
  cocoapods: '1.16.2',
  node: 'v24.17.0',
  devices: [],
  signing: {
    teamId: 'H8NN6DM6G6',
    identity: 'Apple Development: julian@example.com (5VD2FLB8HU)',
    bundleId: 'studio.ship.companion.a4c8c6',
  },
  source,
};

const XCODE_OK = { ...THIS_MAC, xcode: { state: 'ok', version: '26.4' } };

const IPHONE = {
  udid: '00008140-001A2B3C0E91801C',
  name: 'Julian’s iPhone',
  model: 'iPhone 16 Pro',
  osVersion: '26.1',
  connected: true,
  paired: true,
  developerMode: 'enabled',
};

/** As `companion_install_android_status` read this Mac: adb, Java and SDK, no phone. */
const ANDROID_THIS_MAC = {
  adb: 'Android Debug Bridge version 1.0.41',
  sdk: true,
  jdk: true,
  node: 'v24.17.0',
  devices: [],
  package: 'studio.ship.companion.self',
  source,
};

const NOT_INSTALLED = { installed: false, version: null, expiresAt: null };

/** Claude Code a few minutes in, through a fake PTY. */
const AGENT_SCREEN = [
  '',
  ' \x1b[38;5;173m✻\x1b[0m \x1b[1mClaude Code\x1b[0m',
  '',
  ' \x1b[2m> You are installing the Ship Studio companion app on the user’s iPhone…\x1b[0m',
  '',
  ' \x1b[38;5;173m⏺\x1b[0m I’ll check what this Mac already has.',
  '',
  ' \x1b[38;5;114m⏺\x1b[0m \x1b[1mBash\x1b[0m(xcodebuild -version && pod --version && node --version)',
  '   ⎿  Xcode 26.4 · CocoaPods 1.16.2 · Node v24.17.0',
  '',
  ' \x1b[38;5;173m⏺\x1b[0m Everything is in place, and Julian’s iPhone is plugged in with',
  '   Developer Mode on. Now I’ll fetch the app’s source for Ship Studio 1.7.0.',
  '',
  ' \x1b[38;5;114m⏺\x1b[0m \x1b[1mBash\x1b[0m(git clone --depth 1 --sparse --branch v1.7.0 … && pnpm install)',
  '   ⎿  Done in 41.2s',
  '',
  ' \x1b[38;5;173m⏺\x1b[0m Building a Release version and installing it over the cable.',
  '   The first build takes a few minutes.',
  '',
  ' \x1b[38;5;114m⏺\x1b[0m \x1b[1mBash\x1b[0m(npx expo run:ios --device 00008140-001A… --configuration Release)',
  '   ⎿  › Planning build',
  '      › Executing ShipStudio » [CP] Check Pods Manifest.lock',
  '      › Compiling ShipStudio » AppDelegate.swift',
  '      › Compiling expo-camera Pods/ExpoCamera » CameraView.swift',
  '',
  ' \x1b[38;5;173m✶\x1b[0m \x1b[2mBuilding… (3m 12s · esc to interrupt)\x1b[0m',
].join('\r\n');

function fakePty(screen: string) {
  let sent = false;
  return {
    'plugin:pty|spawn': 7,
    'plugin:pty|read': () => {
      if (sent) return new Promise<never>(() => {});
      sent = true;
      return screen;
    },
    'plugin:pty|exitstatus': () => new Promise<never>(() => {}),
    'plugin:pty|resize': null,
    'plugin:pty|write': null,
    'plugin:pty|kill': null,
    get_system_env: {},
    get_shell_path: '/bin/zsh',
    ensure_agent_workdir: '/Users/julian/ShipStudio',
  };
}

/**
 * Steps run before a scenario's command, so a flow that clicks on inside the
 * panel opens it the way a person does: Settings, Phone, Install….
 */
const OPEN: ScenarioStep[] = [
  { click: '.settings-menu [data-settings-item="app-settings"]' },
  { click: 'button[data-settings-open="phone"]' },
  { click: '[data-install-open]' },
];
const ANDROID: ScenarioStep = { click: 'button[aria-label="Android"]' };
const SET_UP: ScenarioStep = { click: '[data-install-route="build"]' };
const viaSettings = (...steps: ScenarioStep[]): Partial<Scenario> => ({
  command: undefined,
  openSelector: '[data-settings-menu-trigger]',
  steps: [...OPEN, ...steps],
});

const install = (
  id: string,
  title: string,
  looksRightWhen: string,
  commands: Record<string, unknown>,
  extra: Partial<Scenario> = {}
): Scenario => ({
  id,
  title,
  looksRightWhen,
  command: 'companion.install',
  requires: '.phone-modal--install',
  clipSelector: '.phone-modal',
  ...extra,
  commands: {
    // Read by Settings on the way through.
    get_terminal_gpu_enabled: true,
    companion_status: phoneStatus(),
    companion_install_ios_status: THIS_MAC,
    companion_install_android_status: ANDROID_THIS_MAC,
    ...commands,
  },
});

export const phoneInstallScenarios: Scenario[] = [
  install(
    'phone-install-choose',
    'Install on my phone — choose a route',
    '"Phone" back link on the left, iPhone | Android on the right. A dashed, quieter TestFlight ' +
      'card saying what it is, with a grey "Not available yet" pill instead of a button. Below, ' +
      '"Build it on this Mac" in a solid card, saying plainly it needs Xcode and an Apple ID and ' +
      'that a free Apple ID’s build stops after 7 days, with a primary "Set up".',
    {}
  ),
  install(
    'phone-install-xcode-old',
    'Install — iPhone checklist on this Mac: Xcode 26.1 is too old',
    'Checklist on the left: "Xcode 26.4 or later" with an amber ring and "You", saying this Mac ' +
      'has 26.1, with a primary "Update Xcode in the App Store" button. CocoaPods ticked green, ' +
      'the iPhone row amber (plug it in), Developer Mode and the build greyed as waiting, the ' +
      'Apple ID ticked with the team. Right: "Claude Code does the work", the 7-day note, and a ' +
      'disabled "Start Claude Code" with an amber line saying to update Xcode first.',
    {},
    viaSettings(SET_UP)
  ),
  install(
    'phone-install-no-phone',
    'Install — Xcode is fine, but no iPhone is plugged in',
    'Xcode, CocoaPods and the Apple ID ticked. "Your iPhone, plugged in" amber with how to ' +
      'connect and Trust. Developer Mode and the build waiting. "Start Claude Code" enabled.',
    { companion_install_ios_status: XCODE_OK },
    viaSettings(SET_UP)
  ),
  install(
    'phone-install-building',
    'Install — Claude Code building the app',
    'Checklist all green except "Built and installed", marked "Claude Code". On the right a ' +
      'terminal the same height as the start card, showing Claude Code checking, cloning and ' +
      'running expo run:ios with a Release configuration.',
    {
      companion_install_ios_status: { ...XCODE_OK, devices: [IPHONE] },
      companion_install_ios_app: NOT_INSTALLED,
      ...fakePty(AGENT_SCREEN),
    },
    viaSettings(SET_UP, { click: '[data-install-start]' })
  ),
  install(
    'phone-install-done',
    'Install — on the phone, with its expiry',
    'Every row green. Right: a green tick, "Ship Studio is on Julian’s iPhone", "Works until ' +
      '<a week from now>" and that Reinstall needs no agent, the Untrusted Developer fix in ' +
      'small grey text, and "Open on phone" / "Pair it now".',
    {
      companion_install_ios_status: { ...XCODE_OK, devices: [IPHONE] },
      companion_install_ios_app: {
        installed: true,
        version: '0.1.0',
        expiresAt: Date.now() + 7 * DAY,
      },
    },
    viaSettings(SET_UP)
  ),
  install(
    'phone-install-pairing',
    'Install — "Pair it now" goes straight to the pairing code',
    'Back in the Phone panel (title "Phone") with the QR code on screen, and a "Built on this ' +
      'Mac for Julian’s iPhone" row with when it stops working and Reinstall.',
    {
      companion_status: phoneStatus({
        enabled: true,
        running: true,
        serve: { state: 'on', url: `https://${DNS}:47443` },
        pairing: { active: true, expiresAt: Date.now() + 5 * 60_000 },
      }),
      companion_pair_start: {
        link: PHONE_PAIRING_LINK,
        qr: PHONE_QR,
        expiresAt: Date.now() + 5 * 60_000,
      },
      companion_install_ios_status: { ...XCODE_OK, devices: [IPHONE] },
      companion_install_ios_app: {
        installed: true,
        version: '0.1.0',
        expiresAt: Date.now() + 7 * DAY,
      },
    },
    {
      ...viaSettings(SET_UP, { click: '[data-install-pair]' }),
      requires: '[data-testid="phone-pair-code"]',
    }
  ),
  install(
    'phone-install-android',
    'Install — Android checklist on this Mac: tools present, no phone',
    'adb (with its version) and Java/SDK ticked. "Your phone, with USB debugging allowed" amber, ' +
      'with the Build-number-7-times instructions. The build waiting. No 7-day note; "Start ' +
      'Claude Code" enabled.',
    {},
    viaSettings(ANDROID, SET_UP)
  ),
  install(
    'phone-install-reinstall-entry',
    'Phone panel — a build from this Mac, with Reinstall',
    'Under the intro, a row "Built on this Mac for Julian’s iPhone", "Works until <date>. Plug ' +
      'it in to reinstall.", a quiet "Other phone" and a primary "Reinstall".',
    {},
    {
      command: 'companion.devices',
      requires: '[data-testid="phone-install-entry"]',
      storage: {
        'shipstudio.companionInstall': JSON.stringify({
          platform: 'ios',
          deviceName: 'Julian’s iPhone',
          deviceId: IPHONE.udid,
          teamId: 'H8NN6DM6G6',
          installedAt: Date.now() - 2 * DAY,
          expiresAt: Date.now() + 5 * DAY,
        }),
      },
    }
  ),
];
