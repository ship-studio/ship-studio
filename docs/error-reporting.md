# Automatic Error Reporting (Admin Agent)

Ship Studio can automatically send uncaught errors from production builds to
the Ship Studio admin agent — an AI pipeline that investigates reports against
the `ship-studio/ship-studio` codebase and may file deduplicated GitHub issues
or open draft fix PRs (it cannot merge). A successful send confirms that the
endpoint accepted a report; it does not confirm that an investigation finished
or that an issue was filed. This is separate from Sentry, which handles
aggregation and alerting.

## The endpoint

```
POST https://shipstudio-admin-agent.vercel.app/report
Authorization: Bearer <BUG_REPORT_SECRET>
Content-Type: application/json
```

Body fields: `message` (required), `stack`, `source`, `appVersion`,
`fingerprint`, `context` (JSON object). Get `BUG_REPORT_SECRET` from Julian —
never commit it.

The client records a delivery receipt only when the endpoint returns a 2xx
response containing `{ "ok": true }`. A returned issue URL is retained only
when it is an HTTPS `github.com/<owner>/<repo>/issues/<number>` URL. The
endpoint's acceptance response is not an issue-filing verdict.

## What gets reported (coverage map)

The goal: **anything not working as intended reaches the agent**, without
per-site wiring. Coverage comes from choke points, not scattered calls:

| Surface | Choke point | Fingerprint |
|---|---|---|
| Rust panics | panic hook in `error_reporting.rs` (chained in front of Sentry's) | `panic-<file>:<line>:<col>` |
| Unexpected command failures sent to the UI | `CommandError`'s `Serialize` impl (`errors.rs`) — fires when the rejection crosses IPC; expected states and validation feedback are excluded | `cmderr-<variant>-<cmd/field>` |
| Any backend `tracing::error!` | `AdminAgentLayer` tracing layer, attached in `logging::init_logging()` | `rs-<file>:<line>` (callsite) |
| Frontend crashes (ErrorBoundary, PanelErrorBoundary) | `reportRenderCrash` (`src/lib/renderCrash.ts`) → `logger.logError` → forwarding; a panel crash adds `panel` to the context | message-based |
| Any `logger.error` / `logger.logError` | forwarding inside `Logger.log()` | message-based |
| Uncaught JS errors / unhandled rejections | `window` handlers in `main.tsx` | message-based |
| Error toasts (user-visible failures) | `showToast(…, 'error')` in `useToasts` | message-based |

Excluded on purpose: plugin crashes (`blob:` stacks — third-party code), the
known Tauri `listeners[eventId]` noise, error logs from dependencies (the
tracing layer only forwards `ship_studio*` targets), and
`CommandError::NotAuthenticated` (a not-yet-connected integration is an
expected state, not a malfunction).

**The rule for new code**: if something fails in a way that isn't the user's
expected flow, call `tracing::error!` (Rust) or `logger.error` (frontend) or
surface an error toast — any of those automatically notifies the agent. For
high-value catch-sites, call `report_error` directly with a stable fingerprint
slug (see below).

All reporting funnels through **`src-tauri/src/error_reporting.rs`**
(`report_error` — async fire-and-forget POST, 5s timeout; the
`report_frontend_error` command relays frontend reports) and
**`src/lib/errorReporting.ts`** (`reportError`) on the frontend. The separate
`get_automatic_report_status` command and `src/lib/autoReports.ts` wrapper
expose recent confirmed deliveries to Settings.

## Cost controls

Reports can trigger paid agent investigations, so spam protection is layered —
all of it client-side before a single byte leaves the machine:

1. **Incident collapse** — one failure often fires several channels within
   milliseconds (backend error log → `CommandError` over IPC → error toast).
   The first channel to send wins; anything else within 5s is suppressed
   without recording dedup state, so real recurrences still report. Panics
   bypass the gap — a crash report is never swallowed by a lesser error.
2. **Session dedup** — one report per fingerprint per app session, on both the
   frontend (cap 20) and Rust (cap 25) sides.
3. **Cross-session refractory** — the same fingerprint reports at most once
   per 24h, persisted in `bug-report-throttle.json` next to `app_state.json`.
   This file records attempts for cost control, whether or not the network
   accepted them. A crash-looping install that relaunches every few seconds
   still attempts at most one report per day per bug.
4. **Daily cap** — at most 30 reports per machine per day, whatever happens.
5. **Server-side dedup** — same fingerprint = same agent session; repeats are
   noted on the existing session, not new investigations.

Throttle I/O fails open (a corrupt/unwritable file falls back to session dedup
only) — cost protection must never disable crash reporting entirely.

Confirmed delivery receipts live separately in
`automatic-report-receipts.json`. The ledger keeps at most 50 scrubbed
summaries for 30 days. It is not an attempt history: throttled, disabled,
unconfigured, timed-out, rejected, or otherwise unconfirmed sends never create
a receipt. A missing receipt therefore does not prove that no attempt was
made or that the endpoint did not accept one; local storage can fail, and the
panic path can skip a contended receipt write to preserve its timeout. A
receipt does not say whether the report is still under
investigation, was considered noise, or was deduplicated against an existing
agent session. Server-side fingerprint deduplication remains the duplicate
issue protection; do not tell users an issue is already filed unless an
explicit, validated issue URL was returned.

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

## User consent & what we collect

Bug reporting is governed by the same Settings toggle as analytics — **"Usage
analytics & error reports"**. When the user turns it off, this pipeline is
fully disabled (the check lives in `error_reporting::enabled()`, the single
gate every report passes through — frontend reports included, since they relay
through the `report_frontend_error` command). No opt-out, no data, period.

What a report contains, exhaustively:

- the error message and stack trace (both scrubbed: `/Users/<name>`,
  `/home/<name>`, `C:\Users\<name>` become `<redacted>` before leaving the
  machine)
- the subsystem/source name and a fingerprint slug (also scrubbed)
- the app version, OS name (`macos`/`windows`/`linux`) and CPU architecture

What is never collected: project file contents, code, env vars, tokens,
usernames, machine identifiers, or anything else. Reports can end up in public
GitHub issues, so the bar is "safe to publish."

The ErrorBoundary does not claim that its current crash was sent. It directs
users to Settings for recent confirmed deliveries and explains that a receipt
means endpoint acceptance, not issue filing. Receipts contain only timestamp,
crash/error kind, scrubbed source and summary, plus an optional endpoint-returned
validated GitHub issue URL. The `crash` kind is reserved for Rust panics and
the explicit React ErrorBoundary `frontend-crash` source; other report sources
remain `error`.

Render crashes are contained per surface. `PanelErrorBoundary` is built into
`DockablePanel` (every rail panel and floating tool) and `ModalFrame` (every
modal body), and wraps each workspace tab's content and the colour picker. A
crash there replaces only that surface with a local Retry, and reports through
the same `frontend-crash` path with `panel` set (`variables`, `color-picker`,
`modal:Settings`, …), so a report says which screen it came from. Only a crash
outside every panel reaches the top-level `ErrorBoundary`. Like it, the panel
fallback never claims the crash was sent.

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

Two gotchas when testing: the Settings analytics toggle must be ON (the
opt-out is absolute — it beats the force flags), and consecutive test triggers
must be more than 5s apart or incident collapse will suppress the second one.

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
