/**
 * "Install on my phone": getting the Ship Studio companion app onto the
 * user's iPhone or Android phone.
 *
 * Two routes. The official build (TestFlight, or an APK) is a link, once the
 * maintainers publish one. Building it on this Mac follows the agent-led
 * onboarding pattern: Claude Code does the work in a terminal from a
 * prescriptive prompt, and the checklist is decided only by the app's own
 * checks (`commands/companion_install.rs`), never by the agent's say-so.
 *
 * Design: docs/mobile.md, "Installing the app".
 *
 * @module lib/companionInstall
 */

import { invoke } from '@tauri-apps/api/core';
import { agentPromptArgs } from './agent';
import type { TerminalCommand } from './setup';

export type InstallPlatform = 'ios' | 'android';

/**
 * The maintainers' public TestFlight link and the official APK. `null` until
 * they exist; the panel says "not available yet" rather than hiding the route.
 */
export const TESTFLIGHT_URL: string | null = null;
export const ANDROID_APK_URL: string | null = null;

/** Xcode in the Mac App Store; App Store updates are something only the user can do. */
export const XCODE_APP_STORE_URL = 'https://apps.apple.com/app/xcode/id497799835';

// ---- Backend shapes (commands/companion_install.rs) --------------------------

export type XcodeCheck =
  | { state: 'missing' }
  | { state: 'cltOnly' }
  | { state: 'tooOld'; version: string }
  | { state: 'needsFirstLaunch'; version: string }
  | { state: 'ok'; version: string };

export interface IosDevice {
  udid: string;
  name: string;
  model: string | null;
  osVersion: string | null;
  connected: boolean;
  paired: boolean;
  /** `enabled | disabled | unknown`, as devicectl says it. */
  developerMode: string;
}

export interface Signing {
  teamId: string;
  identity: string;
  bundleId: string;
}

export interface SourceCheck {
  path: string;
  present: boolean;
  installed: boolean;
  desktopVersion: string;
}

export interface IosInstallStatus {
  xcode: XcodeCheck;
  xcodeMinimum: string;
  clt: boolean;
  cocoapods: string | null;
  node: string | null;
  devices: IosDevice[];
  signing: Signing | null;
  source: SourceCheck;
}

export interface AndroidPhone {
  serial: string;
  state: string;
  model: string | null;
}

export interface AndroidInstallStatus {
  adb: string | null;
  sdk: boolean;
  jdk: boolean;
  node: string | null;
  devices: AndroidPhone[];
  package: string;
  source: SourceCheck;
}

export interface InstalledApp {
  /** null: the phone couldn't be asked (locked, Developer Mode off). */
  installed: boolean | null;
  version: string | null;
  expiresAt: number | null;
}

export const getIosInstallStatus = () => invoke<IosInstallStatus>('companion_install_ios_status');
export const getAndroidInstallStatus = () =>
  invoke<AndroidInstallStatus>('companion_install_android_status');
export const getIosApp = (udid: string, teamId: string) =>
  invoke<InstalledApp>('companion_install_ios_app', { udid, teamId });
export const getAndroidApp = (serial: string) =>
  invoke<InstalledApp>('companion_install_android_app', { serial });
export const launchIosApp = (udid: string, teamId: string) =>
  invoke<void>('companion_install_ios_launch', { udid, teamId });
const remind = (title: string, body: string) =>
  invoke<void>('companion_install_remind', { title, body });

// ---- The checklist -----------------------------------------------------------

/**
 * `done`: verified by our own check. `agent`: Claude Code does it.
 * `you`: only the user can (the App Store, a tap on the phone).
 * `waiting`: depends on an earlier row.
 */
export type StepState = 'done' | 'agent' | 'you' | 'waiting';

export interface InstallStep {
  id: string;
  title: string;
  detail: string;
  state: StepState;
  /** The one thing the user can click for this row: the App Store, for Xcode. */
  appStore?: string;
}

/** The phone the build targets: a connected one, a trusted one first. */
export function pickIosDevice(s: IosInstallStatus): IosDevice | null {
  const connected = s.devices.filter((d) => d.connected);
  return connected.find((d) => d.paired) ?? connected[0] ?? null;
}

export function pickAndroidPhone(s: AndroidInstallStatus): AndroidPhone | null {
  return s.devices.find((d) => d.state === 'device') ?? s.devices[0] ?? null;
}

/** Xcode is the one thing the agent can't fix: the App Store is the user's. */
export function xcodeBlocks(s: IosInstallStatus): boolean {
  return s.xcode.state !== 'ok' && s.xcode.state !== 'needsFirstLaunch';
}

