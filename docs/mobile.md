# Mobile companion

Ship Studio on your phone. The Mac does all the work and the phone is a thin
client paired by QR code. You get the same agents, chats, approvals and
check-ins as on the desk, in sync both ways, over your own Tailscale tailnet
or your home network.

This is the build spec for two builders working in parallel: the **desktop
server** (`src-tauri/src/companion/`) and the **Expo app** (`mobile/`). Both
import the wire types from [`packages/companion-protocol`](../packages/companion-protocol/src/index.ts).
Where this doc and the types disagree, fix whichever is wrong in the same
commit.

## Goals

- **Parity with the Agents view, kept in sync.** This covers:
  - the agent list with status, unread and needs-you;
  - chat with streaming drafts, attachments both ways, quotes and @mentions;
  - approvals, including Always allow and Deny with note;
  - Stop and Interrupt;
  - check-ins and routines;
  - files and search;
  - projects, their sessions, and preview screenshots;
  - import by paste;
  - on-device dictation.

  Reading a chat on the phone clears its unread count on the Mac, and the
  other way round.
- **Always clear what's connected.** The phone shows whether the Mac can be
  reached, whether it's awake, whether Ship Studio is running, whether Claude
  Code is signed in, what each agent can use, and which devices are paired.
  When something can't be known, the screen says "unknown" rather than guessing.
- **Nothing in the middle.** The phone talks to the Mac directly, over the
  tailnet or the LAN. Funnel is not used and nothing of ours is involved.
- **Installs in minutes, with no App Store.**
- **Mirror, don't invent.** Every method is an existing Tauri command, and
  every journaled event mirrors an existing desktop event (`agents://*`) or the
  state behind one.

## Non-goals (for now)

- **App Store or Play Store listing.** TestFlight and a sideloaded APK at
  launch.
