# Mobile companion

Ship Studio on your phone. The Mac does all the work; the phone is a thin
client paired by QR code. It shows the same agents, chats, approvals,
check-ins, projects and sessions as the desk, in sync both ways, over your own
Tailscale tailnet.

| Part | Where |
| --- | --- |
| Wire types (the contract) | [`packages/companion-protocol`](../packages/companion-protocol/src/index.ts) |
| Desktop server | `src-tauri/src/companion/`, commands in `src-tauri/src/commands/companion*.rs` |
| Desktop Phone panel | `src/components/phone/`, `src/lib/companion.ts`, `src/lib/companionInstall.ts` |
| Expo app | `mobile/` (running it and the mock Mac: [mobile/README.md](../mobile/README.md)) |
| Push relay | `services/push-relay/` ([push-relay.md](push-relay.md)) |

Where this doc and the types disagree, fix whichever is wrong in the same
commit.

## Principles

- **Mirror, don't invent.** Every method calls an existing desktop command,
  and every event mirrors a desktop event (`agents://*`) or the state behind
  one. The logic the desk runs is the logic the phone runs.
- **Nothing in the middle.** The phone talks to the Mac directly. Funnel is
  never used; the only service of ours involved is the optional, content-free
  push relay.
- **Say what's known.** The phone shows whether the Mac can be reached, is
  awake, is running Ship Studio and has Claude Code signed in. What it can't
  observe it calls unknown, never guesses.
- **The phone is a remote surface.** It gets the agents' own refusals and a
  few stricter ones (below), and it can't push to git, manage other devices,
  or type into a plain terminal.

## Architecture

```
 iPhone / Android (Expo)                     Mac (Ship Studio, Tauri)
┌──────────────────────────┐            ┌──────────────────────────────────────────┐
│ screens (expo-router)    │            │ companion::server (hyper)                │
│ store (zustand) + JSON   │  tailnet   │   127.0.0.1:P ◀── tailscale serve        │
│   cache, drafts, outbox  │ ─ HTTPS ─▶ │                   --https=47443          │
│ DirectTransport          │ (ts.net    │   auth · rate limit · audit              │
│   one WebSocket + HTTP   │  cert)     │ hub: journal (epoch, seq) ◀── agents://* │
│ expo-notifications       │            │ router ─▶ commands/agents.rs (same fns)  │
└──────────────────────────┘            │        ─▶ remote_access::tools cores     │
              ▲                         │ push ─▶ push relay (Worker) ─▶ APNs/FCM  │
              └──── APNs / FCM ◀────────┴──────────────────────────────────────────┘
```

**Server modules** (`src-tauri/src/companion/`):

| File | Contents |
| --- | --- |
| `mod.rs` | Config and the device registry (`companion.json`, 0600), lifecycle, limits |
| `server.rs` | The listener, HTTP routes, WebSocket upgrade and socket loop |
| `pairing.rs` | Codes, the desk confirmation, token issue |
| `hub.rs` | Event journal, fan-out, draft appends |
| `router.rs` | `method` → command function; `METHODS` and `READ_ONLY_METHODS` |
| `desktop.rs` | The bridge to the running app: events in, status and projects out |
| `projects.rs` | The project watcher behind `projects.changed` / `projects.removed` |
| `blobs.rs`, `files.rs` | Staged uploads, and serving blobs and attachments |
| `push.rs` | The `Notifier` trait, `ApnsPush` through the relay, `devices.setPush` |
| `wire.rs` | The Rust side of the wire types |
| `fixtures.rs`, `testkit.rs` | Test-only: the fixture generator and shared test data |

The router calls the **command functions** in `commands/agents.rs`, not the
store, so emits, badge refresh and the "Always allow" covering pass all
happen. `notify::set_showing` is keyed per socket (`companion:<device>:<socket>`):
a phone counts as showing a chat only while that socket is open and in front,
and a stale socket closing can't clear a newer one's chat.

