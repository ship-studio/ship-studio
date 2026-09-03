# Routines & Inbox — design notes

> Status: **prototype**. The UI on branch `prototype/routines-inbox` is clickable
> and driven entirely by fixtures in `src/lib/routines.ts`. Nothing schedules,
> spawns, or writes anything yet. This document is the plan the prototype is
> designed against, so the shape we look at is the shape we'd build.

## The idea

Give a project standing instructions that run on a trigger and report back:

- *Every 30 minutes, review what changed for security regressions.*
- *Every morning, check my dependencies for advisories and breaking majors.*
- *Every Monday, read my three competitors' blogs and tell me what they shipped.*
- *After every push, check the diff against our design-system rules.*

Findings land in an **Inbox**. From an inbox item you open the project with the
agent already primed to fix it.

## What makes this Ship Studio's version of it

Every other tool that ships this feature builds a backend: their own scheduler,
their own sandboxed runtime, their own datastore, their own model calls, their
own billing meter. Ship Studio's entire premise is the opposite — it is a
desktop shell around tools the user already installed and already pays for.

So the whole feature reduces to four boring pieces, none of them new to this
codebase:

| Piece | What it actually is | Already exists as |
|---|---|---|
| A routine | A markdown file with frontmatter | `.shipstudio/` metadata convention |
| A run | `claude -p` / `codex exec` in the project directory | `HeadlessInvocation` in `commands/ai.rs` |
| A schedule | One tokio task comparing `now` to `next_run_at` | — (new, ~150 lines) |
| A report | A markdown file written by the agent via one MCP tool | `agent_bridge.rs` loopback MCP server |

There is no Ship Studio inference, no Ship Studio storage, no Ship Studio
sandbox. If the user's Claude Code subscription can do it interactively, a
routine can do it on a timer. That's the whole trick.

## 1. A routine is a file

```
<project>/.shipstudio/routines/security-sweep.md     # project-scoped, committed
~/ShipStudio/.shipstudio/routines/competitor-watch.md # workspace-scoped
```

```markdown
---
id: security-sweep
name: Security sweep
agent: claude-code
trigger: every 30m
permission: read-only
deliver: inbox
severity_floor: warning
enabled: true
---

Review everything that changed since your last run for security regressions:
secrets committed to source, unvalidated user input reaching the filesystem or
a shell, auth checks removed from a route, dependencies pulled in from an
unfamiliar registry.

Report each finding with `ship_studio_report`. If nothing is wrong, report
nothing — do not file an "all clear".
```

A file, not a database row, because:

- **The agent can write it.** "Claude, add a routine that checks my bundle size
  weekly" is a file write, not an API we have to design.
- **A team shares it by committing it.** Routines travel with the repo. Clone
  the project, get its standing checks.
- **It diffs, greps, and reviews.** A routine that can run an agent against your
  codebase on a timer is exactly the kind of thing that should show up in a PR.
- **There is no migration story.** Ever.
- **Plugins and templates are the same thing.** A starter routine is a file we
  copy in; a plugin-provided routine is a file the plugin drops.

Mutable state (`last_run_at`, `last_status`, run history pointers) lives beside
it in `.shipstudio/routines/state.json`, gitignored — so the definition stays
clean in version control and two machines running the same routine don't fight.

## 2. A run is the agent CLI, headless

`src-tauri/src/commands/ai.rs` already resolves an agent's print mode and shells
out through `run_with_timeout`. A routine run is the same call with a different
prompt and cwd:

```
claude --print --output-format stream-json \
       --permission-mode plan \
       --mcp-config <loopback inbox server> \
       --add-dir <attached libraries>
  < prompt on stdin, cwd = project path
```

Codex takes the `codex exec` branch that's already there. Opencode likewise.
Nothing agent-specific leaks out of `lib/agent.ts`.

Three things get prepended to the user's prompt by Ship Studio, and the routine
editor shows them so nothing is hidden:

