# Team (multiplayer)

**Status: built.** Every screen here runs against the real backend
(`src-tauri/src/commands/team/`). Team lives inside a project — the workspace
panel, Cmd+K, and the presence cluster in the project header.

Building is a multiplayer game, but Harbr is free, open source, and has
no server, no accounts and no database. So this feature is built on the two
things a team already has: **their repository, and the coding agents they are
already paying for.**

## What makes it Harbr's version

| Problem a multiplayer backend normally solves | Solved here by |
| --- | --- |
| Identity | the GitHub login behind the push (`gh api user`) |
| Authorization | repo access — no push right, no write |
| Durability | it is a git repo, replicated on every clone |
| Ordering | ULID ids plus git history |
| Review | pull requests |
| Offline | native; a clone is a full replica |

Nobody is invited to anything. The people who can see your team activity are
the people who can already see the repository, which is a permission model the
team has already agreed on and already maintains.

## 1. Two halves, and they need different things

| Half | Source | Needs |
|---|---|---|
| **What people did** (`derive.rs`) | `git log`, `gh pr list` | a good commit message |
| **Comments** (`records.rs`, `threads.rs`) | `.shipstudio-team/threads/**` | Harbr |

The first half reads git's own fields. A commit **subject** is the headline and
the commit **body** is the why — which is where "why" has always belonged, and
which `git log`, GitHub and code review already display.

An earlier version of this wrote a second copy of that prose into a record file
under `.shipstudio-team/updates/`, joined back to its commit by a
`Ship-Studio-Update:` trailer. That was a format only this app could read,
describing something git already knew, and it gave every writer two chances to
get one sentence recorded — with a silently empty row whenever the second was
missed. It is gone.

So the goal is not to collect explanations somewhere else. **It is to make
writing a legible commit the default**, in a tool people already use, so that
the team always knows what is going on:

- `push.rs` asks the agent for the message and puts the reasoning in the body
- `skill.rs` and `instructions.rs` teach an agent to write one unprompted
- the feed makes the difference visible, so a thin commit looks thin

Everything that produces is a better `git log` for people who have never opened
this app, which is the test of whether it was worth doing.

**A commit with no body is never dressed up.** It produces a row saying only
what git can prove. Guessing a `why` back out of a diff would invent the one
thing the row cannot know.

## 2. Comments are the part that needs a format

A note pinned to an element, on a page, at a viewport has no equivalent in git
or GitHub. So that structure is ours, and it is the only part of the feature
with a file format.

Every record is written **once**, to its own file named by its own id, and never
modified:

```
.shipstudio-team/threads/2026-09-07/01K4J8Q2-mayareed.json
```

Two people writing in the same second produce two different files, so git merges
them with no conflict — by construction, not by luck. Put the same data in one
`activity.json` and every concurrent write is a merge conflict in a JSON blob,
which is the failure that ends the feature in week one.

Mutation is therefore also an append: resolving a comment writes a new record
rather than editing the old one, and current state is a **fold** over the
records computed at read time. That is the only form that survives two people
acting at once — both files land, the fold takes the later one, nobody's work is
lost to a merge.

Authorship is enforced **in the fold**, not trusted from the file: anyone with
push access can write any JSON they like, so an edit or retraction of someone
else's message is written and then never rendered, by anyone.

**Note the path.** `ensure_gitignore_has_shipstudio`
(`src-tauri/src/commands/projects/mod.rs`) gitignores the whole `.shipstudio/`
directory, so team data cannot live there.

### Reading is lenient, writing is strict

These files arrive over git from other people's machines running other people's
versions of this app. So on the way **in**, an unknown field is ignored and an
unknown record kind is skipped — one teammate upgrading must never blank the
feed for everyone who hasn't. On the way **out** the same shape is checked with
hard caps, because that is the moment an agent could put something into the
repository permanently.

## 3. Three writers, ranked by how much they can be relied on

| | Writer | Reliability | Covers |
| --- | --- | --- | --- |
| 1 | git itself | deterministic | that a commit, branch, PR or push happened |
| 2 | Harbr's push flow | agent may decline | the reasoning, in the commit body |
| 3 | Any agent, anywhere | best effort | the same, plus resolving comments |

**Layer 1 backfills for 2 and 3, never the reverse.** If no agent writes a body,
the row still exists with what git can prove — you lose the explanation, not the
entry. If every agent on the team ignored the skill forever, the feed still
works; it just reads like a git log, which is exactly what it would have been.

That is the same standard agent-led onboarding already holds: *the agent drives,
the app verifies.*

### How everyone's agent gets the protocol

Three routes, deliberately, because each one covers a gap the others leave:

| Route | Reaches | Written when |
|---|---|---|
| `~/.claude/skills/shipstudio-team/` (`skill.rs`) | every project you open | app startup, idempotent |
| MCP tools on the agent bridge (`bridge.rs`) | agents inside Harbr's terminal | session start |
| `CLAUDE.md` / `AGENTS.md` (`instructions.rs`) | **everyone who clones the repo** | only when the user asks |

The first two are user-scope: they cover you, on this machine, in any project.
Neither reaches a teammate who has never installed Harbr.

The third does, because it is committed — and that is exactly why it is **never
written on startup**. It edits a tracked file in someone's repository. It
happens on an explicit action (the coverage note in the feed offers it), once,
in one clearly-marked block, appended rather than merged into their prose, and
if they delete it it stays deleted. Re-adding it on the next launch would be
arguing with someone through a file.

A skill has to *trigger*, and "push" is a one-word prompt carrying almost no
signal, so a skill fires often enough to be useful and not often enough to be
relied on. A project's instruction file has no such problem: it is read at the
start of every session by every agent whether or not anything fires. That is why
the durable answer is the committed one.

## 4. Privacy: enforced, not requested

Everything here is committed history. Unpublishing means rewriting published
history, so a leak is effectively permanent. There is no server, so there is no
scrubber and no revocation. The human is the last filter, not the first.

A commit message is *more* exposed than a record file was, not less: it is in
`git log`, in the pull request, on GitHub, and in every blame view forever.
Moving the prose there raised the stakes on everything in this section.

### What is mechanically enforced

In `writer.rs`, before anything is committed:

1. `#[serde(deny_unknown_fields)]` — an agent cannot invent a `transcript` field
2. Field allowlist: the agent writes `headline`, `why`, `changes[]`, `asks`
3. Caps (headline ≤ 120, why ≤ 600, ≤ 8 changes ≤ 200, asks ≤ 300).
   **Over-length is a rejection, not a truncation** — truncating mid-sentence
   publishes half a leak
4. Shape rejection: code fences, `>` quote lines, `+`/`@@` diff prefixes, more
   than two newlines. The mechanical proxy for "don't paste the session"
5. Absolute paths rewritten repo-relative (via `scrub_string` in
   `src-tauri/src/logging.rs`)
6. Secret scan against the project's own `.env*` values plus known key prefixes
   → **hard reject, and say rotate it**. Never silently redact: that turns a
   rotate-your-key incident into a thing nobody knew happened

The gauntlet runs in `push.rs`, on the path to the commit message. A summary it
refuses drops **whole** — the push continues with Harbr's plain default
message rather than a partially-cleaned one. A push that cannot happen is worse
than one that explains itself poorly.

### What is best-effort

The skill's prompt: don't quote the user, don't name people outside the repo,
don't characterise a teammate's work, write about the code not the session.
These help and they are not guarantees.

**The honest line: shape, length and known-dangerous strings can be enforced.
Meaning cannot.** There is no mechanical answer for "the user said something
unkind about a colleague" — that limit is stated rather than papered over with a
detector nobody trusts.

### Defaults

| | Default |
| --- | --- |
| Conversation, prompts, agent reasoning, tool calls | **out — no field, no setting** |
| Terminal output, dev-server logs, stack traces | out |
| Diff content, code excerpts | out (already in git) |
| Screenshots | out — no scanner reads pixels |
| Machine info, IP, location, timings, token spend | out |

### Settings

Two switches, both in Settings, both stated next to what they do:

- **Let your agent write the commit message** (`team_sharing_enabled`, on).
  Off falls back to the plain default message: a push still works, it simply
  arrives with a subject and no reason.
- **`Made-With` attribution** (`commit_attribution_enabled`, on). A trailer,
  never the subject, so `git log --oneline` reads exactly as it did before.

Comments have no switch, because writing one is already an explicit act.

### Refused outright

No conversation or transcript field at any setting. No terminal output. No
screenshots. No presence or effort telemetry. No aggregate summaries about
people — commit data plus an LLM makes "who is slowest" trivial, and in a repo
everyone can read. And no "delete this record" button implying unpublishing: it
cannot remove the file from anyone's clone. Retraction says exactly that.

## 5. The git trail

Before this, Harbr's history read `Update from Harbr` (`ai.rs`,
`github.rs`) or one agent-written subject derived **from the diff, after the
session is over** — reading the same diff a stranger would, guessing at intent,
because by then nothing remembers why.

Now the agent is asked while it still knows, and the answer *is* the commit:

```
Rebuild the pricing tiers as a CSS grid

The flex row could not hold three columns at 1024px without the third
wrapping under the first two, and the fix people kept reaching for was a
hardcoded width that broke again at every new tier.

- Replace the flex row with a 3-up grid that collapses to 1-up under 768px
- Remove the four hardcoded card widths this was working around

Co-Authored-By: Claude <noreply@anthropic.com>
Made-With: Claude Code in Harbr
```