function xcodeStep(s: IosInstallStatus): InstallStep {
  const title = `Xcode ${s.xcodeMinimum} or later`;
  switch (s.xcode.state) {
    case 'ok':
      return { id: 'xcode', title, detail: `Xcode ${s.xcode.version}`, state: 'done' };
    case 'needsFirstLaunch':
      return {
        id: 'xcode',
        title,
        detail: `Xcode ${s.xcode.version} needs its license accepted. The agent runs it; you type your Mac password.`,
        state: 'agent',
      };
    case 'tooOld':
      return {
        id: 'xcode',
        title,
        detail: `This Mac has Xcode ${s.xcode.version}. Update it in the App Store, then come back. The agent can’t do App Store updates.`,
        state: 'you',
        appStore: 'Update Xcode in the App Store',
      };
    case 'cltOnly':
    case 'missing':
      return {
        id: 'xcode',
        title,
        detail:
          s.xcode.state === 'cltOnly'
            ? 'Only the Command Line Tools are here, and they can’t build for a phone. Install Xcode from the App Store.'
            : 'Install Xcode from the App Store. It’s large, so it takes a while.',
        state: 'you',
        appStore: 'Get Xcode in the App Store',
      };
  }
}

export function iosSteps(s: IosInstallStatus, app: InstalledApp | null): InstallStep[] {
  const device = pickIosDevice(s);
  const toolsReady = s.clt && s.cocoapods !== null && s.node !== null;
  const missingTools = [
    !s.clt && 'Command Line Tools',
    s.cocoapods === null && 'CocoaPods',
    s.node === null && 'Node',
  ].filter(Boolean);

  const phone: InstallStep = device
    ? device.paired
      ? { id: 'phone', title: 'Your iPhone, plugged in', detail: device.name, state: 'done' }
      : {
          id: 'phone',
          title: 'Your iPhone, plugged in',
          detail: `Unlock ${device.name} and tap Trust when it asks about this Mac.`,
          state: 'you',
        }
    : {
        id: 'phone',
        title: 'Your iPhone, plugged in',
        detail: 'Connect it with a cable and unlock it. Tap Trust if it asks about this Mac.',
        state: 'you',
      };

  const devMode: InstallStep =
    device?.paired && device.developerMode === 'enabled'
      ? { id: 'devmode', title: 'Developer Mode on', detail: 'On', state: 'done' }
      : {
          id: 'devmode',
          title: 'Developer Mode on',
          detail: device?.paired
            ? 'On the phone: Settings → Privacy & Security → Developer Mode → On. It restarts; tap Turn On after.'
            : 'Turned on in the phone’s settings once it’s plugged in.',
          state: device?.paired ? 'you' : 'waiting',
        };

  const signing: InstallStep = s.signing
    ? {
        id: 'signing',
        title: 'Signed in to Xcode with your Apple ID',
        detail: `Team ${s.signing.teamId}`,
        state: 'done',
      }
    : {
        id: 'signing',
        title: 'Signed in to Xcode with your Apple ID',
        detail: 'Xcode → Settings → Accounts → + → Apple ID. A free Apple ID works.',
        state: 'you',
      };

  const installed = app?.installed === true;
  const build: InstallStep = installed
    ? {
        id: 'build',
        title: 'Built and installed',
        detail: device ? `On ${device.name}` : 'On your phone',
        state: 'done',
      }
    : {
        id: 'build',
        title: 'Built and installed',
        detail: 'A Release build, so it runs without this Mac’s bundler. Takes a few minutes.',
        state: xcodeBlocks(s) || !device ? 'waiting' : 'agent',
      };

  return [
    xcodeStep(s),
    {
      id: 'tools',
      title: 'CocoaPods and the Command Line Tools',
      detail: toolsReady
        ? `CocoaPods ${s.cocoapods ?? ''}`.trim()
        : `The agent installs ${missingTools.join(', ')}.`,
      state: toolsReady ? 'done' : 'agent',
    },
    phone,
    devMode,
    signing,
    build,
  ];
}