- **Real push notifications.** These need a relay. See [Notifications](#notifications).
- **Pushing to git from the phone.** Remote Access gates pushing behind a PIN
  and Agents behind a chat card. The phone gets neither until the owner
  decides (see the open questions).
- **Managing other devices from the phone.** Only the Mac can revoke devices.
- **Desktop-only surfaces:** the Apps modal, Open in Finder, and editing code.
- **Driving a plain terminal.** As in Remote Access, text goes only to agent
  tabs.

## Architecture

```
 iPhone / Android (Expo)                              Mac (Ship Studio, Tauri)
┌───────────────────────────┐                ┌────────────────────────────────────────────┐
│ screens                   │                │ companion::server (hyper)                  │
│   │                       │   tailnet      │   127.0.0.1:P  ◀── tailscale serve         │
│ store (SQLite cache,      │  HTTPS (ts.net │                    --https=47443 (no Funnel)│
│   cursor, outbox)         │ ──cert)──────▶ │   0.0.0.0:47444  rustls, self-signed,      │
│   │                       │                │                  pinned (LAN, opt-in)      │
│ Transport ── Direct ──────┤ ── LAN HTTPS ─▶│        │                                   │
│   (future: Relay)         │   (pinned)     │   auth (device tokens) · rate limit · audit│
│                           │                │        │                                   │
│ expo-notifications (local)│ ◀── alert ──── │ hub: journal (epoch, seq) ◀── listen_any:  │
│ expo-speech-recognition   │                │        agents://message|status|registry|   │
│   (on-device)             │                │        agents://draft                      │
└───────────────────────────┘                │        │                                   │
                                             │ router ─▶ commands/agents.rs (same fns)    │
                                             │        ─▶ remote_access::tools (sessions,  │
                                             │           screenshots; same refusals)      │
                                             └────────────────────────────────────────────┘
```

**Server module layout** (`src-tauri/src/companion/`):

| File | Contents |
| --- | --- |
| `mod.rs` | Config and the device registry (`companion.json`, 0600), lifecycle |
| `server.rs` | Both listeners, HTTP routes, WebSocket upgrade |
| `pairing.rs` | Codes, the desk confirmation, token issue |
| `hub.rs` | Event journal, fan-out, drafts |
| `router.rs` | `method` → command function |
| `notifier.rs` | The `Notifier` trait and the live-socket implementation |
| `tls.rs` | The LAN certificate |
| `blobs.rs` | Staging uploads and serving files |

The router calls the **command functions** in `commands/agents.rs`, not the
store. That way the logic the desk runs is the logic the phone runs: emits,
badge refresh, the "Always allow" covering pass. Commands that take a
`WebviewWindow` (`agents_focus`) get a device-scoped variant. `notify::set_showing`
already keys by an opaque label, so the server uses `companion:<deviceId>`.

**Projects and sessions** reuse Remote Access's handlers in
`remote_access/tools.rs`. Those handlers return MCP text today. The builder
splits each one into a structured core that returns `ProjectSummary`,
`SessionScreen` and the rest, plus the existing MCP formatter on top. Remote
Access then keeps working unchanged and the phone gets data instead of prose.

## Transport: one WebSocket, plus HTTP for files

Everything except file bytes goes over one WebSocket: requests, responses and
events (see [`frames.ts`](../packages/companion-protocol/src/frames.ts)).

**Why WebSocket and not SSE:**

- React Native has WebSocket built in. SSE needs a polyfill, plus a second
  channel for requests.
- One socket gives one ordering domain. An event caused by a request can't be
  overtaken by that request's response, and resync reasons about a single
  stream.
- Auth happens once per connection, and revoking a device closes the socket
  immediately.
- A future relay can forward a frame stream opaquely.

**Files go over HTTP** (`PUT /v1/blobs`, `GET /v1/blobs/:id`,
`GET /v1/agents/:id/attachments/*`). Base64 inside JSON frames would inflate
files by a third, and a 25 MB upload would hold up every message behind it.
HTTP also supports `Range` for resuming downloads and `?w=` for thumbnails.

**Requests** are JSON-RPC-like: `{t:'req', id, method, params}` gets back
`{t:'res', id, ok, result|error}`. Errors are the desktop's `CommandError`
plus a `Protocol` variant, so the app can reuse `humanize`-style copy.

**Heartbeat.** The Mac pings every 15 s. If the phone hears nothing for 40 s,
it treats the link as dead. That catches sleep and Wi-Fi handoffs faster than
TCP does.

**Limits.** These are Remote Access's limits, adjusted for an interactive
client:

- 600 requests per minute per device
- 4 sockets per device and 16 sockets in total
- 1 MB frames
- 25 MB per file and 10 files per message (`MAX_ATTACHMENT*`)
- a 10 s header read timeout

## Routes, TLS, and why LAN is pinned, not "unencrypted"

| Route | How | TLS |
| --- | --- | --- |
| **Tailscale** (default) | `tailscale serve --bg --https=47443 http://127.0.0.1:P`, tailnet only | The real `*.ts.net` certificate, terminated by `tailscaled`. Stock `fetch` and `WebSocket` work with no native code. |
| **Local network** (opt-in on the Mac) | `0.0.0.0:47444`, served by rustls | A self-signed ECDSA P-256 certificate generated once. The QR code carries its SPKI SHA-256 and the phone pins exactly that key. |

Rules for the Tailscale route:

- **The port is deliberately not 443, 8443 or 10000.** Those are the only
  ports Funnel can publish. Funnel is enabled per port, and Remote Access
  already funnels 443. A mount on that port would be one toggle away from
  the public internet.
- **The server edits only its own port's handler** in the serve config.
- **If HTTPS certificates are off on the tailnet**, setup asks the user to
  turn them on, as Remote Access does. The LAN route also works over the
  tailnet IP.

**Why plain HTTP is never offered on the LAN.** The device token goes over
this link, and the token controls your agents: anyone on the same café Wi-Fi
could read it. A warning wouldn't make that safe. Pinning is cheap here
because the QR code is already an out-of-band channel to the phone, which
means:

- no CA to install;
- no trust-on-first-use;
- regenerating the key means pairing again, which is the right outcome.

**The cost of pinning** is a small Expo native module, `mobile/modules/pinned-transport`:

- **iOS:** `URLSession` and `URLSessionWebSocketTask`, whose delegate checks
  the SPKI.
- **Android:** an OkHttp client with a `TrustManager` that accepts only the
  pinned key, installed through `OkHttpClientProvider` so that both `fetch`
  and `WebSocket` use it.

The phone tries routes in this order: the one that last worked, then
Tailscale, then LAN. A LAN route that fails away from home is skipped until
the network changes. The phone also learns new routes from `system.status`,
for example a new DHCP address. **Bonjour discovery (`_shipstudio._tcp`) is
P3.**

iOS asks for Local Network permission on the first LAN connection.
`NSLocalNetworkUsageDescription` explains why.

## Pairing

1. **On the Mac:** Settings → **Phone** → **Pair a phone**, or Cmd+K → "Pair a
   phone". The Mac makes a one-time code (128-bit, base32, valid for 5 minutes,
   single use) and shows a QR code of `shipstudio-companion://pair?d=…`. The
   link carries the code, server id, Mac name and routes, plus the certificate
   pin for a LAN route. It holds **no long-lived secret** (`PairingLink`).
2. **On the phone:** scan the code with the in-app scanner, or with the
   Camera, whose custom scheme opens the app. Pasting the link also works. The
   phone generates an X25519 key pair and sends `POST /v1/pair`
   (`PairRequest`).
3. **On the Mac:** the QR modal changes to "Allow **Julian's iPhone** to use
   your agents?" with **Allow** and **Deny**. The request stays open for up to
   120 s.
   - This closes the gap left by a QR code photographed over your shoulder.
     T3 Code has no such step, and we think it should.
   - The prompt shows the requesting device's name and model, so a
     stranger's phone shows up as a device you don't recognise.
4. **On Allow:** the Mac returns a 256-bit device token (`PairResponse`) and
   stores only its SHA-256. The phone saves the token in `expo-secure-store`
   (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it is excluded from backups) and
   connects.
5. **Pairing again** with the same `serverId` replaces this Mac's earlier
   entry on the phone. On the Mac, the old token for that phone is revoked
   when the new pairing is allowed. Re-pairing doesn't stack up duplicate
   devices.