1. **Scope** — "changes since `<last_run_sha>`" plus the diff stat, so a
   30-minute routine reads a diff and not the whole repo. This is the difference
   between a routine that costs cents and one that costs dollars.
2. **Memory** — the titles and fingerprints this routine already reported, so it
   doesn't file the same finding twelve times a day.
3. **Reporting contract** — how to call `ship_studio_report`, and an explicit
   "report nothing if there's nothing" instruction.

Runs are serialized per project (one agent per repo at a time — they share a
working tree) with a small global concurrency cap. A run that overruns its
timeout is killed and filed as a failed run, visible in the routine's history.

## 3. Manual first, and two honest tiers of automation

Routines run the agent CLI on this machine. That constraint decides the shape of
the feature, so it is stated in the UI rather than papered over.

**Pressing Run is the primary trigger.** A routine is a saved instruction you
fire when you want it. Every row has a Run button and it is always live. That is
the default for a new routine, and for a lot of them it is the only trigger
anyone needs.

Automation is an opt-in on top, and what is honestly possible depends entirely
on *where the trigger is evaluated*:

### Tier A — while Ship Studio is open

Ship Studio's own scheduler: one tokio task on a 30-second tick, in Rust beside
the PTY sessions (multi-window is a first-class feature here, so two windows
must not mean two schedulers). Nothing is installed and nothing touches the
system.

This tier owns the triggers that only make sense while you are working anyway:

- `on: push` / `on: pr-opened` / `on: branch-merged` — the best fit by far. They
  fire during work, and Ship Studio already polls git and PR state.
- `on: project-open`
- `every 15m / 30m / hourly` — a minimum gap since the last run, not a clock.
- `on: dev-server-error` — the preview proxy already sees console and network
  failures.

### Tier B — even when Ship Studio is closed

A per-user launchd agent in `~/Library/LaunchAgents` (Windows: a Task Scheduler
task) running the *identical* `claude -p` command. The findings are waiting in
the Inbox when you next open the app.

This is worth offering because of what `man launchd.plist` actually guarantees:

> Unlike cron which skips job invocations when the computer is asleep, launchd
> will start the job the next time the computer wakes up. If multiple intervals
> transpire before the computer is woken, those events will be coalesced into
> one event upon wake from sleep.

So a 10:00 routine survives a closed lid: it runs on wake, **once**, not once
per missed day. The conditions it cannot escape, and which the editor states as
a list rather than a footnote:

- the Mac has to be powered on or asleep — a shut-down machine runs nothing;
- you have to be signed in, because LaunchAgents are per-user;
- the agent CLI needs a session it can use non-interactively.

**Background is offered for `daily` and `weekly` only**, and that falls straight
out of the primitive rather than being a product opinion: launchd's
`StartInterval` explicitly *misses* a firing if the system is asleep for it,
while `StartCalendarInterval` catches up. An interval that silently skipped
overnight would be exactly the dishonest scheduling this design avoids.

**Background runs are read-only, enforced.** Nobody is watching, there is no UI
to approve a permission prompt, and an unattended agent editing a repository
while you sleep is not a feature.

### What this removes

There is no "missed run" state anywhere in the UI, because no tier can produce
one. Tier A cannot miss a window — an interval is a minimum age, so it runs late
and late needs no error. Tier B cannot miss one either — launchd coalesces and
fires on wake. What the UI *does* say, on every row and in the editor, is which
tier a routine is on: "Every 30 min, when Ship Studio is open" versus "Daily at
10:00, in the background".

## 4. Delivery: one MCP tool, backed by files

The agent bridge already stands up a loopback MCP server and registers it with
the agent CLI. Add one tool:

```
ship_studio_report({ title, severity, summary, body_md, files[], fingerprint, suggested_prompt })
```

It writes `<project>/.shipstudio/inbox/2026-09-03T0930-security-sweep-a3f1.md`.
That's the entire delivery mechanism. If MCP isn't available for an agent, the
fallback is a path in the prompt and the same file on disk.