export function androidSteps(s: AndroidInstallStatus, app: InstalledApp | null): InstallStep[] {
  const phone = pickAndroidPhone(s);
  const phoneStep: InstallStep =
    phone?.state === 'device'
      ? {
          id: 'phone',
          title: 'Your phone, with USB debugging allowed',
          detail: phone.model ?? phone.serial,
          state: 'done',
        }
      : phone?.state === 'unauthorized'
        ? {
            id: 'phone',
            title: 'Your phone, with USB debugging allowed',
            detail: 'Tap Allow on the phone’s “Allow USB debugging?” prompt.',
            state: 'you',
          }
        : {
            id: 'phone',
            title: 'Your phone, with USB debugging allowed',
            detail:
              s.adb === null
                ? 'Once adb is installed, plug in your phone.'
                : 'Settings → About phone → tap Build number 7 times. Then Developer options → USB debugging on, and plug it in.',
            state: s.adb === null ? 'waiting' : 'you',
          };
  const installed = app?.installed === true;
  return [
    {
      id: 'adb',
      title: 'Android platform tools (adb)',
      detail: s.adb ?? 'The agent installs them.',
      state: s.adb ? 'done' : 'agent',
    },
    {
      id: 'toolchain',
      title: 'Java 17 and the Android SDK',
      detail:
        s.jdk && s.sdk
          ? 'Found'
          : `The agent installs ${[!s.jdk && 'Java 17', !s.sdk && 'the Android SDK'].filter(Boolean).join(' and ')}.`,
      state: s.jdk && s.sdk ? 'done' : 'agent',
    },
    phoneStep,
    installed
      ? {
          id: 'build',
          title: 'Built and installed',
          detail: `On ${phone?.model ?? 'your phone'}`,
          state: 'done',
        }
      : {
          id: 'build',
          title: 'Built and installed',
          detail: 'A release APK, installed over the cable. Takes a few minutes.',
          state: phone?.state === 'device' ? 'agent' : 'waiting',
        },
  ];
}

// ---- The agent's instructions ------------------------------------------------

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const REPO = 'https://github.com/ship-studio/ship-studio.git';

/** Get the source to `path` (its parent is the checkout) if it isn't there. */
function sourceInstruction(src: SourceCheck): string {
  if (src.present) {
    return src.installed
      ? `The app's source is already at ${src.path}.`
      : `The app's source is at ${src.path}; install its dependencies there with \`pnpm install\` (if pnpm is missing, \`npm install -g pnpm\` first).`;
  }
  const root = src.path.replace(/\/mobile\/?$/, '');
  return (
    `First fetch the app's source, matching this Ship Studio version: ` +
    `\`git clone --depth 1 --filter=blob:none --sparse --branch v${src.desktopVersion} ${REPO} ${sh(root)} && cd ${sh(root)} && git sparse-checkout set mobile packages/companion-protocol\`, ` +
    `then in ${src.path} run \`pnpm install\` (if pnpm is missing, \`npm install -g pnpm\` first).`
  );
}

/** The one command that builds and installs: also what Reinstall runs. */
export function iosBuildCommand(s: IosInstallStatus, device: IosDevice): string | null {
  if (!s.signing) return null;
  const env = `SHIPSTUDIO_BUNDLE_ID=${s.signing.bundleId} APPLE_TEAM_ID=${s.signing.teamId}`;
  return (
    `cd ${sh(s.source.path)} && ${env} npx expo prebuild -p ios --clean && ` +
    `${env} npx expo run:ios --device ${device.udid} --configuration Release`
  );
}

export function androidBuildCommand(s: AndroidInstallStatus, phone: AndroidPhone): string {
  const env = `SHIPSTUDIO_BUNDLE_ID=${s.package}`;
  return (
    `cd ${sh(s.source.path)} && ${env} npx expo prebuild -p android --clean && ` +
    `${env} npx expo run:android --variant release --device ${phone.serial}`
  );
}

/**
 * The agent's opening message for an iPhone build. One line: a multi-line
 * argv doesn't survive every PTY spawn shape. Prescriptive: the exact
 * commands, what to ask the user to do by hand, and that the checklist, not
 * the agent, decides when it's done.
 */