Code checks are made in constant time. A wrong code gets a bare 404 after a
400 ms delay, as in Remote Access. Five failures within the code's lifetime
burn the code.

## Auth and revocation

- **HTTP** requests carry `Authorization: Bearer <token>`.
- **The WebSocket** sends the token in its first frame (`hello.token`), never
  in the URL, so no proxy or log ever records it.
- **The device list** is on the Mac only: Settings → Phone. For each device it
  shows:
  - name, platform and app version;
  - official or self-built;
  - last seen, and over which route;
  - "connected now";
  - the expiry date for free-Apple-ID builds.
- **Revoke** deletes the token hash and closes that device's sockets at once.
  The token is re-checked on every frame, the way Remote Access re-checks
  "off" on every request. The phone shows "This Mac removed this phone" and
  offers to pair again.
- **Turning the companion off** stops both listeners and removes the serve
  handler. Paired devices are kept, so turning it back on needs no re-pairing.

**Audit.** Every action goes through `remote_access::audit_as` into the same
`remote_audit.jsonl`:

- **Actor:** `"Phone · Julian's iPhone"`.
- **Tool:** the method name.
- **Detail:** a preview, as in Remote Access.

The same rules apply: pure reads (`READ_ONLY_METHODS`) are not logged, and
neither is a token. Pairing, denials, revocations, refusals and connects are
logged. The Remote Access activity list filters by actor, and the Phone panel
shows that device's entries.

**Text refusals.** `agents.send`, `sessions.send` and `sessions.start` all apply
`sanitize_message` and `check_message_kind`, meaning:

- no control characters;
- no leading `!`;
- `/` commands only from the allowlist;
- at most 20k characters;
- an opening prompt never starts with `-` (`not_a_flag`).

For sessions they run through the shared handlers unchanged, which also
restricts them to agent tabs. On the phone, `agents.send` is therefore
slightly stricter than on the desk. That's deliberate: the phone is a remote
surface. A refusal comes back as `Protocol/refused` with the sentence to show.

## Events, cursors and resync

The **hub** subscribes to the desktop's own events with `app.listen_any`. It
stamps each journaled event with a `seq` that only ever increases, and keeps
the events in an in-memory **journal** (24 h or 20k entries) under a random
**epoch** created at app start. Replay rules are listed per event type in
[`events.ts`](../packages/companion-protocol/src/events.ts):

| Event type | What replay keeps |
| --- | --- |
| Messages | every message |
| `status`, `registry`, `projects`, `system` | only the latest per key |
| Drafts and alerts | nothing (ephemeral) |

**The phone stores a cursor `{epoch, seq}`** once an event has been applied
and persisted. That ordering means a crash between the two can only cause a
re-apply, which is harmless, never a gap.

**On connect,** the phone sends `hello.resume = cursor`:

- **Same epoch, and `seq` still in the journal:** the Mac sends
  `welcome{resume:'replay'}`, then every journaled event after the cursor in
  order, then `sync.caughtUp`. **Nothing is missed.**
- **Otherwise** (the app restarted, or the phone was away more than 24 h):
  the Mac sends `welcome{resume:'snapshot'}`, then `sync.snapshot` with the
  overview, Mac status, projects and the current cursor, then `sync.caughtUp`.
  The phone re-fetches the chats it has cached.

**Why nothing is ever duplicated:**

- **Messages are upserts by id.** An approval that is answered is re-emitted
  with the same id and replaces the card.
- **Sends are idempotent.** `agents.send` requires a `clientId`. The Mac
  remembers `clientId → message` for 24 h, so a send retried after a dropped
  connection returns the original message instead of sending it twice.

**The stale-read race.** A message fetched by `agents.messages` can be older
than an event that already arrived (an approval answered mid-fetch). So the
response carries `asOf`, the cursor at read time. The phone keeps each
message's last-applied `seq` and **overwrites only rows whose `seq` ≤
`asOf.seq`**.

**Drafts** are appended text: `{id, from, text}`.

- The Mac tracks, per connection, how much of each draft it has sent. It
  starts from 0 on a new connection and is throttled to 100 ms.
- If `from` doesn't match the phone's length, the phone drops the draft. The
  next frame from 0, or the final `agents.message` with the same id, puts it
  right.
- The desktop's drafts resend the whole text every 40 ms. Over cellular, on a
  long reply, that is most of the traffic, which is why the phone gets
  appends instead.

## Offline cache and outbox

The phone keeps an `expo-sqlite` database for each Mac:

- the overview and Mac status;
- the last 400 messages of each chat that has been opened, plus each
  message's `seq`;
- the cursor and file metadata.

Attachments and screenshots go in a size-capped (LRU, 300 MB) cache in the
cache directory.

**When offline,** everything cached is readable under a "Last synced 3:12 PM"
bar, and all actions are disabled.

**A message typed offline** stays in the composer as **Not sent · Send**. It
is never sent automatically later: a message arriving hours after it was
written, with no one watching, is worse than one that waits to be sent.

**On sign-out or revoke,** that Mac's database and cache are wiped.

## Attachments

**Phone → Mac:**

1. Pick from the camera, Photos (`expo-image-picker`) or Files
   (`expo-document-picker`).