**Projects and sessions** reuse Remote Access: `remote_access/tools.rs` has
structured cores (`project_views`, `session_screen`) under its MCP text, so
both get the same session list, states and refusals.

## Protocol

### Transport

Everything except file bytes goes over **one WebSocket**
([`frames.ts`](../packages/companion-protocol/src/frames.ts)): requests
`{t:'req', id, method, params}` → `{t:'res', id, ok, result|error}`, plus
events. Errors are the desktop's `CommandError` plus a `Protocol` variant.
WebSocket rather than SSE because React Native has it built in, one socket is
one ordering domain (a request's response can't overtake the event it caused),
auth happens once per connection, and revoking a device closes it at once.

**Files go over HTTP**, so a 25 MB upload never holds up a message and
downloads get `Range`:

| Route | |
| --- | --- |
| `PUT /v1/blobs` | Raw body, `X-Name` and `Content-Type`; answers a `BlobRef`, staged for 1 h |
| `GET /v1/blobs/:id` | A blob the Mac produced (screenshot, fetched path) |
| `GET /v1/agents/:id/attachments/*` | A chat attachment; `?w=` (16–1024) for a JPEG thumbnail |

Every route checks `Authorization: Bearer`. An unknown token is a bare 401;
another device's blob or a path outside the agent's `attachments/` is a bare
404. Responses carry `nosniff`, `Content-Disposition: inline`, and
`private` caching (attachments never change; blobs are `no-store`).

**Heartbeat:** the Mac pings every 15 s; the phone treats 40 s of silence as
a dead link, which catches sleep and Wi-Fi handoffs faster than TCP.

**Limits:** 600 requests a minute per device; 4 sockets per device, 16 in
all; 1 MB frames; 25 MB a file and 10 files a message (`MAX_ATTACHMENT*`);
30 staged files or 300 MB per device; a 10 s wait for `hello`.

### Methods

`router::METHODS` is what the Mac serves and lists in `welcome.methods`; the
phone hides anything not listed (`canCall`), so an older Mac just shows less.

