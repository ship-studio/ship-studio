# Routines & Inbox

A **routine** is a standing instruction: a prompt, a project, and something that
sets it off. Running one invokes the user's own agent CLI headless in the
project directory. What it finds is filed to the **Inbox**.

## What makes this Ship Studio's version of it

Every other product in this space runs your code on their servers, stores your
findings in their database, and bills you for their inference. Ship Studio's
whole premise is that you already have the good tools — Claude Code, Codex, a
terminal, a repo — and it should get out of the way.

So the feature reduces to four boring pieces, three of which already existed:

| Piece      | What it is                            | Lives in                                        |
| ---------- | ------------------------------------- | ----------------------------------------------- |
| A routine  | a markdown file with frontmatter      | `<project>/.shipstudio/routines/<slug>.md`      |
| A run      | `claude --print` / `codex exec`       | `src-tauri/src/commands/routines/runs.rs`       |
| A schedule | a tokio tick over armed routines      | `src-tauri/src/routine_scheduler.rs`            |
| A report   | the last fenced JSON block in a reply | `parse_findings` in `runs.rs`                   |

There is no Ship Studio server, no copy of your code anywhere else, and no
inference we bill for. Tokens go to the plan you already pay for.

## 1. A routine is a file

```markdown
---
name: Dependency drift
icon: 📦
description: Daily advisory check plus a read on which majors are worth taking.
trigger: daily at 09:00
permission: read-only
severity-floor: warning
auto-run: true
---

Check the installed dependencies against known advisories. For anything with a
published fix, say what upgrading costs. Ignore dev-only packages.
```

Frontmatter is **not** real YAML: the parser accepts a flat list of `key: value`
lines and nothing else. No nesting, no block scalars, no quoting rules. That is
deliberate — the primary authoring path is an agent writing this file by hand
(§5), and a small surface is one a model cannot get subtly wrong.

`trigger` is a human phrase rather than a nested object for the same reason:
`trigger: daily at 09:00` is written correctly first time far more reliably than
a three-key sub-map. The grammar is `manual`, `every <n>m|h`, `daily at HH:MM`,
`weekly on <weekday> at HH:MM`, `on push`, `on pr`. An unrecognised phrase falls
back to `manual` — one typo costs the schedule, not the routine.

Unknown keys round-trip untouched, so an older Ship Studio editing a file
written by a newer one doesn't silently drop its values.

**Definitions live in the repo. Results do not.** Routine files are source: read
them, edit them, review them in a PR, commit them. Run history and findings are
per-machine churn that would appear in `git status` within a day of real use, so
they go to `~/ShipStudio/.shipstudio/routines-state.json`, next to `folders.json`
and `attached-libraries.json`.

## 2. A run is the agent CLI, headless

`run_routine` builds a prompt (the routine body, plus what changed since the
last run, plus the fingerprints already filed) and shells out.

### Read-only is enforced, not requested

Both supported agents have a real mode for this. Verified against the installed
CLIs, not assumed:

| Agent       | Read-only                 | Can edit                    |
| ----------- | ------------------------- | --------------------------- |
| Claude Code | `--permission-mode plan`  | `--permission-mode acceptEdits` |
| Codex       | `--sandbox read-only`     | `--sandbox workspace-write`  |

Plan mode still allows `Read`, `Grep`, `Glob` and `Bash`, so the routine does its
analysis — but the CLI itself refuses `Write` and `Edit`. A routine instructed to
create a file replies that it can't, and no file appears. Codex's sandbox gives
the same guarantee one layer down.

This matters because the UI says "read-only is enforced". If enforcement were
only a line in the prompt, that sentence would be a lie, and an unattended agent
is exactly where that lie costs someone their work.

### Read-only is the default

An omitted `permission:` key parses as `read-only`. An unattended agent that can
edit is a decision, never an accident.

## 3. The report is a fenced JSON block

