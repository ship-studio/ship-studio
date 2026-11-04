import type { ExpoConfig } from 'expo/config';

/**
 * Official builds set all three in EAS; forks and self-builds set their own
 * (docs/mobile.md, "Forks and self-builds"). With no EAS_PROJECT_ID, OTA
 * updates are off, so an official update can never land on a fork's binary.
 */
const projectId = process.env.EAS_PROJECT_ID;
// PLACEHOLDER: the official bundle id is not registered yet. Replace once the
// owner's App Store Connect team has the app record.
const bundleId = process.env.SHIPSTUDIO_BUNDLE_ID ?? 'com.shipstudio.companion';
// A build on the user's own Mac signs with their team (Ship Studio → Phone →
// Install on my phone sets it); unset, Xcode's own signing settings apply.
const appleTeamId = process.env.APPLE_TEAM_ID;
const updatesUrl = process.env.UPDATES_URL ?? (projectId ? `https://u.expo.dev/${projectId}` : '');

const SURFACE_APP = '#141414'; // --surface-app

export default (): ExpoConfig => ({
  name: 'Ship Studio',
  slug: 'shipstudio-companion',
  scheme: 'shipstudio-companion',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  backgroundColor: SURFACE_APP,
  runtimeVersion: { policy: 'fingerprint' },
  updates: projectId
    ? { enabled: true, url: updatesUrl, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 }
    : { enabled: false },
  ios: {
    bundleIdentifier: bundleId,
    ...(appleTeamId ? { appleTeamId } : {}),
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // So the app can tell whether the Tailscale app is installed before opening it.
      LSApplicationQueriesSchemes: ['tailscale'],
    },
  },
  android: {
    package: bundleId,
    adaptiveIcon: { foregroundImage: './assets/icon.png', backgroundColor: SURFACE_APP },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-font',
    [
      'expo-splash-screen',
      { image: './assets/splash-icon.png', imageWidth: 96, backgroundColor: SURFACE_APP },
    ],
    [
      'expo-camera',
      {
        cameraPermission: 'Ship Studio uses the camera to scan the pairing code on your Mac.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    ['expo-notifications', { color: '#46e76f' }],
  ],
  experiments: { typedRoutes: true },
  extra: {
    official: Boolean(projectId),
    ...(projectId ? { eas: { projectId } } : {}),
  },
});
