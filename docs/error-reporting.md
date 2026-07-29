# Automatic Error Reporting (Admin Agent)

Ship Studio automatically reports uncaught errors from production builds to the
Ship Studio admin agent — an AI pipeline that investigates each report against
the `ship-studio/ship-studio` codebase, files deduplicated GitHub issues, and
can open draft fix PRs (it cannot merge). This is separate from Sentry, which
handles aggregation/alerting; the admin agent is the act-on-it pipeline.

## The endpoint

```
POST https://shipstudio-admin-agent.vercel.app/report
Authorization: Bearer <BUG_REPORT_SECRET>
Content-Type: application/json
```

Body fields: `message` (required), `stack`, `source`, `appVersion`,
`fingerprint`, `context` (JSON object). Get `BUG_REPORT_SECRET` from Julian —
never commit it.

## How it's wired in the app

All reporting funnels through **`src-tauri/src/error_reporting.rs`**:

- `report_error(message, stack, source, fingerprint)` — the one Rust entry
  point. Async fire-and-forget POST with a 5s timeout.
- A panic hook (installed in `lib.rs::run()`, chained in front of Sentry's)
  reports Rust panics with a `panic-<file>:<line>:<col>` fingerprint. The
  panic path sends synchronously since the process may be about to die.
- The `report_frontend_error` Tauri command relays frontend errors.

Frontend errors reach it via **`src/lib/errorReporting.ts`** (`reportError`),
hooked into:

- the top-level React `ErrorBoundary` (skips plugin crashes — third-party code)
- `window.onerror` and `unhandledrejection` in `main.tsx` (skips plugin errors
  and the known Tauri `listeners[eventId]` noise)

## The rules (enforced in code — keep them when extending)

1. **Fire-and-forget.** Reporting can never throw, block, or fail the UX.
2. **Production builds only.** Dev builds are a no-op. Overrides for testing:
   `SHIPSTUDIO_BUG_REPORT_FORCE=1` (Rust side), `VITE_BUG_REPORT_FORCE=1`
   (frontend gate).
3. **Debounce.** One report per fingerprint per app session, with a session
   hard cap, on both sides. The server dedups too (same fingerprint = same
   agent session, no duplicate issues) — but don't hammer it.
4. **No PII.** Messages and stacks are scrubbed of home-dir paths (usernames,
   project folder names) in Rust via `logging::scrub_string` before leaving
   the machine. Never include user project file contents, tokens, or env vars
   in a report — reports can end up in public GitHub issues.

## The secret

`BUG_REPORT_SECRET` is compiled into the Rust binary at build time via
`option_env!("BUG_REPORT_SECRET")` — it never appears in source or in the JS
bundle. Builds without it (local builds, forks, CI without the secret) are a
silent no-op. Release CI injects it from the `BUG_REPORT_SECRET` repo secret
(both macOS and Windows workflows).

Desktop binaries can be reverse-engineered, so treat the secret as
rotate-friendly, not as a hard boundary: worst case is spam reports, and
rotation takes a minute. If it leaks, tell Julian.

## Fingerprints

Every report is deduplicated by fingerprint; same fingerprint = the agent's
existing session, no duplicate issue. When you add reporting at a known
catch-site (e.g. an `Err` branch of a command), pass a stable slug:

```rust
crate::error_reporting::report_error(
    &err.to_string(),
    None,
    "publishing",
    Some("cmd-publish_to_staging"),
);
```

Omit the fingerprint only in generic handlers — the server then hashes
`message` + top stack frame, which fragments if the message contains variable
data (paths, ports, IDs). Strip variable data from messages where you can.

## Testing the pipeline

Dev-build end-to-end test (requires the secret):

```bash
BUG_REPORT_SECRET=<secret> SHIPSTUDIO_BUG_REPORT_FORCE=1 VITE_BUG_REPORT_FORCE=1 pnpm tauri dev
```

Or send a raw test report:

```bash
curl -s -X POST https://shipstudio-admin-agent.vercel.app/report \
  -H "Authorization: Bearer $BUG_REPORT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message":"Integration test","source":"integration-test","context":{"note":"testing the pipeline, do not file an issue"}}'
```

`{"ok":true,...}` means it landed. The agent posts its verdict (filed /
duplicate / noise) to the community Slack; for a throwaway test the expected
verdict is "noise — not filed", which is the pipeline working.
