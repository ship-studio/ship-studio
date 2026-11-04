# Push relay

Phone notifications that arrive when the Ship Studio app is closed.

A Mac can't wake a phone itself. Apple (APNs) and Google (FCM) accept pushes
only from whoever holds the app's signing key, and that key can't ship
inside a desktop app that anyone can unpack. So a tiny Cloudflare Worker,
`services/push-relay/`, holds the key and does nothing else. It never sees
what an agent said.

**Status:** built and tested, **not deployed**. Nothing here runs until the
owner does the steps in [Deploying](#deploying).

## What leaves the Mac

The relay accepts exactly one shape of send, and refuses any other field by
name (`400 unknown_field`), whoever built the Mac side:

```json
{ "device": "dev_3f9c1a2b4d5e6f70", "kind": "needs_you", "agent": "9b2e…(32 hex)", "badge": 3 }
```

| Field | What it is |
| --- | --- |
| `device` | The Mac's random id for the paired phone. It means nothing outside this Mac. |
| `kind` | `needs_you` (an approval or question), `finished` (a turn ended with a reply), or `message` (a check-in firing outside a turn). |
| `agent` | The agent's random UUID, so a tap opens that chat. Never its name. Left out if it isn't opaque. |
| `badge` | The app icon's count: unread plus pending approvals, as on the Dock. |

The words on the phone are fixed in the Worker (`src/alert.ts`): "An agent
needs you", "An agent finished" or "New message from an agent". There's no
message text, agent name, project, file or person in the push. Apple or
Google sees that the phone got an alert of that kind, at that time, plus the
agent's random id.

Registering a phone sends `{ platform, token, environment }`: the push token
the phone gave its Mac, and whether it's a production or development APNs
token.

### Why a generic alert, not an encrypted one

The spec allowed either. v1 sends a generic alert:

- **Encrypting** the alert to a key from pairing needs a Notification Service
  Extension. That's a second native target in the Expo app, with an app group
  to share the key and `mutable-content` pushes. It also needs a fallback
  when the extension doesn't run in time, which is the generic alert anyway.
- **What it would add** is the agent's name and a preview on the lock screen.
  Today you see that after one tap.
- **The relay is the same either way.** A later `blob` field holding
  ciphertext would be the only change, and the Worker can still refuse
  anything readable.

## Threat model

| Who | What they could learn or do | Why it stops there |
| --- | --- | --- |
| Apple / Google | That an alert of a kind went to a device, the agent's random id, the badge count | That's the whole payload. |
| Cloudflare, or someone holding the Worker | Push tokens, each Mac's installation id, opaque device and agent ids, and send times | No content ever reaches the Worker. With the APNs key they could send generic alerts to registered phones, which is the same power as anyone holding the key. |
| Someone with a stolen installation secret | Send generic alerts to that Mac's phones, up to the rate limits; replace or remove its tokens | The secret is in `companion.json` (0600) on the Mac. Turning push off and on again mints a new installation. |
| Anyone on the internet | Create empty installations | Cloudflare's limiter allows 5 a minute per client address. An installation without a phone can't send. |
| A malicious fork of the desktop app | Try to put content in a push | The Worker refuses every field it doesn't list. A fork with its own relay is its own business, and its app can't use our APNs key. |

**What the relay stores** (D1):

- installations: the id, a SHA-256 of the secret and a creation time;
- per phone: the platform, token, APNs environment and an update time;
- hourly counters keyed by those opaque ids.

It stores no IP addresses. The creation limiter is Cloudflare's own, which
keeps nothing for us. It stores no names, and it keeps no request logs:
there are no `console` calls (a test asserts it) and Workers Logs are off in
`wrangler.jsonc`.

**Clean-up:**

- Turning push off on the Mac deletes the installation and every token at
  the relay.
- Removing a phone, or "Forget this Mac" on the phone, deletes its token.
- A token Apple or Google reports as dead (410, `BadDeviceToken`,
  `UNREGISTERED`) is deleted wherever it was registered, and the Mac drops it
  too. The phone sends a fresh one on its next connect.
- If the relay can't be reached when push is turned off, it keeps those
  tokens until a provider rejects them. Nothing else is held.

## How it fits together

1. **Phone.** After the user allows notifications (the "Turn on alerts" card
   after pairing, or Settings, and never at launch), an official build calls
   `devices.setPush { token, environment }` on every connect.
   - A self-built app doesn't ask, and Settings says "Needs the official
     build".
2. **Mac.** `companion/push.rs` keeps the token on the device record. When
   the Phone panel's "Phone notifications via Ship Studio's push service" is
   on, it creates an installation (`POST /v1/installations`) and registers
   the token (`PUT /v1/devices/:id`).
   - The answer to the phone is a `PushStatus`: `on`, `pending`, `off`,
     `unavailable` or `self_build`.
3. **Alert.** `agents::notify::post` already decides when the desk shows a
   notification, which applies per-agent mute, "on screen" and one alert per
   turn. It also calls `push::raise`, which sends to each phone that:
   - has a token from an official build;
   - is **not in front**: no socket, or every socket backgrounded longer than
     `LIVE_WINDOW_MS`;
   - and isn't over the burst cap (the desk's `Limiter`).