- `system.status`, `devices.self|unpairSelf|setPush`
- `agents.overview|messages|send|stop|interrupt|answerApproval|focus|markUnread`
  (`answerApproval` takes `choice` for a session's question)
- `agents.saveSecret` (Tailscale only, never audited with a value), `agents.memory|memoryChange|memorySuggest`
- `agents.update` (`pinned`, `muted`, `hidden`, `instructions`),
  `agents.instructions|usage|revokePermission|changeDiff`
- `agents.files|fetchPath|search`, `agents.schedule.preview|create|update|pause|cancel|runNow`
- `projects.list`, `sessions.read|send|key|start`, `preview.screenshot`

Declared in the package but not served: `agents.create|delete`, the import
methods. Pure reads (`READ_ONLY_METHODS`, mirrored in Rust) are not audited.

### Events, cursors and resync

The hub listens to the desktop's own events, stamps each journaled one with a
`seq` that only increases, and keeps them in memory (24 h or 20k entries)
under a random **epoch** made at app start. Messages are all kept; `status`,
`registry`, `projects` and `system` keep only the latest per key; drafts and
alerts are never journaled ([`events.ts`](../packages/companion-protocol/src/events.ts)).

The phone stores its cursor `{epoch, seq}` only after an event is applied and
saved, so a crash in between re-applies (harmless) and never skips. On
connect it sends `hello.resume`:

- **Same epoch, still in the journal:** `welcome{resume:'replay'}`, every
  event after the cursor in order, then `sync.caughtUp`. Nothing is missed.
- **Otherwise** (the app restarted, or a day away): `welcome{resume:'snapshot'}`,
  `sync.snapshot` (overview, Mac status, projects, cursor), `sync.caughtUp`;
  the phone re-reads the chats it has cached.

Nothing is ever doubled: messages are upserts by id (an answered approval
replaces its card), and `agents.send` requires a `clientId` that the Mac
remembers for 24 h and echoes on the message, so a retried send returns the
original. A page from `agents.messages` carries `asOf`, and only rows whose
last-applied `seq` ≤ `asOf.seq` are overwritten, so a fetch can't undo an
event that beat it.

**Drafts** are appends, `{id, from, text}`, throttled to 50 ms per socket and
restarted from 0 on a new connection. A `from` that doesn't match is dropped;
the next frame or the final message puts it right. (The desktop resends the
whole draft every 40 ms, which over cellular is most of the traffic.)

### Versions

`PROTOCOL_VERSION` ([`version.ts`](../packages/companion-protocol/src/version.ts))
is one integer, bumped only for a breaking change; additions don't bump it,
and both sides ignore unknown fields and events. The Mac keeps speaking the
previous version for at least a release. A mismatch is refused with the side
to update named: "Update Ship Studio on …" or "Update this app".

### Keeping the types honest

Rust is the truth; the desktop's `src/lib/agents.ts` mirrors it by hand and
the package copies those types so the app needn't import Tauri. Drift fails
at both seams:

1. **TS ↔ TS.** `desktop-conformance.ts` asserts each copied type is
   identical to the desktop's; root `pnpm typecheck` includes the package.
2. **Rust ↔ TS.** `cargo test --lib companion::fixtures` serializes a value of
   every wire type (every optional field set, every enum variant, method
   results through the real router) into `fixtures.gen.ts` as
   `satisfies` literals, so tsc checks what serde actually emits. The test
   fails if the file on disk differs; `UPDATE_FIXTURES=1` rewrites it. This
   was chosen over ts-rs, which checks declarations rather than output and
   would mean deriving on ~30 desktop types.

## Routes and TLS

The phone connects over **Tailscale**: the Mac binds `127.0.0.1:<port>` (kept
in `companion.json` so the handler stays valid) and runs
`tailscale serve --bg --https=47443 http://127.0.0.1:<port>`, so the phone
sees the real `*.ts.net` certificate with stock `fetch` and `WebSocket`. The
route is reported on only when `tailscale serve status --json` shows that exact
handler, unfunnelled. Off runs `tailscale serve --https=47443 off`; nothing
else in the serve config is touched.

**Why 47443:** Funnel can only publish 443, 8443 and 10000, per port, and
Remote Access already funnels 443. A mount on a Funnel port would be one
toggle from the public internet.

**A LAN route is designed but not built** (`RouteKind::Lan` exists on the
wire). It would be rustls with a self-signed key whose SPKI hash rides in the
QR code and is pinned by a small native module. Plain HTTP is never an
option: the token controls your agents, and anyone on the café Wi-Fi could
read it. The QR code is already an out-of-band channel, so pinning needs no
CA and no trust-on-first-use.

## Pairing

1. **Mac:** Phone panel → **Pair a phone** (or Cmd+K). A one-time code
   (128-bit, 5 minutes, single use) is shown as a QR code of
   `shipstudio-companion://pair?d=…` carrying the code, server id, Mac name
   and routes, and no long-lived secret (`PairingLink`).
2. **Phone:** scan in the app or with the Camera, or paste the link. It sends
   `POST /v1/pair` with its name, model and an X25519 public key.
3. **Mac:** "Allow **Julian's iPhone** to use your agents?" with Allow and
   Deny, open for 120 s. This is what makes a QR code photographed over your
   shoulder useless, and the device's name and model make a stranger's phone
   stand out.
4. **On Allow** the Mac returns a 256-bit token and keeps only its SHA-256.
   The phone keeps it in `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`,
   so never in a backup).
5. **Pairing again** with the same server replaces that Mac on the phone, and
   the Mac revokes the phone's old token, so devices don't stack up.

Codes are compared in constant time; a wrong one gets a bare 404 after 400 ms,
and five failures burn the code.