- Attribution is a **trailer, never the subject** — machine-readable, out of
  `git log --oneline`. On by default, one setting to turn off.
- Trailers are appended by `git interpret-trailers`, not by string
  concatenation. Trailers must be in the last paragraph with a blank line before
  the block and none inside it; get that wrong and git stops recognising the
  whole block, silently.
- **Never commit words on someone's behalf without showing them.** A message the
  user typed wins outright and no agent is asked — paraphrasing someone's own
  commit message back at them is the opposite of helpful.

## 6. How comments travel

A comment has no work commit to ride, and one written on `feat/x` that only
becomes visible when `feat/x` merges is not a comment, it is a note to yourself.

So comments travel on **`refs/heads/shipstudio-team`**: a ref nobody checks out,
holding nothing but `.shipstudio-team/threads/`.

```
you on feat/x            teammate on main
      |                        |
      +--> refs/heads/shipstudio-team <--+
                (comments only, a few KB)
```

**Merging is a union, and that is not a simplification.** Records are immutable
and named by ULID, so two machines can never write different content to the same
path. Combining two versions of this ref is "take every file from both" — no
three-way merge, no conflict, no resolution UI, ever. That property is why the
storage format is what it is, and it is what keeps the transport short enough to
read in one sitting.

**Your working tree is never touched.** The commit is built with a scratch
`GIT_INDEX_FILE` and `commit-tree`, so `git status`, your staged changes, your
branch and `HEAD` are exactly as you left them. Syncing while you are mid-rebase
does nothing to you. There is a test that asserts precisely this, against a real
repository with staged and unstaged changes.

**No local branch is created.** Only `refs/remotes/origin/shipstudio-team`, so
the feature never appears in your branch list or your branch switcher — and
`derive.rs` skips that ref when walking history, or the feed fills up with the
machinery reporting on itself.

**Records stay out of your commits.** `.shipstudio-team/threads/` is written to
`.git/info/exclude` — a `.gitignore` that is never committed and never appears in
a diff. Writing the project's own `.gitignore` would put our line into the user's
next commit and their next code review, which is not ours to do. (It also means
the transport's own `git add` needs `--force`, because our exclude blocks it.)

### When it runs

Never on a tight timer, and never as a surprise. Every trigger routes through one
coalescing entry point with a ten-minute floor, so a branch switch during a
project open during a push is one exchange rather than three.

| Trigger | Floor |
|---|---|
| Opening a project | ignored — you are waiting to see what landed |
| After your own push | applied — you have just proved network and credentials |
| Cmd+K → "Sync comments" | ignored — you asked for it |
| Background tick | applied |

A push that fails keeps the comment on disk, counts it as unshared, and says what
happened in words the reader can act on. The count of unshared records is
computed from the repository rather than tracked in memory, so a record an agent
wrote behind the app's back is included the moment it exists.

### What this costs

Instant for you, minutes for everyone else. Your own comment appears immediately
because it is a local file; a teammate sees it after their next fetch. That is
the honest ceiling of git-as-the-database, and every string in the UI is written
to match it.

## 7. What is built, and what is next

**Built:**

- The record format and the fold (`records.rs`), with authorship enforced in the
  fold rather than trusted from the file
- Writers for `comment`, `reply`, `resolve`, `edit` and `retract` (`threads.rs`)
- The git-derived half: commits, bodies, branches, pull requests (`derive.rs`)
- `get_team_snapshot`, which never fails for a state of the repository —
  including a folder that was never `git init`ed, where comments work in full
- The transport above (`transport.rs`), tested against two real clones and a
  real remote
- The push flow: one agent call, gauntlet, commit message (`push.rs`)
- All three distribution routes in §3 — skill, MCP tools, and the committed
  instruction block
- The in-workspace panel, pins on elements, selection and the agent handoff.
  Team lives **inside a project only** — there was briefly a home-level screen
  reading across the eight most recently opened projects at once, and it was
  cut. Each project is a walk of every active branch (70 of them on this repo),
  so eight of them ran hundreds of git processes; and a comment cannot be acted
  on without opening its project anyway
- Migration of pre-existing localStorage notes into records, once per project,
  leaving the originals untouched

**Not built:**

- A PR-description path equivalent to the commit one. PR bodies are *read*, and
  the skill asks for a good one, but nothing generates it at submit time
- Reactions, mentions, and anything resembling notifications
- Any surface that previews the generated commit message before it is written.
  Today the user's own typed message wins, or the agent's does; there is no
  third state where you see the agent's and edit it