2. The phone sends `PUT /v1/blobs` and gets back a `BlobRef`.
3. `agents.send({attachments:[{blobId}]})`.
4. The Mac moves the staged blob in as an `OutgoingAttachment{path}` through
   the unchanged `attachments::save`, so the limits, name sanitising and
   prompt block are the desktop's own.
5. Staged blobs expire after 1 h.

**Mac → phone:**

- A message's `attachments[].path` downloads from the attachment route.
  `attachments::resolve` keeps it under the agent's home.
- Images show inline as thumbnails (`?w=`). Everything else opens through
  `expo-sharing` (Quick Look, or "Open in…").
- **Paths in an agent's reply** go through `agents.fetchPath`, which uses the
  same `files::shareable` roots as the desk and refuses folders and apps.

**Quotes** use the desktop's format: `> ` blockquotes in the text. **The P1
builder moves `quoteText`, `withQuotes` and `splitQuotes` from
`src/lib/agents.ts` into the package** and has the desktop re-export them.
They're pure, and both clients must agree on the format.

## Notifications

The server picks a notifier through a trait in `companion/notifier.rs`:

```rust
trait Notifier: Send + Sync {
    fn id(&self) -> &'static str;                       // "live", later "relay-apns"
    fn deliver(&self, device: &Device, alert: &Alert) -> Delivery;  // Sent | NotReachable
}
```

**What triggers an alert.** The decision reuses `notify::alert_for` plus the
`Coalescer` and `Limiter`, and respects `muted`. An alert goes to a device
only when that device isn't showing the agent:

- `agents.focus` only counts while the app is foregrounded and connected;
- disconnecting clears it.

**Today there is one implementation, `LiveSocket`.** It sends an `alert`
event, and the phone posts a local notification with `expo-notifications`.

**The honest limit.** On iOS, an app in the background gets a few seconds,
around 30 at most, before it is suspended and the socket dies. So **alerts
arrive while the app is open or was just backgrounded**, and that is all.

- **The app says so** in Settings → Notifications and on first run: "Alerts
  arrive while Ship Studio is open on your phone. Your Mac still notifies you
  at the desk."
- **Background polling (P3)** uses `expo-background-task`, which the OS runs
  at its own discretion, perhaps every 15 minutes or perhaps hours apart. It
  reconnects, reads the needs-you state and posts one summary notification.
  It is labelled "may be late". It is never called push.
- **Real push comes with the relay.** It is a second notifier,
  `RelayPush` (APNs and FCM). The device registers a push token through a
  future `devices.setPush` method, and the alert content is end-to-end
  encrypted to the device key from pairing. Nothing else changes.

## The future relay

A hosted relay is a future paid option. The protocol is designed so it slots
in without changing the app's API:

- **Screens** depend on `Transport` ([`transport.ts`](../packages/companion-protocol/src/transport.ts)),
  never on a socket. `RelayTransport` becomes a second implementation.
- **Frames** are already self-contained JSON. The relay carries them
  encrypted (X25519 keys exchanged at pairing, then XChaCha20-Poly1305) and
  can't read them.
- **Blobs** map to relay-stored ciphertext.
- **Cursors, resync and `clientId`** work unchanged over any pipe.
- **`LinkState.route`** already has `'relay'`, so the connection screen can say
  which path is in use.

## Updates, versions and forks

**Protocol versions** ([`version.ts`](../packages/companion-protocol/src/version.ts)):

- A single integer, bumped only for a breaking change. Additions (a new
  optional field, method or event) don't bump it.
- Both sides ignore unknown fields and events.
- The phone hides features the Mac doesn't list in `welcome.methods`.
- The Mac keeps speaking the previous version for at least one release.
- On a mismatch, `refused` names the side to update: "Update Ship Studio on
  Julian's MacBook Pro" or "Update this app". This is the same rule T3 Code
  uses.

**OTA** (official builds):

- `expo-updates` with `runtimeVersion: { policy: 'fingerprint' }`, so a
  JS-only update reaches exactly the binaries that can run it.
- Channels are `production` and `preview`.
- An update downloads in the background and applies on the next cold start.
  If the app has been open for hours, it offers **Restart to update**.
- Drafts and the outbox are in SQLite, so a restart loses nothing.
- A native change needs a new binary (a TestFlight build or an APK).

**Forks and self-builds.** `mobile/app.config.ts` reads:

- `SHIPSTUDIO_BUNDLE_ID`
- `EAS_PROJECT_ID`
- `UPDATES_URL`

With no `EAS_PROJECT_ID`, updates are disabled. That guarantees an official
OTA update can never land on a fork's binary: the project id differs and so
does the fingerprint. For self-builders, **Reinstall** in Ship Studio (below)
*is* the update. It rebuilds from the source matching the desktop's version.
A fork that wants OTA uses its own EAS project and sets those variables.

## Installing the app (no App Store at launch)

### Route 1: TestFlight public link (official builds)

Maintainers build and submit with EAS (`eas build -p ios --profile production`,
then `eas submit`), and publish one public TestFlight link in the README and
the Phone panel. Users tap it and install.