The inbox is therefore a folder of markdown files: greppable, gitignorable,
diffable, and — importantly — **readable by the next run**, which is how the
routine knows what it already told you.

**Deduplication is the make-or-break detail.** A 30-minute routine that refiles
the same finding is uninstalled within a day. Each report carries a
`fingerprint` (agent-supplied, stable across cosmetic changes); a repeat bumps
`occurrences` and `lastSeenAt` on the existing item instead of creating a new
one. An item the user archives is muted by fingerprint until it changes.

## 5. The inbox closes the loop

This is the part that makes it Ship Studio rather than a notification list. An
inbox item is not something you read — it's the head of a work session:

- **Fix with agent** → opens the project workspace, spawns a terminal tab, and
  pre-fills the prompt with the report and its file references. The user presses
  Enter. Report → interactive session → PR, without leaving the app.
- **Snapshot & fix** → takes a rewind point first, then the above.
- **Open file** → code mode at the referenced line.
- **Archive / Snooze / Mute this finding**

The prototype wires the reading and the routing; the "Fix with agent" handoff is
mocked at the point where it would hand off to `useTerminalManagement`.

## 6. Trust and cost

Two things will decide whether anyone leaves this turned on:

- **Read-only by default.** Routines run in the agent's plan/read mode. A
  routine that may edit files is an explicit opt-in and is badged everywhere it
  appears. No routine gets `--dangerously-skip-permissions` from a checkbox —
  if that's ever supported it's per-routine, typed-confirmation, and loud.
- **Visible price.** Every run records duration and tokens; the routine row
  shows a rolling cost so "every 30 minutes" is a decision the user makes with
  the number in front of them. The editor shows the literal command line. There
  is no hidden orchestration to be surprised by.

## Naming

The prototype calls the tab **Routines**, not "Agents".

Ship Studio already uses "agent" precisely: Claude Code / Codex / Opencode, the
CLI in the terminal. There's an Agents card on the dashboard for managing them
and an `AgentsPanel` component. A second, different "Agents" tab meaning
"scheduled prompts" would collide with the app's own vocabulary on day one.

"Routines" says what it is — a standing instruction on a schedule — and leaves
"agent" meaning the thing that runs it. Worth deciding deliberately before any
of this ships, because the name ends up in the sidebar, the palette, the docs,
and the file path.

## What the prototype covers

- Routines list: scope, schedule, agent, permission badge, last result, next
  run, always-visible Run, and an auto-run switch for armed triggers
- Creation flow: two steps matching Create Project — grouped template cards with
  a selected state and an explicit Continue, then a form split into *what it
  does* (name, instruction) and *how it runs* (project, agent, trigger,
  permission, command preview), with unreplaced template blanks flagged before
  you can create a routine that would report nothing useful
- Run log: a realistic headless transcript, so the "it's just `claude -p`" story
  is visible
- Inbox: list/detail, severity, unread, per-project and per-routine filtering,
  recurrence, and the action bar

## What it deliberately does not cover

Scheduling, spawning, MCP tooling, file writes, dedup logic, cost accounting,
notifications, and the terminal handoff. All fixtures.

## Open questions

Three things the prototype does not answer, in the order they would bite:

1. **Working-tree contention.** A routine shelling into a project you are
   actively editing reads a dirty tree, and a `can-edit` routine fights your
   interactive agent outright. Worktrees already exist here; a routine probably
   wants a dedicated one pinned to the last known commit.
2. **Quota.** A half-hourly routine spends the same agent allowance you need for
   real work, and Ship Studio does not own that meter. It can only show the cost
   and back off — likely a budget ceiling plus a "not while I'm working" rule.
   This is also the argument for keeping `all-projects` scope out of v1: a
   half-hourly sweep across twelve repos is a quota bomb.
3. **Deduplication.** A routine that refiles the same finding every thirty
   minutes is uninstalled within a day. The fingerprint is modelled in the data
   but the matching rules are not designed.
