# Testing onboarding

Onboarding has historically been the worst screen in this app to work on, for
one structural reason: **its whole subject is a machine state you do not have.**
The interesting parts only exist on a computer with nothing installed, during a
network failure, or on Windows. Every change cost a full run-through to look at,
and most states were never seen by anyone before a user hit them.

This document is the fix. Four layers, cheapest first. Use the cheapest one that
can answer your question.

| I want to… | Use | Cost |
|---|---|---|
| See any screen, in any state, right now | [Playground](#1-the-playground) | seconds |
| Know the flow's logic is right | [Protocol tests](#2-protocol-tests) | `pnpm test:run` |
| Know a screen still renders correctly | [Harness scenarios](#3-harness-scenarios) | one command |
| Know it works on a real fresh machine | [The VM](#4-a-real-fresh-machine) | ~10 min |

---

## 1. The playground

```bash
pnpm harness
open 'http://127.0.0.1:1425/harness.html?scenario=onboarding-playground'
```

The real onboarding flow, with every variable that used to require a different
computer turned into a dropdown:

- **Start on** — jump straight to any screen. No more four answers deep to check
  one sentence.
- **Machine** — nothing installed, partly installed, everything already there.
- **Agent** — which one was picked.
- **Make this fail** — force any step to fail, and land on the recovery screen.
  This is the state that previously required an actual broken network.
- **Pretend OS** — render the macOS and Windows copy on the same machine. This
  caught two shipped-quality bugs within a minute of existing: a footnote
  promising "your password goes straight to macOS" on Windows, and an offer to
  install Homebrew on a platform that has no Homebrew.
- **Speed** — real-time for watching, instant for iterating.

**Every setting is in the URL.** A bug report is a link, not a paragraph:

```
harness.html?scenario=onboarding-playground&step=installing&failStep=git&platform=windows
```

It renders the *real* `FlowOnboarding` against the *real* fixture backend.
Nothing in the playground reimplements a screen, so it cannot drift from what
users get.

## 2. Protocol tests

```bash
pnpm test:run src/lib/installAgent.test.ts
```

The flow's logic is a driver that emits events and a host that answers them, so
its guarantees are testable without a DOM, a machine, or a UI. These assert the
promises the design rests on:

- A declined password does not end the session.
- A failure is always a question, never a silent skip.
- Retrying actually retries; skipping records it; stopping ends as `blocked`.
- Abandoning a step marks its dependents unreachable instead of letting them
  fail with an error nobody can act on.
- A finished run reports what it left out.
- Failure text never contains a command or a stack trace.

Add a case here whenever you change what the flow *decides*. Add a scenario
below when you change what it *looks like*.

## 3. Harness scenarios

```bash
pnpm harness &
node scripts/harness-capture.mjs onboarding
```

Screenshots of every onboarding state, deterministic enough to diff:

| Scenario | State |
|---|---|
| `onboarding-fresh` | The first question |
| `onboarding-flow-admin` | The password handoff |
| `onboarding-flow-installing` | Mid-install |
| `onboarding-flow-failure` | An install failed |
| `onboarding-flow-signin` | Sign in to the agent |
| `onboarding-flow-host` | The last question |
| `onboarding-flow-celebration` | Done |
| `onboarding-flow-partial` | A machine that already has an agent |
| `onboarding-auth-only` | Installed but signed out (classic wizard) |

Two mechanisms make the later screens reachable, both worth knowing about:

- `data-flow-step` on `.flow-screen` — every screen renders the same handful of
  classes, so without this the two `.button--primary` screens are
  indistinguishable to a selector.
- `shipstudio.installAgentPace` in scenario `storage` — the scripted install
  takes ~12s, longer than the harness waits for a step. A scenario about a
  screen *after* the install collapses the pace; one about the install itself
  leaves it alone.

`shipstudio.installAgentFailStep` forces a specific step to fail, which is how
the failure scenario exists at all.

## 4. A real fresh machine

Everything above uses the scripted driver. It exercises the flow, the copy and
the decisions — but it never touches your machine, so it cannot tell you whether
Homebrew actually installs.

```bash
./scripts/onboarding-vm.sh fresh   # pristine macOS VM with the DMG mounted
./scripts/onboarding-vm.sh reset   # throw it away
```

See the "Testing on a Fresh Machine" section of `CLAUDE.md` for the one-time
Tart setup. Budget ~35GB.

**This is still the only thing that proves an install works.** Use it before a
release that touches setup, not on every change.

## The env-var modes

These predate the playground and still work. They boot the whole app rather than
one flow, which is what you want when the question involves the app *around*
onboarding (does it redirect back? does the dashboard load after?).

```bash
SHIPSTUDIO_FORCE_SETUP=fresh pnpm tauri dev        # mocked statuses, scripted agent
SHIPSTUDIO_FORCE_ONBOARDING=1 pnpm tauri dev       # real checks, real agent
```

Note that `SHIPSTUDIO_FORCE_SETUP` spawns **real terminals** for terminal-based
items, which will do real things to your machine. The playground does not, which
is usually the reason to prefer it.

## What is still not covered

Said plainly, because a testing doc that overclaims is worse than none:

- **The real install agent.** The only driver today is scripted. The fx-backed
  one needs an AI Gateway key — see `spikes/fx-install-agent/`.
- **The sign-in screens.** `signin` and `github` currently advance on click;
  they do not yet run `claude setup-token` or `gh auth login`.
- **Windows for real.** The playground proves the *copy* is right on Windows.
  It does not prove winget works.