- **Cost:** an Apple Developer Program membership at $99 a year, on the
  maintainer's side only.
- **Builds expire after 90 days.** CI ships a build at least every 60 days,
  even if nothing changed.
- **Beta App Review** is required before external testers can install. It is
  usually under a day but not guaranteed, and only the first build of each
  version needs it. Up to 10,000 testers.
- **OTA updates on top.** JS changes reach TestFlight installs through
  `expo-updates` with no new build or review. Only native changes go through
  TestFlight.
- **Android:** a signed APK from `eas build -p android --profile apk`,
  attached to each GitHub Release. Ship Studio shows its QR code: scan it,
  download, and allow "Install unknown apps". There's no expiry.

### Route 2: "Install on my iPhone" from Ship Studio (self-builders, forks, and today)

This follows the agent-led onboarding pattern (`src/lib/agentOnboarding.ts`):
**the agent drives, the app verifies.**

**How it starts.** Settings → Phone → **Install on my iPhone** (or **…on my
Android**), or Cmd+K. The button spawns the user's agent in a terminal beside
a checklist, with the prompt from `buildPhoneInstallPrompt` in a new
`src/lib/companionInstall.ts`.

**What the prompt tells the agent.** The prompt is prescriptive: the steps,
the commands, and what to ask the user to do by hand. For example: "plug in
your phone and tap Trust", "turn on Developer Mode", "sign in to Xcode →
Settings → Accounts".

**Which source it builds.** By default, a sparse checkout of `mobile/` and
`packages/companion-protocol/` into `~/ShipStudio/.companion-build/`, at the
**tag matching the desktop's version**, so the protocols match. A setting
allows "Build from a folder" for forks.

**iOS checklist** (new commands in `commands/companion_install.rs`, with
shared helpers taken from `commands/mobile.rs`):