## Auth, revocation and audit

- HTTP sends `Authorization: Bearer`; the socket sends the token in its first
  frame (`hello.token`), never in the URL, so no log records it.
- The token is re-checked on every frame. **Revoke** in the Phone panel
  deletes the hash and closes that device's sockets at once; the phone says
  "This Mac removed this phone" and offers to pair again.
- **Forget this Mac** on the phone sends `devices.unpairSelf`. Offline, the
  revoke is queued in the keychain and finished on the next launch or
  network change, and the phone says the Mac keeps it until then.
- Turning the companion off stops the listener and removes the serve handler;
  paired devices are kept.
- **Audit:** every action goes through `remote_access::audit_as` into
  `remote_audit.jsonl` as `"Phone · <device>"`, with the method and a
  preview, never a token. The Phone panel shows each phone's latest action.
- **Text refusals:** `agents.send`, `sessions.send` and `sessions.start` apply
  Remote Access's `sanitize_message` / `check_message_kind`: no control
  characters, no leading `!`, `/` commands only from the allowlist, at most
  20k characters, and an opening prompt never starting with `-`. Sessions only
  ever reach agent tabs. A refusal comes back as `Protocol/refused` with the
  sentence to show.

## The app

### Screens

**Navigation:** native tabs for Agents, Projects and Search; chat, the agent
sheet, files, a session, the diff and the photo viewer push over them. At
700 pt and wider (iPad, landscape) the Agents list and a chat sit side by side.

- **Agents (home).** A "1 needs you · 2 working" summary with Next; Needs you
  (approvals, signed out, usage limit), then the Chief and pinned agents, then
  the rest by activity. Swipe to mute, hide (with Undo) or pin; hold for the
  context menu. Quick actions on the icon: "Needs you" and "New message to
  Chief of Staff".
- **Chat.** An inverted list: newest on the composer, older pages loaded on
  scroll. Replies stream one display frame at a time (`lib/reveal.ts`) and the
  finished message carries on from where its draft got to. What you're
  reading holds still while you're scrolled up or a long reply grows, and the
  jump button says "New reply" when one finished below. Hold a message to
  copy, quote or select text; paths in a reply open through `agents.fetchPath`.
- **Approvals** (`ApprovalCard`): the exact command, scrolling sideways rather
  than re-wrapped; Deny / Allow / Always allow (with `describeScope`'s
  sentence) / Deny with note. The answers are inert for 400 ms after the card
  lands, the desk's anti-misclick; Allow is the one tap the app must never
  take by accident.
- **Session questions** (`PromptCard`): the question, whose session it is,
  the diff (tinted) or text it shows, and every option it offers, answered
  with `agents.answerApproval`'s `choice`; the same 400 ms guard.
- **Secret cards** (`SecretCard`): masked fields straight to the Mac's
  Keychain via `agents.saveSecret`. Only over HTTPS on Tailscale (refused on
  the phone before sending, and by the Mac for any other route); the value
  lives in a ref, is wiped on save, backgrounding and unmount, and never
  reaches the store, cache, drafts, outbox, notifications or logs
  (`__tests__/secrets.node.test.ts`).
- **Composer.** Send, Queue while working (with Send now and Stop), Stop; no
  Stop while an approval waits. @mentions, quotes as `> ` blockquotes (the
  helpers live in the package), and files from the camera, Photos or Files,
  each uploading as soon as it's picked with progress, retry and remove.
  Drafts, including uploaded files (kept 55 min), survive leaving the chat and
  a cold start (`lib/drafts.ts`).