export function buildIosInstallPrompt(s: IosInstallStatus): string {
  const device = pickIosDevice(s);
  const env = s.signing
    ? `SHIPSTUDIO_BUNDLE_ID=${s.signing.bundleId} APPLE_TEAM_ID=${s.signing.teamId}`
    : 'SHIPSTUDIO_BUNDLE_ID=studio.ship.companion.<first 6 hex characters of the sha256 of the team id> APPLE_TEAM_ID=<team id>';
  const target = device ? device.udid : '<the phone’s UDID from `xcrun devicectl list devices`>';
  return (
    'You are installing the Ship Studio companion app on the user’s iPhone, built from source on this Mac. ' +
    'Be brief and plain: before each step, say in one sentence what you are about to do. ' +
    'Ship Studio shows a checklist beside this terminal and verifies every item with its own checks, so do not claim success; tell the user to look at the checklist. ' +
    `Check first: \`xcodebuild -version\` (needs ${s.xcodeMinimum} or later; if it is older, stop and tell the user to update Xcode in the App Store, which you cannot do), \`xcodebuild -checkFirstLaunchStatus\` (if it fails, run \`sudo xcodebuild -runFirstLaunch\` and warn that macOS asks for their password and shows nothing while they type), \`pod --version\` (if missing, \`brew install cocoapods\`), \`node --version\`. ` +
    'Things only the user can do, so ask them and wait: plug the iPhone in with a cable, unlock it and tap Trust; turn on Developer Mode (Settings → Privacy & Security → Developer Mode, the phone restarts, then tap Turn On); add their Apple ID in Xcode → Settings → Accounts if `security find-identity -v -p codesigning` lists no "Apple Development" identity (a free Apple ID works). ' +
    sourceInstruction(s.source) +
    ' ' +
    `Then build and install a Release build (it bundles the JavaScript, so it runs without a bundler): in ${s.source.path} run \`${env} npx expo prebuild -p ios --clean\`, then \`${env} npx expo run:ios --device ${target} --configuration Release\`. Use exactly that bundle id: Ship Studio checks the phone for it. ` +
    'If signing fails, read the error and explain it plainly; with a free Apple ID, Xcode may need to be opened once with the generated ios/*.xcworkspace to pick the team under Signing & Capabilities. ' +
    'When it is installed, tell the user: with a free Apple ID the app stops opening after 7 days and Ship Studio has a one-click Reinstall; the first launch may say "Untrusted Developer", fixed on the phone in Settings → General → VPN & Device Management → their Apple ID → Trust. ' +
    'Do not change any of the app’s source code and do not set up anything unrelated.'
  );
}

export function buildAndroidInstallPrompt(s: AndroidInstallStatus): string {
  const phone = pickAndroidPhone(s);
  const target = phone ? phone.serial : '<the serial from `adb devices`>';
  return (
    'You are installing the Ship Studio companion app on the user’s Android phone, built from source on this Mac. ' +
    'Be brief and plain: before each step, say in one sentence what you are about to do. ' +
    'Ship Studio shows a checklist beside this terminal and verifies every item with its own checks, so do not claim success; tell the user to look at the checklist. ' +
    'Check first: `adb version` (if missing, `brew install --cask android-platform-tools`), Java 17 (`/usr/libexec/java_home -v 17`; if missing, `brew install --cask zulu@17`), and the Android SDK at $ANDROID_HOME or ~/Library/Android/sdk (if missing, `brew install --cask android-commandlinetools`, then `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"`). Export JAVA_HOME and ANDROID_HOME for the build. ' +
    'Things only the user can do, so ask them and wait: on the phone, Settings → About phone → tap Build number 7 times, then Settings → Developer options → USB debugging on; plug it in and tap Allow on "Allow USB debugging?". `adb devices` must show it as `device`, not `unauthorized`. ' +
    sourceInstruction(s.source) +
    ' ' +
    `Then build and install a release APK: in ${s.source.path} run \`SHIPSTUDIO_BUNDLE_ID=${s.package} npx expo prebuild -p android --clean\`, then \`SHIPSTUDIO_BUNDLE_ID=${s.package} npx expo run:android --variant release --device ${target}\`. If that build can’t install, \`adb -s ${target} install -r\` the APK it produced under android/app/build/outputs/apk/release/. Use exactly that package name: Ship Studio checks the phone for it. ` +
    'When it is installed, tell the user it does not expire. ' +
    'Do not change any of the app’s source code and do not set up anything unrelated.'
  );
}

export function claudeInstallSpawn(prompt: string): TerminalCommand {
  return { command: 'claude', args: agentPromptArgs('claude', prompt) };
}

/** Reinstall: the build step alone, in a login shell, with no agent. */
export function shellSpawn(command: string): TerminalCommand {
  return { command: '/bin/zsh', args: ['-ilc', command] };
}

// ---- What was installed, and when it stops working --------------------------

export interface InstallRecord {
  platform: InstallPlatform;
  deviceName: string;
  /** iOS UDID or adb serial. */
  deviceId: string;
  teamId?: string;
  installedAt: number;
  /** iOS only: when the profile stops the app opening. */
  expiresAt?: number;
  /** The expiry the reminder already fired for. */
  remindedFor?: number;
}

