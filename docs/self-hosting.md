# Self-hosting Ship Studio

Ship Studio can run as a server you reach from a browser instead of as a desktop
app. Same Rust backend, same React frontend — Tauri's IPC transport is replaced
with HTTP + WebSocket.

> **Read the security model below before you expose this to anything.** This is
> not a hosted multi-user product and it never will be.

## Security model

Ship Studio's backend was written for a desktop app, where the only user is the
person sitting at the machine. Every command assumes that trust:

- **Arbitrary process execution** — the whole point of the app is running coding
  agents, dev servers, and git in a terminal on the host.
- **Arbitrary filesystem access** — inside the projects root, plus any external
  folder you register.
- **Stored credentials** — GitHub, Vercel, and agent CLI tokens live on the host
  and are used by commands you can trigger over the network.

Serving that over HTTP means: **anyone who can authenticate gets a shell on the
host, as the user running the server.** There is no sandbox, no permission model,
and no second user to isolate you from. Treat the auth token exactly as you would
treat an SSH private key.

Consequences, all non-negotiable:

1. **Single user.** One token, one person. Do not hand it to a team.
2. **Loopback by default.** The server binds `127.0.0.1` unless you set
   `SHIP_ALLOW_EXTERNAL_BIND=1`, and it logs a warning when you do.
3. **Put TLS in front of it.** Run it behind a reverse proxy (Caddy, nginx,
   Traefik) that terminates TLS. The server speaks plain HTTP and will not do
   TLS itself. Without TLS your token crosses the network in the clear.
4. **Do not expose it to the public internet** unless you have also put your own
   authentication layer in front. The built-in token auth is a lock on the door,
   not a security perimeter.
5. **Preview ports are not authenticated.** Your project dev servers are proxied
   on their own ports (see `SHIP_PREVIEW_PORT_RANGE`). Anyone who can reach those
   ports sees the site you are building. Keep them loopback-only unless you mean
   to publish them.

Found a vulnerability? See [SECURITY.md](../SECURITY.md).

## Configuration

All configuration is environment variables, read once at startup. Anything
invalid is a startup failure, not a runtime surprise.

| Variable | Default | Meaning |
|---|---|---|
| `SHIP_AUTH_TOKEN` | **required** | Shared secret exchanged for a session cookie. Minimum 16 characters. The server refuses to start without it. |
| `SHIP_BIND` | `127.0.0.1:1420` | Listen address. |
| `SHIP_ALLOW_EXTERNAL_BIND` | unset | Set to `1` to permit a non-loopback `SHIP_BIND`. Required opt-in. |
| `SHIP_PUBLIC_ORIGIN` | unset | The origin the browser uses, e.g. `https://ship.example.com`. Used for CSRF and WebSocket origin checks, and enables the `Secure` cookie flag when it is `https://`. Falls back to same-origin checking against the `Host` header. |
| `SHIP_STATIC_DIR` | `dist` | Directory holding the built frontend. |
| `SHIP_PREVIEW_PORT_RANGE` | `3100-3130` | Inclusive port range preview and static-file servers allocate from. Bounded so a container can publish exactly this range. |
| `SHIP_PREVIEW_BIND` | `127.0.0.1` | Address preview listeners bind to. `0.0.0.0` inside a container. |

Generate a token with something like:

```bash
export SHIP_AUTH_TOKEN="$(openssl rand -hex 32)"
```

## Running from source

```bash
pnpm install
pnpm build                                    # builds dist/
cargo run --manifest-path src-tauri/Cargo.toml \
  --features web --bin ship-studio-server
```

Then open http://127.0.0.1:1420 and enter the token.

The desktop app is unaffected — it builds and runs exactly as before, and the
`web` feature is off by default.

## Authentication flow

- `POST /api/login` with `{"token": "..."}` sets an `HttpOnly`,
  `SameSite=Strict` session cookie signed with a key derived from the token.
  Rotating `SHIP_AUTH_TOKEN` therefore invalidates every outstanding session.
- Every other `/api` route, including the WebSocket upgrades, requires that
  cookie. The middleware is deny-by-default: a newly added route is protected
  unless it is explicitly listed as public.
- `GET /api/health` is public and returns only the app version.
- State-changing requests carrying a foreign `Origin` are refused.
- The static frontend bundle is served without auth. It holds no data; every
  call it makes is gated.

## What is not available in the browser

Some features need a real desktop session and are turned off. The frontend asks
the server what it supports and hides them rather than failing at the click.

Documented per feature in the capability list once Phase 5 lands.