- **Agent sheet.** "Claude · Opus" / "Codex · …" (also in the chat
  header), Runs on and Model read-only, Memory (view, edit, forget with
  Undo, add; "Remember This" in a message's menu), Instructions (view and edit), pin/mute/hide, check-ins and
  routines (create, edit with past runs, pause, run now, cancel), usage, and "Allowed
  without asking" with Revoke.
- **Files** per agent; **search** across every chat, which pages a chat back
  (40 pages at most) to the hit and lights it.
- **Projects and sessions.** Live from `projects.changed` events (the Mac
  watches tabs every 2 s and git every 10 s, only while a phone is connected).
  A session shows its state, its screen (`sessions.read`, every 2.5 s while
  open), its question with an option per key, and lets you type, start a new
  session or take a preview screenshot (a private blob, never a public link).
- **Connection screen.** Every layer of the link (below).
- **Settings.** The paired Mac, alerts (with their limits), haptics, updates,
  about.

### Connection status

The Connection screen lists each layer in order, ok / problem / unknown with
when it was last known: this phone online (NetInfo); Mac reachable (route,
latency, last seen, likely causes from the last status); Mac awake
(keep-awake, lid mode, battery); Ship Studio running (only ever yes when the
server answered, since silence looks the same either way); Claude Code
installed and signed in (a `signed_out` turn makes it a problem whatever the
check says); each agent's capabilities; this device. Screens say nothing
while all is well and show the pill or a banner when something isn't.

### Offline cache and outbox

One JSON file per Mac (`cache-<serverId>.json`, `lib/cache.ts`) holds the
overview, Mac status, projects, the last 400 messages of each opened chat,
the outbox and the cursor, written together so replay after a restart starts
exactly where the copy ends. Downloads are cached by blob id or agent + path.
While disconnected, status marks go grey, headers say "as of …" and actions
are disabled. A message sent offline waits ("Waiting for …") and goes by
itself, idempotent by `clientId`, for **10 minutes** (`OUTBOX_WAIT_MS`);
after that it is **Not sent · Send · Discard** and never sent on its own,
because a message landing hours later with no one watching is worse than one
that waits. A refusal is final. Forgetting a Mac wipes its files.

### Feel and access

Body 16, secondary 14; `textMuted` meets 4.5:1 on panels and Increase
Contrast brightens each grey a step. Chrome is clamped at 1.3× Dynamic Type,
message bodies aren't, and at accessibility sizes the approval card folds its
explanation so the answers stay on screen. VoiceOver and TalkBack hear
replies, approvals, failures and toasts (`lib/a11y.ts`, not during replay).
Haptics only for send, stop, approvals (after the Mac confirms), failures and
toggles, and can be turned off. Android gets Material symbols, ripples and
predictive back.

## Notifications

`lib/notify.ts` keeps them honest: one per alert, grouped per agent
(`threadIdentifier`, the same thread id the relay sets), taken back once
handled anywhere (an approval answered or a chat read, here or at the desk),
the icon badge equal to the desk's `badge_count`, and all cleared on Forget
this Mac. Android has "Needs you" (high) and "Replies" channels. A tap waits
for fonts and credentials, opens at the message, and replaces a chat already
on top instead of stacking.

**Push** goes through `ApnsPush` (`companion/push.rs`) and the content-free
Worker in `services/push-relay`, which holds the APNs/FCM key. The Mac sends
only an opaque device handle, a kind (`needs_you`, `finished`, `message`), the
agent's random id and the badge; the words are fixed in the Worker. An alert
the desk would post (`agents::notify`, which already applies mute, on-screen
and coalescing) is pushed to each phone not in front. It's for official builds
only (a self-built app has no push entitlement), switched on in the Phone
panel, and **built but not deployed**: design, threat model and deploy steps
are in [push-relay.md](push-relay.md).

The socket can also carry an `alert` event, which the phone posts as a local
notification, but no live-socket notifier sends one yet, so `LIVE_WINDOW_MS`
is 0. Settings says plainly what arrives when.

## Installing the app

There is no App Store listing. `TESTFLIGHT_URL` and `ANDROID_APK_URL` in
`src/lib/companionInstall.ts` are unset, so those cards say "Not available
yet"; when set, maintainers ship through EAS (`eas.json` profiles map to
`expo-updates` channels), with a build at least every 60 days because
TestFlight builds expire at 90.