| Step | Who does it | The app's own check |
| --- | --- | --- |
| Xcode (full Xcode; the Command Line Tools alone can't build for a device) | Agent: `xcodes`, or App Store guidance | `xcode-select -p` is inside an `.app`, and `xcodebuild -version` runs |
| License and first launch | Agent: `sudo xcodebuild -runFirstLaunch` (the user types the password) | `xcodebuild -checkFirstLaunchStatus` exits 0 |
| CocoaPods, Node | Agent: `brew install cocoapods` | `pod --version`; the existing node check |
| Phone plugged in and trusted | User | `xcrun devicectl list devices --json-output` shows it paired |
| Developer Mode | User (Settings → Privacy & Security, which restarts the phone) | `devicectl` reports `developerModeStatus: enabled` |
| Signing (Apple ID added in Xcode) | User, guided by the agent | `security find-identity -v -p codesigning` has an "Apple Development" identity; the team id comes from it |
| Build and install | Agent: `npx expo prebuild`, then `npx expo run:ios --device <udid> --configuration Release` | `devicectl device info apps` lists our bundle id at the expected version |
| Trust the developer on the phone | User (Settings → General → VPN & Device Management) | **Cannot be checked from the Mac.** It is proven by the next step. |
| Pair | User scans the QR code | A device appears in the registry |

**Release, not Debug.** The build uses the Release configuration so the JS is
bundled into the app: a Debug build needs Metro running on the Mac.

**The bundle id** is `studio.ship.companion.<6-char hash of team id>`. A free
team can't register an id someone else already holds, and this one can never
collide with the official app.

**Free Apple ID: the app stops opening after 7 days.** We say so before the
build starts, and not in small print.

- **Expiry.** After install, the Mac reads `ExpirationDate` from the built
  app's `embedded.mobileprovision` (`security cms -D`) and stores it on the
  device record.
- **One-click Reinstall.** The Phone panel shows "Works until Tue 11 Nov" and a
  **Reinstall** button. Reinstall runs the build-and-install step directly,
  with no agent unless a check fails.
- **Reminder.** A macOS notification and a phone alert 24 h before expiry.
- **Other free-team limits,** stated plainly: 3 sideloaded apps per device, 10
  new app ids per week, and no push entitlement. The last one doesn't matter
  until the relay.
- A paid team gets a one-year profile and the same flow.

**Android checklist:**

| Step | Check |
| --- | --- |
| adb | `mobile.rs`'s `adb_command` resolves it |
| Phone connected, USB debugging authorized | `adb devices` shows `device`, not `unauthorized` |
| Install | Default: `adb install` of the official APK from the matching release, with no toolchain. Self-build: JDK 17 and the SDK, then `npx expo run:android --variant release` with a local keystore at `~/Library/Application Support/ShipStudio/companion/android.keystore` (0600) |
| Installed | `adb shell pm list packages <id>` |

Android has no expiry.

**After install,** the same screen goes straight to pairing and shows the QR
code. There's no second place to look.

The scripted demo mode (`SHIPSTUDIO_FORCE_SETUP`-style) and harness scenarios
(`companion-install-*`) follow the onboarding precedent, so the checklist can
be eyeballed without a phone.

## Connection status

**On the phone,** the header pill is computed from layers, each of them
`ok | problem | unknown` with a "last known" time. The Connection screen lists
the layers in this order:

1. **This phone is online.** From NetInfo.
2. **Mac reachable.** Which route, how fast, and when it was last seen. If it
   isn't reachable, we can't know why, so we list the likely causes from the
   last status we had:
   - "Last seen 4 min ago, on battery at 12% with keep-awake off: it may be
     asleep."
   - Tailscale off on this phone.
   - A different network.
3. **Mac awake.** Keep-awake, lid-closed mode and battery, from Remote
   Access's power status. This is offered on the Phone panel as "Keep this
   Mac awake while a phone is paired", using the same `caffeinate`.
4. **Ship Studio running.** Shown as yes only when the server answered.
   "Mac reachable but app not running" isn't something we can observe: no
   answer looks the same either way, so this layer is never claimed
   separately.
5. **Claude Code.** Installed, plus signed in as `yes | no | unknown` from the
   onboarding check (`claude_auth_truth`), cached for 60 s. An agent whose
   last turn failed `signed_out` makes this a problem even when the check
   reads yes.
6. **Agents.** Each agent's `capabilities` lines with "as of" its last turn,
   and its failure if it has one.
7. **This device.** Its name, when it paired, the app version and update id,
   and the protocol version. Also **Forget this Mac**.

**The pill** shows one of: Connected · Connecting… · Reconnecting (last seen
2 min ago) · Can't reach Mac · Claude Code signed out · Update needed ·
Removed from Mac.

**On the Mac,** Settings → Phone shows:

- the companion on or off, and its routes (Tailscale serve status, LAN on or
  off);
- the device list;
- **Pair a phone** and **Install on my phone**.

A sidebar indicator, like Remote Access's, appears while a phone is connected.

## Screens (phone)

| # | Screen | Contents | P |
| --- | --- | --- | --- |
| 1 | **Welcome / Pair** | Scan or paste a code, then "Allow on your Mac…", then connected. Also explains the Mac has to stay on, once. | 1 |
| 2 | **Agents** (home) | A Needs-you section at the top (pending approvals, signed-out, usage limit); then the Chief and pinned agents; then the rest by last activity. Each row shows status, unread, and a preview. The connection pill sits in the header. | 1 |
| 3 | **Chat** | Bubbles and the streaming draft. Approval cards: Allow · Always allow (with the scope sentence from `describeScope`) · Deny · Deny with note. Stop and Interrupt while working. Change cards open the diff; session lines open the session. | 1 (core) / 2 (attach, quote, @) / 3 (mic) |
| 4 | **Agent sheet** | Role, model and project; capabilities; check-ins and routines (create, edit, pause, run now, cancel); permissions (revoke); usage; mute, pin and hide. | 2 |
| 5 | **Files** | All / You / Agent, with download and share. | 2 |
| 6 | **Projects → Sessions** | State, the question with option buttons, the screen text, Send, and a screenshot viewer. | 2 |
| 7 | **Search** | Across every chat, grouped by agent; a hit opens at the message. | 3 |
| 8 | **Import** | Copy the prompt, paste the reply, preview, import. | 3 |
| 9 | **Connection** | The layers above. | 1 |
| 10 | **Settings** | Notifications (the honest copy), updates (version, channel, check now), about. | 1 |

**Desktop additions:**

- Settings → **Phone**: install checklist with terminal, pair QR and confirm,
  devices, routes.
- The sidebar indicator.
- Cmd+K commands: `companion.pair`, `companion.install`, `companion.devices`.

### Benchmarks: what we copy, and what we do better

**From T3 Code:**

- **Copy:**
  - one-time pairing links;
  - several routes, tried in order, with the LAN skipped away from home;
  - a version mismatch that names which side to update;
  - saving drafts before an OTA restart;
  - a device list with revoke on the host.
- **Do better:**
  - pairing needs a confirmation at the desk;
  - default access is not "everything, silently" (T3's default is Full
    access);
  - every status layer is visible;
  - notification limits are stated, not left out.

**From Grok Bot mobile** (from public descriptions only):

- **Copy:**
  - the same Bots, conversations and routines as on desktop;
  - inline approvals;
  - dictation one tap from the composer.
- **Do better:**
  - no cloud machine: the work stays on your Mac, in the session you'll come
    back to;
  - approvals don't silently lapse. Ours stay answerable, and the
    late-allow path in `wake` already handles that;
  - the app says when the Mac can't be reached instead of looking empty.

## Dictation

`expo-speech-recognition` runs with `requiresOnDeviceRecognition: true`, so
audio never leaves the phone.

- **When on-device recognition isn't available** for the language, the mic
  says so and does nothing. **It never falls back to a server** without
  asking.
- **Results** go into the composer for review. They are never auto-sent.
- **Behaviour** mirrors the desktop's `useDictation`.

## Keeping the types honest

**The direction.** Rust is the truth, and the desktop's `src/lib/agents.ts`
mirrors it by hand, as the codebase already does. The package copies those
types so the Expo app needn't import Tauri. Drift is caught at both seams:

1. **TS ↔ TS.** `desktop-conformance.ts` asserts each copied type is
   *identical* to the desktop's. `pnpm typecheck` now includes the package,
   so changing one side alone fails CI.
2. **Rust ↔ TS (fixture test, built in P1).** A Rust test, `cargo test --lib
   companion::fixtures`, serializes a representative value of every wire type
   and writes `packages/companion-protocol/src/fixtures.gen.ts` as
   `export const x = {...} satisfies Result<'agents.messages'>`. The
   representative values cover every optional field set, plus every enum
   variant.
   - **tsc checks the real serialized output.** That includes
     `skip_serializing_if`, `flatten` and `rename_all`, and object literals
     get excess-property checks.
   - **The test fails if the file on disk differs** from what it would
     generate. `UPDATE_FIXTURES=1` rewrites it.

**Why not ts-rs.** It would mean deriving on about 30 types in `agents/` that
exist for the desktop, plus a new dependency and churn in generated files.
And it checks declarations, not what serde actually emits; the fixtures check
the emitted output.

## Build plan

### P1: install today, pair, chat (the owner can use it at the end of P1)

**Desktop:**

- The protocol package (this commit).
- The `companion/` server: both listeners, Tailscale serve on 47443, and the
  LAN certificate.
- Pairing with the desk confirmation; device registry, revoke and audit.
- The hub, journal, cursors and drafts.
- The router for the `system.*`, `devices.*` and core `agents.*` methods: send
  (text, mentions), messages, stop, interrupt, answerApproval, focus,
  markUnread.
- The `LiveSocket` notifier.
- Settings → Phone with Pair and Devices.
- **The self-install flow for iOS and Android**, including Reinstall and the
  7-day expiry reminder.
- The fixture test.

**App:**

- Expo SDK (current), expo-router, `pinned-transport`, and `DirectTransport`
  with the cursor and resync logic.
- Screens 1, 2, 3 (core), 9 and 10.
- Local notifications.

**Done when:** a phone installed through Route 2 pairs over Tailscale and
over the LAN, chats with streaming, answers approvals, and survives an
airplane-mode toggle and a Mac app restart with no missing or duplicated
message. That last part is checked by a hub test which drops the socket at
every point of a scripted turn.

### P1 desktop server: as built

Decisions taken for P1: Tailscale only (the LAN listener and pinning move
to P2), every project reachable, no git push from the phone, TestFlight
first.

- **Turning it on.** Settings → Phone → Open, or Cmd+K "Pair a phone" /
  "Paired phones". The Phone panel is its own modal (`src/components/phone/`)
  rather than a Settings tab, like Remote access. It binds `127.0.0.1:<port>`
  (the port is kept in `companion.json` so the serve handler stays valid),
  then runs `tailscale serve --bg --https=47443 http://127.0.0.1:<port>`.
  It reports the route as on only when `tailscale serve status --json` shows
  that exact handler and the port isn't funnelled. Turning it off runs
  `tailscale serve --https=47443 off`. Nothing else in the serve config is
  touched.
- **Methods served:** `system.status`, `devices.self`, `devices.unpairSelf`,
  and `agents.` `overview`, `messages` (with `before` paging and `asOf`),
  `send`, `stop`, `interrupt`, `answerApproval`, `focus` and `markUnread`.
  `welcome.methods` lists exactly these. A send with attachments is refused
  with `bad_params` until blobs land.
- **Differences from the text above:**
  - The `notify::set_showing` label is per socket
    (`companion:<device>:<socket>`), so a stale socket closing can't clear a
    newer one's chat. A phone counts as showing a chat only while that
    socket is open and in the foreground.
  - The overview drops each agent's lifetime `usage`: `Agent` doesn't declare
    it, and the overview goes out on every registry change.
  - `sync.snapshot.projects` is empty until the project methods arrive (P2).
  - The `LiveSocket` notifier (`alert` events) isn't built yet.
  - `serverPublicKey` is empty.
- **Drift check:** `cargo test --lib companion::fixtures` writes
  `fixtures.gen.ts`, and `pnpm typecheck` checks it. Method results in it go
  through the real router.

### P2 app: as built

- **Navigation.** Native tabs: Agents, Projects, and the system Search tab.
  Chat, the agent sheet, Files, a session and the photo viewer push over them.
- **Attachments.** Camera, Photos or Files; the desktop's limits are checked
  before upload and again by the Mac. Each file uploads as soon as it's
  picked (with progress, retry and remove), so Send sends blob ids. Images
  show as the Mac's `?w=` thumbnails and open in a zooming viewer with
  Share; anything else opens in Quick Look (`File.preview`, with the share
  sheet as the fallback). Downloads are cached by blob id or agent + path.
- **clientId.** The optimistic bubble settles on the echoed `clientId`;
  text matching is kept only for a Mac that doesn't echo one.
- **Sessions.** Session cards in chat open a read-only view of the session
  (`sessions.read`, refreshed every 2.5 s while open). Answering a question
  and typing stay on the Mac: `sessions.send`/`sessions.key` aren't served.
- **Projects** poll `projects.list` every 4 s while the tab is visible,
  since `projects.changed` isn't journaled yet.
- **Search** pages a chat back with `before` until the hit is loaded (40
  pages at most), scrolls to it and lights it.
- **Not yet:** quotes and @mentions, `agents.fetchPath` for paths in a
  reply, the offline SQLite cache and outbox, the LAN route.

### P2: everything else in the chat, and projects

- Attachments both ways (blobs).
- Quote and @mentions (move the quote helpers into the package).
- Files, the diff viewer, the agent sheet, check-ins and routines.
- Projects, sessions and screenshots (split the structured cores out of
  `tools.rs`).
- The offline cache and the outbox.
- Route 1: the EAS pipeline, TestFlight public link, APK on releases, OTA
  channels.

### P2 desktop server: as built

- **Methods served** (`router::METHODS`, and so `welcome.methods`): P1's,
  plus `agents.files`, `agents.fetchPath`, `agents.search`,
  `agents.schedule.preview|create|update|pause|cancel|runNow`, `projects.list`
  and `sessions.read`. Not yet: `agents.create|update|delete|instructions|usage|
  changeDiff|revokePermission`, the import methods, `sessions.send|key|start`
  and `preview.screenshot`.
- **`clientId`.** `agents_send` takes an optional `client_id` and stores it on
  the user message, so the result and its `agents.message` event both carry
  it. The desktop's own sends leave it out.
- **Files** (`companion/blobs.rs`, `companion/files.rs`). Every route checks
  `Authorization: Bearer`; an unknown or revoked token is a bare 401, and
  another device's blob or a path outside the agent's `attachments/` is a
  bare 404.
  - `PUT /v1/blobs`: 413 at once on a declared `Content-Length` over 25 MB;
    an undeclared body over it is read out (up to twice the limit) before
    the 413, so the phone hears the answer rather than a reset. A 10-minute
    overall timeout (408). A per-device staging budget of 30 files and
    300 MB (429, with the sentence as a `CommandError` body). Staged in
    `companion-blobs/` beside `companion.json` (0700, files 0600), swept
    after an hour and cleared at launch and on revoke. The name goes through
    `attachments::sanitize_name`; the type is the upload's `Content-Type`
    when it's a plain `type/subtype`, else `mime_for(name)`.
  - `agents.send` with blob ids: at most `MAX_FILES`, each the caller's and
    still staged, handed to `agents_send` as `OutgoingAttachment{path}` so
    `attachments::save` applies the desk's limits. Files alone are a message,
    as on the desk. Blobs are consumed after the send succeeds.
  - `GET /v1/blobs/:id` and `GET /v1/agents/:id/attachments/*` (also `HEAD`):
    `Content-Type`, `Content-Length`, `Content-Disposition: inline;
    filename*=…`, `X-Content-Type-Options: nosniff`, `Accept-Ranges: bytes`,
    and `Cache-Control: private, max-age=86400` for attachments (they never
    change) or `private, no-store` for blobs. One `Range: bytes=a-b|a-|-n`
    gets a 206 with `Content-Range`; an impossible one a 416; several ranges
    the whole file.
  - `?w=` (clamped to 16–1024) returns a JPEG (quality 80) no wider than
    that, never upscaled, for PNG, JPEG, GIF and WebP. SVG, HEIC and anything
    that fails to decode are served as they are.
  - `agents.fetchPath` resolves with `files::shareable` over the same roots as
    `share_file` (the agent's home and every project), so folders and apps are
    refused, then *copies* the file into the device's staging as a blob
    (25 MB limit) and returns its `BlobRef`.
- **Projects and sessions.** `remote_access/tools.rs` gained structured cores
  (`project_views`, `session_screen`) built on the same `sessions_for`,
  `tab_state` and `agent_state` the MCP tools use; the MCP text is unchanged.
  The project list is every Ship Studio project, as agents get. Only agent
  tabs are listed or readable: a plain terminal is left out rather than given
  a state we can't read off it. Options become keys: `"1. Yes"` is key `1`;
  an unnumbered menu's highlighted item is `enter`; items only reachable with
  arrow keys aren't offered. `dirtyFiles` is 0 and `branch` absent when git
  doesn't answer. `sessions.read` returns the last 300 rendered lines and the
  agent's latest reply.
- **`sync.snapshot.projects`** is filled. `projects.changed` isn't journaled
  yet; the app re-reads `projects.list` while its Projects tab is showing.
- **The Phone panel** shows each phone's latest action from the audit log
  (presence, pairing and `agents.focus` lines skipped) and a "What a paired
  phone can do" section derived from `router::METHODS`.

### P3: voice, search, import, polish

- Dictation, search, paste import.
- Bonjour discovery and multiple Macs.
- Best-effort background refresh.
- Haptics and motion.
- Harness scenarios for every Phone panel state.

## Files

- `packages/companion-protocol/src/`: `model.ts`, `methods.ts`, `events.ts`,
  `frames.ts`, `pairing.ts`, `transport.ts`, `version.ts`, and
  `desktop-conformance.ts` (type-level, not exported).
- To be built:
  - `src-tauri/src/companion/`
  - `src-tauri/src/commands/companion.rs` and `companion_install.rs`
  - `src/lib/companion.ts` and `companionInstall.ts`
  - `src/components/phone/`
  - `mobile/`