4. **Relay.** The Worker checks the installation secret, rate limits (600 an
   hour per Mac, 60 an hour per phone), and sends to APNs (or FCM, when
   configured) with a collapse id per agent and kind.
   - `needs_you` is `time-sensitive` and plays a sound; the others are
     silent.
5. **Tap.** The app reads the agent id from the push (`agentFromResponse`)
   and opens that chat.

`LIVE_WINDOW_MS` is 0 for now. Until the Mac sends live `alert` events, a
backgrounded phone posts nothing locally, so holding the push back would
lose the alert. When the `LiveSocket` notifier lands, set it to about 25 s
so that a just-backgrounded phone hears the alert once, locally.

The Mac only reaches a relay if the build was given one: the
`SHIPSTUDIO_PUSH_RELAY_URL` variable is read at compile time for official
builds, and at run time for a local `wrangler dev`. Without it, the toggle is
disabled with "This build of Ship Studio has no push service", and the phone
shows "Not on this Mac".

## Deploying

The owner does this once. Nothing here has been run.

**What's needed:**

- A Cloudflare account. The Workers free plan is enough.
- From the Apple Developer team that owns the app (the TestFlight team):
  - an **APNs auth key** (`.p8`), made under Certificates, IDs & Profiles →
    Keys, with Apple Push Notifications service ticked;
  - its **Key ID**;
  - the **Team ID**;
  - the app's **bundle id**, with the Push Notifications capability turned
    on for that App ID.
- Optional, for Android: a Firebase project with the app registered, and a
  service account JSON that can send messages.

**Steps** (from `services/push-relay/`):

1. `pnpm install`, then `npx wrangler login`.
2. `npx wrangler d1 create shipstudio-push`, and copy the printed
   `database_id` into `wrangler.jsonc`.
3. In `wrangler.jsonc`, set `vars.APNS_TOPIC` to the bundle id. It must match
   `SHIPSTUDIO_BUNDLE_ID` in `mobile/app.config.ts`.
4. `npx wrangler d1 migrations apply shipstudio-push --remote`.
5. Set the secrets. Each command prompts for the value:
   - `npx wrangler secret put APNS_KEY`: paste the whole `.p8` file, including
     the BEGIN and END lines;
   - `npx wrangler secret put APNS_KEY_ID`;
   - `npx wrangler secret put APNS_TEAM_ID`;
   - optional: `npx wrangler secret put FCM_SERVICE_ACCOUNT`, with the JSON.
6. `npx wrangler deploy`. Optionally add a custom domain such as
   `push.shipstudio.app`.
7. Build the official desktop app with
   `SHIPSTUDIO_PUSH_RELAY_URL=https://<the worker's URL>` set at compile time.
8. In the official mobile build:
   - give the iOS app the push entitlement (EAS does this once the App ID has
     the capability);
   - add `com.apple.developer.usernotifications.time-sensitive` if
     needs-you alerts should break through Focus. Without it they arrive as
     ordinary alerts;
   - Android needs `google-services.json` for an FCM token.

**Check it worked:**

1. Pair a TestFlight build.
2. Turn the toggle on in the Phone panel, and lock the phone.
3. Ask an agent something that needs an approval. The phone shows "An agent
   needs you".

Without the secrets, the relay answers 503 `unconfigured`, and the Mac keeps
the token and tries again with the next alert.

## Cost

**Workers free plan:**

- 100,000 requests a day;
- D1 allows 5 million row reads and 100,000 row writes a day.

**Per push:** about 3 row reads, plus 2 writes for the rate counters.

**So the free tier covers about 50,000 pushes a day.** The per-phone cap of
60 an hour keeps any one Mac far below that. Past it, Workers Paid is
$5 a month. APNs and FCM are free.

## Verified, and not

**Verified:**

- **Worker** (`cd services/push-relay && pnpm test`, Workers runtime under
  Miniflare). The tests cover:
  - schema refusals, including `body`, `title` and `text`;
  - installation secrets stored hashed;
  - the APNs payload and headers, with the ES256 JWT checked against a
    generated key;
  - the sandbox host for development tokens;
  - 410 clean-up, and 503 when the key is missing;
  - per-phone and per-installation limits, and the creation limiter;
  - FCM's message shape behind a mocked OAuth exchange;
  - nothing printed to the console.
- **Mac** (`cargo test --lib companion::push`). The tests cover:
  - when a phone counts as needing a push;
  - nothing leaves the Mac while push is off;
  - registration happens once;
  - turning push off forgets the installation;
  - self-built apps are refused;
  - dead tokens and a forgotten installation;
  - the exact send body.

**Not verified:**

- No real APNs or FCM delivery. The key doesn't exist yet.
- That Workers' `fetch` reaches APNs over HTTP/2. MausBot runs the same
  design in a Worker, but we haven't seen it ourselves.
- The phone side on a device: getting the token and opening the chat from a
  real push. These are covered by unit tests only.