**Install on my phone** (Phone panel or Cmd+K) is the route today, and follows
the agent-led onboarding pattern: **the agent drives, the app verifies.** It
spawns the user's agent beside a checklist with a prescriptive prompt
(`buildIosInstallPrompt` / `buildAndroidInstallPrompt`); every check is a
read-only command in `commands/companion_install.rs`, and nothing runs until
the user clicks Start (or Reinstall). The source is a sparse checkout of
`mobile/` and the protocol package into `~/ShipStudio/.companion-build/` at the
**tag matching the desktop's version**, so the protocols match; a dev build
uses its own checkout, and `SHIPSTUDIO_COMPANION_SOURCE` overrides both.

| iOS step | Who | The app's check |
| --- | --- | --- |
| Full Xcode (outdated or missing disables Start) | User, from the App Store | `xcode-select -p` inside an `.app`, `xcodebuild -version` |
| License and first launch | Agent (`sudo xcodebuild -runFirstLaunch`) | `xcodebuild -checkFirstLaunchStatus` |
| CocoaPods, Node | Agent | `pod --version`, the node check |
| Phone plugged in and trusted, Developer Mode | User | `xcrun devicectl list devices` |
| Signing | User, guided | An "Apple Development" identity; the team id comes from it |
| Build and install (Release, so no Metro) | Agent: `expo prebuild`, `expo run:ios --device … --configuration Release` | `devicectl device info apps` lists the bundle id |
| Trust the developer, pair | User | The device appears in the registry |

The bundle id is `studio.ship.companion.<6 hex of the team id's sha256>`: a
free team can't take an id someone else holds, and it never collides with
the official app. **A free Apple ID's build stops opening after 7 days**, and
the panel says so before the build starts. Expiry is read from the newest
provisioning profile for that id; the panel shows "Works until …" with a
one-click **Reinstall**, and a reminder fires 24 h before. Android self-builds
`studio.ship.companion.self` over adb, and doesn't expire.

**Updates and forks.** `expo-updates` with `runtimeVersion: { policy:
'fingerprint' }` (a JS update reaches only binaries that can run it), applied
on the next cold start, with **Restart to update** in Settings. Drafts and the
outbox are on disk, so a restart loses nothing. `app.config.ts` reads
`SHIPSTUDIO_BUNDLE_ID`, `EAS_PROJECT_ID`, `UPDATES_URL` and `APPLE_TEAM_ID`;
with no `EAS_PROJECT_ID` updates are off, so an official update can never land
on a fork's binary. For self-builders, Reinstall is the update.

## Testing

- **Mock Mac:** `mobile/dev/mock-server.ts`, built on the generated fixtures;
  `pnpm mock` serves it and prints a pairing link (see the mobile README).
- **App:** `pnpm test` in `mobile/` runs the sync rules, chat logic and
  markdown under `jest-expo`, and the real `DirectTransport` against the mock
  (`*.node.test.ts`): a dropped socket mid-turn, a Mac restart, retried sends,
  files, search and schedules. Nothing may be missed or doubled.
- **Server:** `cargo test --lib companion::` (including the fixture drift
  check); **relay:** `pnpm test` in `services/push-relay`.

## Not built

- The LAN route and its pinned-transport module; Bonjour discovery; more than
  one Mac at a time.
- The live-socket notifier, and background refresh.
- Dictation (planned on-device only, never a server fallback, results never
  auto-sent), paste import, creating or deleting agents from the phone.
- Pushing to git from the phone: Remote Access gates it behind a PIN, and the
  phone gets nothing until the owner decides how.
- Native targets that need a dev build and an Apple team: a needs-you widget,
  a Live Activity per working turn, and a "Send to agent…" share extension.
- Verification on Android hardware.
