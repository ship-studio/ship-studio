# Built-in install agent (fx / libfx)

Status: spike. Branch `worktree-fx-install-agent`.

## The problem, in our own words

From `src/lib/agentOnboarding.ts`:

> Phase 0 gets exactly one AI agent installed + signed in (**the only part that
> can't be agent-led**).

That caveat is the whole project. Our agent-led onboarding is circular: we ask the
user to install and sign into a coding agent *before* the agent can install
anything. Phase 0 is where the ~50% install churn happens, and it is the one phase
no agent can help with — because there is no agent yet.

A bundled agent removes the circularity. The app installs Homebrew/winget, Node,
Git, GitHub CLI **and the user's chosen coding agent CLI**; the user signs into
their own subscription at the end, on a machine that already works.

## What we are NOT doing

Not building a general coding agent. Ship Studio's position is that it works with
the AI subscription you already pay for — Claude Code, Codex, Opencode, Cursor.
The built-in agent exists for jobs that must happen *before* those exist, and it
hands off the moment they do.

## Why fx specifically

- Embeddable by design: `libfx` is an agent kernel, not a CLI with a wrapper. On
  import it performs no MCP connection, no skill scan, no process spawn, no
  filesystem read.
- **The host is the authority for tool effects.** We pass `tools: [{ name,
  description, inputSchema, execute }]` — so every install step runs through our
  own Rust commands and our own permission model, not a third party's.
- `checkpoint()` returns opaque bytes; the host owns durable storage. Fits how we
  already persist sessions.
- Structured streaming events (`text_delta`, `tool_start`, `tool_end`) instead of
  scraping a PTY.
- Under the hood both backends are an ACP server, so a Rust sidecar speaking
  newline-delimited JSON-RPC is available as the production shape.

## Architecture options

| Shape | Fit | Notes |
|---|---|---|
| `libfx` WASM in the webview | Spike | Tools are `invoke` calls we already have. No binary to bundle or notarize. Chosen for the prototype. |
| `fx acp` binary as a Tauri sidecar, Rust speaks JSON-RPC | Likely production | Cleaner for a process-heavy install agent. Needs macOS arm64/x64 + Windows binaries bundled and notarized. |
| `libfx` N-API | Out | No Node runtime in a Tauri app. |

## Cost model — the number the pitch needs

An install agent runs a short, bounded, highly-scripted task. It does not need a
frontier model; fx's own SDK example uses `google/gemini-2.5-flash-lite`.

So instrument it and measure rather than estimate:

1. `turn.result` returns `{ stopReason, usage }` with input/output tokens. Sum per
   onboarding run.
2. Run it on genuinely fresh machines via the existing Tart harness
   (`./scripts/onboarding-vm.sh fresh`) — the one place a real install actually
   happens.
3. Report median and p90 tokens per completed onboarding, times Gateway list price
   for the chosen model.

Expected shape of the answer: **cents per user, not dollars.** That is what makes
the credits ask small enough for Vercel to say yes to, and it is worth leading
with in the video.

## Open questions

- fx is experimental and `libfx` is at 0.0.8. Version-pin and treat the API as
  moving.
- Fallback when the agent fails mid-install: the classic wizard already exists as
  the escape hatch ("Try classic onboarding") — reuse it, don't invent a new one.
- Windows: winget/PowerShell paths are the least-tested part of onboarding today.
- Credential: `FX_AUTH_MODE=host-managed` lets the key live in Rust so the user
  never sees one. Requires the sponsored key to be scoped and rate-limited — a
  key shipped in an open-source app is a key that will be extracted.