const RECORD_KEY = 'shipstudio.companionInstall';
const DAY = 24 * 60 * 60 * 1000;
/** A free Apple ID's profile lasts 7 days; a paid one's, a year. */
export const FREE_TEAM_DAYS = 7;

export function readInstallRecord(): InstallRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    return raw ? (JSON.parse(raw) as InstallRecord) : null;
  } catch {
    return null;
  }
}

export function saveInstallRecord(record: InstallRecord) {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(record));
  } catch {
    // Storage off: the panel still works; only the reminder is lost.
  }
}

/** Within the last day before expiry, and not reminded for this expiry yet. */
export function reminderDue(r: InstallRecord | null, now: number): boolean {
  if (!r?.expiresAt || r.remindedFor === r.expiresAt) return false;
  return now >= r.expiresAt - DAY && now < r.expiresAt;
}

/** Fire the reminder once if it's due. */
export async function remindIfDue(now = Date.now()) {
  const r = readInstallRecord();
  if (!r || !reminderDue(r, now)) return;
  await remind(
    'Ship Studio stops opening on your phone tomorrow',
    `The build on ${r.deviceName} was signed with a free Apple ID. Plug it in and click Reinstall in Ship Studio → Phone.`
  );
  saveInstallRecord({ ...r, remindedFor: r.expiresAt });
}

/** "Tue 11 Nov". */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** "Works until Tue 11 Nov", or that it has stopped. */
export function expiryLine(expiresAt: number, now: number): string {
  return expiresAt > now
    ? `Works until ${formatDay(expiresAt)}`
    : `Stopped opening on ${formatDay(expiresAt)}`;
}

/** A profile under 8 days long came from a free Apple ID. */
export function isFreeTeamExpiry(r: Pick<InstallRecord, 'installedAt' | 'expiresAt'>): boolean {
  return r.expiresAt !== undefined && r.expiresAt - r.installedAt < (FREE_TEAM_DAYS + 1) * DAY;
}

/**
 * Cmd+K "Install Ship Studio on my phone" opens the Phone panel straight
 * onto the install flow. The panel takes the request once, when it opens.
 */
let installOnOpen = false;

export function requestInstallOnOpen() {
  installOnOpen = true;
}

export function takeInstallOnOpen(): boolean {
  const wanted = installOnOpen;
  installOnOpen = false;
  return wanted;
}

// ---- One read of everything the checklist needs -------------------------------

export type InstallState =
  | { platform: 'ios'; status: IosInstallStatus; app: InstalledApp | null }
  | { platform: 'android'; status: AndroidInstallStatus; app: InstalledApp | null };

/** The checks, then — when there's a phone to ask — whether the app is on it. */
export async function loadInstallState(platform: InstallPlatform): Promise<InstallState> {
  if (platform === 'ios') {
    const status = await getIosInstallStatus();
    const device = pickIosDevice(status);
    const app =
      device?.paired && status.signing ? await getIosApp(device.udid, status.signing.teamId) : null;
    return { platform, status, app };
  }
  const status = await getAndroidInstallStatus();
  const phone = pickAndroidPhone(status);
  const app = phone?.state === 'device' ? await getAndroidApp(phone.serial) : null;
  return { platform, status, app };
}

export function installSteps(s: InstallState): InstallStep[] {
  return s.platform === 'ios' ? iosSteps(s.status, s.app) : androidSteps(s.status, s.app);
}

/** The phone the build targets, by name and id, for the record and the copy. */
export function installTarget(s: InstallState): { name: string; id: string } | null {
  if (s.platform === 'ios') {
    const d = pickIosDevice(s.status);
    return d ? { name: d.name, id: d.udid } : null;
  }
  const p = pickAndroidPhone(s.status);
  return p?.state === 'device' ? { name: p.model ?? p.serial, id: p.serial } : null;
}

/** Reinstall's command, when there's a phone and (on iOS) a team to build for. */
export function reinstallCommand(s: InstallState): string | null {
  if (s.platform === 'ios') {
    const d = pickIosDevice(s.status);
    return d?.paired ? iosBuildCommand(s.status, d) : null;
  }
  const p = pickAndroidPhone(s.status);
  return p?.state === 'device' ? androidBuildCommand(s.status, p) : null;
}

export function installPrompt(s: InstallState): string {
  return s.platform === 'ios'
    ? buildIosInstallPrompt(s.status)
    : buildAndroidInstallPrompt(s.status);
}

/** Only an outdated or missing Xcode stops the agent starting. */
export function agentBlocked(s: InstallState): boolean {
  return s.platform === 'ios' && xcodeBlocks(s.status);
}