The agent is told to end its reply with one ```json block:

```json
{
  "findings": [
    {
      "title": "…",
      "severity": "critical|warning|info",
      "summary": "one line",
      "body": "markdown",
      "fingerprint": "stable-slug",
      "locations": [{ "path": "src/x.ts", "line": 12, "note": "why" }],
      "suggestedPrompt": "what to tell an agent to fix this"
    }
  ]
}
```

An MCP tool (`ship_studio_report`) would be tidier and is the intended v2. The
fenced block wins for v1 because it works identically for Claude's `--print` and
Codex's `--output-last-message`, needs no server registration, and — decisively —
needs **no write permission**, so it composes with the read-only enforcement
above instead of fighting it.

`{"findings": []}` is a normal outcome and the prompt says so twice. The failure
mode that kills an inbox is a routine that files "no issues found" every thirty
minutes.

### Dedup

A finding's identity is `hash(routine_id + agent_fingerprint_or_normalized_title)`.
A repeat bumps `occurrences` and refreshes the timestamp rather than filing a
second copy — a 30-minute routine would otherwise produce 48 identical items a
day. **Archiving is sticky**: once you've said you don't want to hear about
something, a recurrence must not un-archive it.

## 4. Scheduling, honestly

Routines are your agent CLI on your machine. There is no server, so **nothing
fires while Ship Studio is closed**, and every sentence in the UI says so.

One tokio tick, once a minute, over every armed routine in every known project:

- **It never catches up.** An interval means "at least this long since it last
  looked". Close the app for a week and you get one run on reopen, not a week of
  backlog. A daily routine due while the app was closed is simply late.
- **At most one routine per tick.** Runs spend your own subscription. Five armed
  routines coming due in the same minute must not fire five agents at once.
- **It skips anything already in flight.** Two agents reasoning about the same
  working tree is confusing at best, and a corruption risk if either can edit.

Event triggers (`on push`, `on pr`) fire from the backend at the tail of the
commands that complete those actions (`push_branch`, `create_pull_request`),
spawned rather than awaited so publishing a branch never sits behind an agent
run. They fire during work — exactly when the app is open, so the honesty
problem doesn't arise.

There is deliberately no `on project-open` trigger. It parses nowhere and fires
nowhere: starting an agent run every time you open a project is a quota trap
dressed as a convenience.

There is **no "missed run" state anywhere**, because neither mechanism can
produce one.

### The background tier is not built

An earlier design proposed a second tier: a per-user launchd agent for daily and
weekly triggers, firing whether or not the app is open. `man launchd.plist` says
`StartCalendarInterval` catches up on wake and coalesces missed firings, so it is
genuinely feasible. It is not implemented, so **there is no control for it** —
rather than a switch that sits there doing nothing. It writes to
`~/Library/LaunchAgents`, needs a clean uninstall path, and has no Windows
equivalent yet.

## 5. Discovery: the agent introduces the feature

This is the part that makes the file format load-bearing rather than incidental.

Nobody browses a new tab. But everyone using Ship Studio is already talking to an
agent all day, and they routinely say things like "check the bundle size before
every release" or "I keep forgetting to look at dependency advisories".

Ship Studio installs a `shipstudio-routines` skill into each installed agent's
user-scope skills directory (`~/.claude/skills/`, `~/.codex/skills/`) at launch.
The skill's `description` — which is what decides whether the agent loads it at
all — names the phrasings people actually use ("every time", "each week", "before
every release", "keep an eye on", "I keep forgetting to"), not the word
"routine", which is the one word someone who hasn't found the feature will never
say.

Once loaded, the skill documents the file format completely enough that the agent
writes the routine itself. No API, no MCP tool, no Ship Studio call. The
frontend store polls as well as listening for backend events, precisely so a file
that appears on disk without the UI being touched still shows up.

The install is idempotent and version-stamped, and skips agents whose config
directory doesn't exist — scattering folders into someone's home for tools they
don't use is not ours to do.

## 6. Watching a run

A run is 30 seconds to a couple of minutes of nothing. A spinner answers "is it
running"; it does not answer "is it doing anything sensible", which is the
question people actually have the first few times they trust an unattended agent
with their repo.

So Claude runs with `--output-format stream-json` and each event is translated
into one human line — `Reading …/src/api/checkout.js`, `$ git diff --stat`, or
the agent's own narration — kept in a small ring buffer per routine and pushed
to open windows as it happens. The row shows the newest line; the rest is behind
a chevron. Deliberately not the full transcript: run history already has that.

## 7. The inbox closes the loop

A finding is not a notification; it's the head of a work session. The primary
action is **Fix in \<project\>**, which opens the finding's workspace and types
`suggestedPrompt` into its terminal.

That crosses a navigation boundary (the Inbox is home-level, the terminal only
exists inside a workspace) and the trip is asynchronous — opening a project
mounts a workspace, spawns a PTY and boots an agent. So the prompt goes through
a one-slot queue (`lib/routineHandoff.ts`) with a TTL, peeked-then-consumed by
`useRoutineHandoff` once a terminal actually accepts it.

The action bar is pinned to the foot of the reader rather than sitting at the end
of the report: a long finding would otherwise push the entire point of the
feature below the fold.

## 8. Cost

Every run spends the user's own agent subscription. A trivial three-file repo
cost ~73k tokens in an end-to-end test — mostly system prompt and cache, but it
is not free and it is not small.

That shapes several decisions: manual is the default trigger; intervals are
floored at 5 minutes; the scheduler runs one routine per tick; there is
deliberately **no "Run all routines" command** in the palette; and the token
column shows an em dash rather than a zero when the CLI reports nothing (Codex
`exec` reports no usage, and a confident "0" would read as a free run).

## Testing

```bash
cd src-tauri && cargo test routines           # 38 unit tests
pnpm vitest run src/lib/routines.test.ts src/lib/routineHandoff.test.ts
pnpm vitest run src/components/routines src/components/inbox
```

There is also a real end-to-end test that runs an actual agent against a real
git repo. It is `#[ignore]`d because it spends quota and needs a signed-in CLI:

```bash
cd src-tauri && cargo test e2e_runs_a_routine_against_the_real_agent -- --ignored --nocapture
```

It asserts the run completes **and** that a read-only routine wrote nothing.

## Open questions

- **Working-tree contention.** A routine shelling into a repo you're actively
  editing reads a tree mid-change. Read-only makes this survivable (a stale read,
  not a corrupt write), and the in-flight guard stops two runs colliding. A
  `git worktree` per run is the eventual answer.
- **Quota.** Nothing stops someone arming a dozen 15-minute routines and burning
  a month's allowance in a week. There is no budget, cap, or projection yet.
- **Fingerprint drift.** Dedup leans on the agent producing a stable fingerprint,
  with a normalised title as fallback. A model that rewords a finding *and* omits
  the fingerprint files a duplicate.
- **Notifications.** There is no desktop-notification path. A `notify:` key is
  preserved verbatim if a file has one, but it is not documented to agents and
  does nothing — advertising a no-op key would be the same dishonesty this
  design spends its effort avoiding.
