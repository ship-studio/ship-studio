# Ship Studio for iPhone and Android

The mobile companion: your agents, chats and approvals from Ship Studio on your
Mac, over your own Tailscale tailnet. The Mac does the work; the phone is a
thin client. Design and protocol: [docs/mobile.md](../docs/mobile.md); wire
types: [packages/companion-protocol](../packages/companion-protocol/src/index.ts).

A standalone pnpm project (the desktop's install never touches it), linked to
the protocol package by path.

```bash
cd mobile
pnpm install
```

## Run it against the mock Mac (no desktop needed)

```bash
pnpm mock                       # a scripted Mac on https://localhost:47443
pnpm ios                        # build the dev client and open the simulator (first time)
npx expo start --dev-client     # afterwards: just the bundler
```

Expo SDK 58 needs **Xcode 26.4 or later** to build the dev client. With an
older Xcode, run the JS in Expo Go instead (no native build; the app's modules
are all in Expo Go): `npx expo start --go --ios`. Expo Go can't receive the
`shipstudio-companion://` scheme, so open pairing links as
`exp://<your-ip>:8081/--/pair?d=…` (the `d=` part of the mock's link).

The mock prints two one-time commands: trust its self-signed certificate in the
booted simulator, and open a pairing link there. Paired devices persist in
`dev/.certs/devices.json`, so restarting the mock (a new journal epoch, so the
phone resyncs from a snapshot) doesn't unpair. Its shapes come from the Mac's
generated fixtures (`packages/companion-protocol/src/fixtures.gen.ts`); the hidden
"Fixtures" agent shows every real message kind. A fresh link any time:
`curl -sk https://localhost:47443/dev/link`.

Things to try against it: send a message (a streamed reply), send "deploy"
(an approval card first), Stop while it streams, open Chief of Staff and scroll
up (paging).

## Run it on your phone

Build a development client onto a plugged-in iPhone (`pnpm ios --device`), or a
Release build that needs no bundler (`npx expo run:ios --device --configuration
Release`). Pair it with Ship Studio (Settings → Phone → Pair a phone) with
Tailscale on, on both the Mac and the phone.

To use the mock from a phone, serve it on your tailnet:

```bash
pnpm mock --http --port 47450 --public-url https://<mac>.<tailnet>.ts.net:47443
tailscale serve --bg --https=47443 http://127.0.0.1:47450
```

## Tests

```bash
pnpm test        # sync rules, markdown, and the transport against the mock Mac
pnpm typecheck
```

## Builds and updates (EAS)

`eas.json` has `development`, `development-simulator`, `preview`, `apk` and
`production` profiles; each maps to an `expo-updates` channel of the same name.
`app.config.ts` reads:

| Variable | Default | |
| --- | --- | --- |
| `SHIPSTUDIO_BUNDLE_ID` | `com.shipstudio.companion` | **Placeholder** until the App Store Connect record exists |
| `EAS_PROJECT_ID` | none | Without it, OTA updates are off, so an official update can never reach a fork |
| `UPDATES_URL` | `https://u.expo.dev/<project id>` | |

The runtime version uses the `fingerprint` policy, so a JS update only reaches
binaries that can run it. `submit.production` in `eas.json` holds placeholders
for the App Store Connect API key.
