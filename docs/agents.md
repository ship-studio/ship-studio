# Agents

Persistent, named agents you chat with, the way Grok Bot works on desktop, but
every agent is a Claude Code session on your own Mac. One of them, the **Chief
of Staff**, manages the rest: it creates agents, briefs them, delegates to them,
keeps track of what they're doing, and deletes them when you say so. You can
talk only to the Chief and let it run everything else.

Agents is a mode, not a page. The **Projects | Agents** toggle at the top of
the sidebar (⌘⇧A, or ⌘K → Switch to Agents) turns the whole window into the
chat app: agent list on the left, one conversation on the right. Switching
back returns to wherever you were on the Projects side (the dashboard,
Workflows, the Inbox, or the open project); switching in returns to the last
conversation. While Projects is showing, an amber badge on the
Agents segment says an agent needs your OK or has news, and its tooltip says
which. New agent is ⌘N, the row at the foot of the agent list, or ⌘K. In the
collapsed rail the toggle is two stacked icons; below the compact breakpoint
it is an icon pair at the top bar's leading edge.

## What an agent is

| Piece | Where | Notes |
| --- | --- | --- |
| Identity | `<projects root>/.shipstudio/agents/agents.json` | name, role, avatar (shape + colour key), pinned/hidden, unread, Claude session id |
| Home | `<projects root>/.shipstudio/agents/<id>/` | the agent's working directory |
| Instructions + memory | `<home>/CLAUDE.md` | Claude Code loads it every turn. Instructions on top, `## Memory` below, which the agent maintains itself. Editing instructions never touches memory. |
| Conversation | `<home>/messages.jsonl` | what *you* were shown: your messages, its replies, agent-to-agent lines, approval cards, errors. Append-only |
| Card answers | `<home>/approvals.jsonl` | one line per answered approval card, applied over the card on read (answering never rewrites the log) |
| In flight | `<home>/turn.json`, `<home>/inbox.json` | the turn running now, and what is queued behind it; both survive a quit |

The chat log is ours, not Claude Code's transcript. The UI never reconstructs a
conversation from tool output it doesn't own (see "Never Assume Data").

## How a turn runs (`src-tauri/src/agents/runner.rs`)

Each agent has an inbox. A message from you or from another agent is queued; if
the agent is idle a worker drains the inbox, so everything that arrived while it
was busy becomes **one** next turn. A turn is one process:

```
claude --print --output-format stream-json --verbose --include-partial-messages
       --session-id <uuid> | --resume <uuid>
       --permission-mode acceptEdits
       --permission-prompt-tool mcp__shipstudio_agents__approve
       --mcp-config '{"mcpServers":{"shipstudio_agents":{"type":"http","url":…}}}'
       --allowedTools mcp__shipstudio_agents
       --append-system-prompt <voice + role + team rules>
       --add-dir <projects root> --add-dir <each external project>
cwd = the agent's home, prompt on stdin, MCP_TOOL_TIMEOUT raised (see below)
```

There is no long-lived process per agent, so twenty idle agents cost nothing.
The user's own Claude Code MCP servers and settings still load, which is how an
agent reaches Gmail, Calendar, Slack or anything else you've connected.

From the stream:

- every **top-level text block** streams: its text deltas (`stream_event`)
  build a draft sent as `agents://draft {agentId, id, text-so-far}` at most
  every 40ms, and the complete block is recorded under the draft's id, so the
  finished message takes over the same bubble (`agents/stream.rs`, tested on a
  captured real stream). Sub-agent text, streamed or not, is internal and is
  dropped. Stop mid-reply keeps what streamed, as a message marked `stopped`;
- while words are arriving the typing dots are hidden; they and the activity
  line come back between text blocks, while tools run;
- every **tool call** only updates the line under the agent's name ("Editing
  PricingTable.tsx", "Messaging Finance"); it never becomes a message;
- `system/init` confirms the session id, which is stored for the next `--resume`;
- an `is_error` result, or any exit without a `result` event (a crash, or
  output that wasn't stream-json, even with exit code 0), becomes an error
  line; a crash keeps what had streamed, marked `stopped`. `agents/failure.rs` words the two states people actually hit in
  Agents' own terms and tags the line (`failure`): "Claude Code's usage limit
  is reached. It resets at 3:00 PM." (`usage_limit`, with `resetsAt` only when
  Claude Code printed an epoch, or a clock time in this Mac's zone; a time in
  another zone is quoted, never converted) and "Claude Code is signed out."
  (`signed_out`). Anything else is shown as it came. The agent's registry entry
  carries the tag while the error is the newest line (`Agent.failure`, cleared
  by anything said after it), so the sidebar shows "Didn't finish: …" with a
  red dot, or "Usage limit · resets 3:00 PM" quietly with an amber one, and
  What's in flight lists it under Needs you with its remedy.

A vanished session (`--resume` → "No conversation found") is replaced once with
a fresh one. **Stop** ends the turn and drops the queue; it leaves a quiet
"Stopped" note (your doing, not a failure). A turn is capped at 3 hours.

**Process trees.** Each turn's `claude` leads its own process group
(`agents::procs`). Stop, interrupt, the timeout and quitting walk its process
tree first (a backgrounded child that called `setsid` has left the group but
is still a descendant), then signal the group and every descendant: SIGTERM,
then SIGKILL after 1.5s. A dev server or watcher its Bash tool started dies
with it. Once `claude` closes its output, its exit and stderr are waited on
for at most 10s; once its result is in, for a few seconds, then whatever it
left running in the background is stopped too.

**Slots.** At most 3 turns run at once; an agent past that shows "Waiting for
a free slot (3 agents already working)", can be stopped while it waits, and
picks up whatever else arrived meanwhile when its slot frees.

**Quitting mid-turn.** A turn writes `<home>/turn.json` (pid, session, and
for a bound agent the project snapshot taken before it) while it runs. On
quit, `RunEvent::Exit` calls `runner::shutdown_sync`, which stops every
turn's process tree and leaves the marks in place. A crash or force quit runs
no cleanup at all, so at launch `runner::recover_after_restart` also stops a
leftover process (if its command line still names the session), removes the
mark, records the turn's change card if it changed the project, and ends on
an error line (tagged `failure: other`) saying the turn didn't finish. The
messages queued behind it (`inbox.json`) are then sent once, after a note
naming them; the interrupted turn itself is not re-run. An update's restart
waits for working agents ("After agents finish"; click again to restart now).

**Damaged files and newer builds.** `agents.json` is written atomically and
again as `agents.json.bak`. It is read and written losslessly: fields this
build doesn't know (on an agent, a check-in, a rule), unknown top-level keys,
and whole entries it can't read (a newer build's) are kept and written back
untouched, so running an older build never deletes what a newer one saved.
Only a file that isn't JSON counts as damage: the backup is loaded and written
back, and the damaged file is kept as `agents.json.corrupt-<ms>`; with no
readable backup it is an error, never an empty list that would be saved over
it. A chat line of a kind this build doesn't know is skipped on read and stays
on disk, since the log is append-only. A torn last line in
`messages.jsonl` is skipped on read, and the next append starts a new line
instead of fusing into it. Opening a chat and paging back through it
(`agents_messages` with `before`/`through`) read the log from its end, only as
far back as the page needs, and apply `approvals.jsonl` to the page read. A log that can't be written: the user's own send
fails with the reason; a reply mid-turn is still shown, with one error line
(at most a minute) saying it won't survive a restart.

## Tools agents get (`src-tauri/src/agents/mcp.rs`)

Served by the existing loopback agent bridge at
`/mcp/<bridge token>/agents/<agent id>`. The id in the path is the caller, and
the URL is passed only inline to the process Ship Studio spawned for that agent.

| Tool | Who | What |
| --- | --- | --- |
| `list_agents` | all | names, roles, busy / waiting |
| `message_agent` | all | async: records "Messaged X" here and "Message from Y" there, queues a turn for X |
| `project_*`, `session_*`, `preview_screenshot`, `git_status`, `push`, `deploy_status` | all | working on projects, below |
| `share_file` | all | hands the user a file it made: copied into its `attachments/`, posted as its own message with a file card |
| `create_agent` | Chief | name, role, instructions, optional `project` and `first_task` |
| `update_agent` | Chief | name / role / instructions / project (memory kept) |
| `delete_agent` | Chief | puts an Allow / Deny card in the Chief's chat first |
| `approve` | CLI only | the permission prompt tool (below) |

**Loops.** Agents messaging agents can ping-pong. A user message starts a chain
at hop 0; each `message_agent` from a turn at hop *n* delivers at *n+1*, and
`message_agent` refuses past hop 6. The prompts also tell agents not to send
acknowledgements to each other.

## Working on projects (`src-tauri/src/agents/sessions.rs`)

Agents work on Ship Studio projects the way Remote Access does: in the
project's real agent tabs (backend PTY sessions), so the user can open the
project and carry on the same conversation. It is Remote Access's toolset,
run by the same handlers in `remote_access/tools.rs`, under names that can't
be confused with agent-to-agent `message_agent`:

| Agents | Remote handler |
| --- | --- |
| `project_list` / `project_create` / `project_open` | `list_projects` / `create_project` / `open_project` |
| `session_message` (the default) / `session_start` | `message_agent` / `start_agent` |
| `session_wait` / `session_read` / `session_key` / `session_close` / `session_progress` | `wait_for_agent` / `read_agent` / `press_key` / `close_agent` / `show_progress` |
| `preview_screenshot`, `git_status`, `deploy_status` | same |
| `push` | own: a card instead of the PIN |

- **Scope:** every Ship Studio project (agents already run as the user with
  every project as an `--add-dir`), not the remote's opt-in list.
  `project_create` doesn't share the project for remote access and doesn't
  switch the window.
- **Answers:** the shared STATUS / reply / NEXT shape, with remote tool names
  rewritten to the agent's (`sessions::rename`, whole identifiers only).
- **Chat:** each call runs inside `AGENTS_CALL` (a task-local in
  `tools.rs`), which collects what it started, the replies it saw and its
  screenshots. They become `session` lines: "Started a session in
  acme-marketing", "Sent to acme-marketing · Claude Code 1", the reply (once
  per distinct reply), and screenshots inline. "Open session" opens the
  project with that tab selected (`openAgentSession` →
  `useRemoteAgentControl`). Screenshots are written to the agent's
  attachments and never stored behind the remote's public image links.
- **Window: it never moves because of an agent.**
  - *Sessions* start in the background. `start_agent` emits
    `remote-start-agent`; `lib/backgroundSessions.ts` spawns the PTY with the
    same builder a mounted tab uses (`lib/agentSpawn.ts`: PATH, `--session-id`,
    auto-accept, `--add-dir` libraries, the prompt as argv), then the
    project's tabs adopt it: its in-memory list if this window has opened the
    project (the active tab is left alone), otherwise its saved list in
    `.shipstudio/project.json`, which opening the project restores from. The
    Terminal that mounts then finds the PTY alive (open is idempotent) and
    replays its scrollback, so the conversation is all there. Messages,
    reads, waits and key presses were always backend-only (`pty_session`).
  - *Screenshots* are taken off-screen: headless Chromium (the preview's own
    Playwright capture) against the project's running dev server, found
    through its preview proxy (`proxy::dev_server_port_for`) — so not even
    the page or width of a preview the user is looking at changes. With no
    dev server running, the answer says the preview isn't running and the user
    can open the project; starting one would mean opening the project.
  - *Closing* a session is the tab's × done in the background, the same way.
  - `project_open` is the one tool that switches the window, because the user
    asked to see the project. "Open session" on a session line does too: the
    user clicked it.
- **Safety:** unchanged shared rules. Text only to agent tabs, never shells;
  a leading `!`, a `/` command outside the allowlist and control characters
  are refused; an opening prompt can't start with `-`.
- **Push:** no PIN. `push` puts a card in the agent's chat ("Push
  acme-marketing") with the branch, origin (credentials stripped), the
  commits and what gets committed first. It has no tool call behind it, so
  no "Always allow" is offered and no rule can skip it. Allow pushes exactly
  the tree the card described (`frozen_tree` / `push_frozen`); a change in
  between pushes nothing. An unanswered card expires after 240s.
- **Audit:** the remote's `remote_audit.jsonl`, same rules (reads skipped,
  previews only), with `actor` set to the agent's name. The Remote access
  modal's activity list leaves those out.
- **Bound agents** are still an option; sessions are the default.

## What an agent can do (`src-tauri/src/agents/capabilities.rs`)

Turns run with `--chrome`. Each turn's `system/init` lists the session's
tools and MCP servers with their status; the runner keeps the last one on
the agent and builds one line per kind of capability (projects, the team,
Chrome, computer use, on this Mac, connectors, needs sign-in). The lines go
into the next turn's prompt ("What you can do here") and into the editor
("What <agent> can do"). Nothing is listed before the first turn.

Verified on Claude Code 2.1.318 in `--print`: Claude in Chrome loads with
`--chrome` and a tool call answered (extension connected); the user's MCP
servers load with their status; there is no computer-use server in a
headless turn, so it isn't claimed. Not verified: Chrome with the extension
disconnected (the line then says "Not connected" if Claude Code reports it
so), and a Chrome call going through an approval card in the running app.
`cargo test --lib agents::capabilities -- --ignored` repeats the headless
check.

## Approvals

`acceptEdits` lets an agent edit files inside its home and every project
without asking. Anything else Claude Code would prompt for (a shell command
that isn't read-only, a web fetch, an MCP tool like sending email, a file
outside those folders) goes to `approve`, which puts a card in that agent's
chat showing the exact command, file, URL or tool input, and waits for
**Allow** or **Deny**. While it waits, the agent's row says "Needs your OK".

Verified against Claude Code 2.1.318: the tool receives
`{tool_name, input, tool_use_id}` and must answer
`{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`.

Two timeouts shape the design, both observed:

- **~60s**: Claude Code's default MCP call timeout. A timed-out approval came
  back to the agent as "Bash is hanging". Turns set `MCP_TOOL_TIMEOUT` well
  past our wait.
- **300s**: Claude Code abandons a *permission prompt* at five minutes
  regardless of `MCP_TOOL_TIMEOUT` (two unanswered cards were both given up at
  exactly 300s, while their buttons still looked live).

So approvals are asynchronous. `approve` waits 240s. If you haven't answered,
it tells the agent "the user may be away: stop, say what you need, you'll be
woken if they allow it", and **the card stays live**. A late **Allow** grants
that exact tool call once (same tool, same input) and queues a turn telling the
agent to carry on; its retry goes through without a second card. A late
**Deny** just records the answer. **Deny with note…** declines and hands the
agent what you typed: as the deny message while it waits on the card, or as a
queued turn when it doesn't; the card keeps it ("Declined · “…”").
Live cards survive restarts, because the
tool and input are stored on the card. Ship Studio's own confirmations (delete
an agent) do expire, since they only mean something while asked. The sidebar
shows "Needs your OK" while any card is open (`pendingApprovals`).

**Always allow** (`agents/permissions.rs`). A permission card can offer a
quiet "Always allow …" beside Deny / Allow, scoped when the card is made and
stored on it, so the UI can only accept that scope, never widen it: a Bash
command's leading words (`npm test`, `git push`, `npm run build`), or the exact
command for wrappers and risky programs (`sudo`, `rm`, `bash`, `curl`…) and for
anything whose second word is a flag; one exact host for WebFetch; one
connector tool; web search. Never Bash, Write or Edit as a whole, and never on
Ship Studio's own confirmations (delete an agent has no tool call, so no
scope). A command only matches if it is one plain command: `;`, `&`, `|`,
redirects, `$`, backticks, parentheses, backslashes and line breaks all ask
again, so `npm test && rm -rf ~` never matches `npm test`. Rules are stored per
agent (`Agent.permissions`); each auto-allowed call leaves a muted `note` line
("Allowed automatically: npm test · Always allowed"); the agent editor lists
them under Permissions with Revoke. A card answered this way reads "Always
allowed · npm test" (`Approval.alwaysAllowed`, with `always` set to the rule).
Adding a rule also answers every other open card from the same agent that it
covers (`mcp::covered_by`), through the same path as Allow: a live waiter is
woken, and a card nobody waits on any more gets a late Allow that wakes the
agent.

## Steering a working agent

Sending mid-turn queues the message for the next turn (default). The newest
queued bubble says "Queued, sends when <agent> finishes" with **Interrupt and
send now**, and the working indicator sits above the run of queued messages
at the end (what it's doing now, then what's waiting); ⌘↵ in the composer sends and interrupts at once. A message is
queued when it was sent after the turn in progress began (`isQueued`: its `ts`
is after `status.since`). `agents_interrupt` cancels the turn without dropping
the queue (Stop drops it); the cut-off reply is kept as `stopped`, a note
"Interrupted to read your new message" is recorded, and the next turn's prompt
opens with `prompts::interrupted`: what it was working on, its last step, and
that the work already done stands. A card the interrupted turn was waiting on
stays live, with the usual late-Allow behaviour.

Esc in an empty composer stops a working agent only when pressed twice within
1.5s: the first shows "Esc again to stop <agent>" where the hint goes, so a
reflexive Esc never drops a turn. ⌘K also lists "Stop <agent>" for every agent
that isn't idle (with a confirm), Allow / Deny for the oldest card waiting on
you, and "Open the next agent that needs you" (⌘J: a card, or a turn that
didn't finish).

## Notifications (`src-tauri/src/agents/notify.rs`)

The backend decides, since it knows when a message is recorded and when a turn ends.

- **On screen** = a *focused* window is showing that agent (`agents_focus` reports which agent each window shows; focus is asked of the window at that moment). Messages on screen neither notify nor count as unread.
- A reply or error off screen notifies with the agent's name and the first line. Inside a turn they are held and posted once when it ends, with the latest text. An approval posts at once, with a sound.
- Bursts across agents are capped (3 per 20s); the rest stay silent but still count.
- **Mute** (row context menu) stops OS notifications for that agent; a bell-off mark shows in its row. Unread and the badge still count it.
- **Dock badge** = unread + pending approvals across non-hidden agents. The mode toggle's badge is on whenever any non-hidden agent is waiting or unread. Approval cards don't add to unread; they count as pending until answered.
- Clicking a notification focuses a window and emits `agents://open`; the app switches to Agents and opens that agent. Focusing a window clears the unread of the agent it shows.
- Uses `tauri-plugin-notification` (2.8, click reporting on macOS). Not verified in a real build yet: the dev binary posts under another app's identity, so click-through should be checked in a signed build.

## Import from Grok Bot (or any connected assistant)

Only the other assistant knows its own agents, instructions and memory, so the
import runs from its side. Remote access gains an `import_agents` tool:
`{source, agents: [{name, role, instructions, memory, is_main, routines}]}`. Ship Studio
creates each agent, writes its instructions, and appends its memory under
`### Imported from <source>`. The `is_main` agent merges into the Chief of
Staff. Re-importing updates same-named agents instead of duplicating them.
Imported agents don't run until you message them, apart from their routines.
Every import is audited like any other remote-access action.

Each agent can also bring `routines: [{when, what}]`, with `when` in plain
words ("every weekday at 9am", "every 2 hours", "friday at 2pm"). Each goes
through the same parser and limits as `schedule_check_in` (`schedule::check`)
and becomes a routine, or a one-time check-in, with `what` as its note. A
phrase that can't be read, or is too frequent, or a full agent, isn't
guessed at: the paste preview shows it under its agent with the reason, and the
result (`routinesRefused`, and the tool's reply, which tells the assistant to
list each one to the user) names it by agent. A refused routine doesn't block
the rest of the import. Re-importing doesn't duplicate routines: the same note
on the same schedule, or the same one-off note, counts as already set.

The **Import agents** button in Agents mode offers two paths, as tabs:

- **Paste** (the default while remote access is off; needs nothing set up).
  Copy a message into the other assistant (`PASTE_PROMPT` in
  `src-tauri/src/agents/paste.rs`) asking for every agent as a ```json block
  in the same `{source, agents}` shape, in full and with no credentials, split
  into numbered whole-agent blocks if it's long. Paste the whole reply back:
  every ```json block (or bare JSON) is found and merged, and the preview lists
  each agent and whether it is new, updates an existing one, or merges into the
  Chief. Anything wrong (a trailing comma and its line, a cut-off block, a
  missing name, a non-text field, a duplicate, two mains) is listed by block,
  agent and field and blocks the import; nothing is repaired except curly
  quotes used as JSON quotes. Import runs the same `import::import()`.
- **Connected assistant** (the default once remote access is on): the one
  message that makes it call `import_agents`, and a link to Remote access setup.

What doesn't come across: the other platform's own connectors (its Gmail,
Calendar…). Here, agents use what this Mac and Claude Code are connected to.

## Check-ins and routines (`src-tauri/src/agents/schedule.rs`)

An agent that says "I'll check back tomorrow" can: `schedule_check_in {when,
note}` (with `list_check_ins` and `cancel_check_in`) takes a plain-language
time in the user's zone, once ("tomorrow 9am") or repeating ("every weekday
9am", "every 2 hours"). A phrase it can't read is refused, never guessed. The
Chief of Staff can schedule for another agent. They are stored on the agent's
registry entry.

The user sees them in a popover on the chat header ("N scheduled", or a clock
when there are none; Cmd+K → "Schedule a check-in for <agent>…"). Each row
can be paused (routines) or cancelled. The composer takes one line, `when:
what`, split at the first colon followed by a space, and reads the time back
as the backend resolved it before Return adds it.

**Run now** (`agents_schedule_run_now`) fires a row immediately as an ordinary
wake: the same `check_in` line (marked `manual`, shown "· run now") and the
same prompt, which tells the agent it was asked for ahead of time. Its
`nextAt` doesn't move, and a one-time check-in stays scheduled: it's a
rehearsal, not a skip. **Edit** (`agents_schedule_update`) puts the row's own
words back in the composer (`scheduleWhenPhrase`, which the grammar reads back
as the same schedule; a Rust test holds `describe` to that) and Return saves
it in place: same id, paused stays paused, `when` re-read from now. It can't be
edited into a copy of another row. Esc leaves the edit, not the popover.

A one-minute tick fires them, with the workflow scheduler's rules: nothing
fires while the app is closed, at most one firing per tick, and a routine never
catches up a backlog. A one-time check-in missed while closed fires once, marked
late; an agent that missed several is woken once with all of their notes. A
firing records a `check_in` line in the chat, then wakes the agent with the
note.

That line goes through `runner::record` as a `MessageKind::wants_user()` kind,
the same predicate as replies, and is recorded after the wake starts, so it
falls inside the turn. Notifications use the same predicate, so a check-in
and its answer post one notification per turn.

## Apps agents can use (`src-tauri/src/agents/apps.rs`)

Every turn is a `claude` process, and Claude Code loads the user's MCP servers
into it, so the apps an agent can use are exactly Claude Code's. "Apps your
agents can use" (the agent editor's Apps row, or ⌘K → "Connect an app for
agents…") is a window onto that, with no state of its own:

- **Connected**: `claude mcp list`, which health-checks each server, so the
  status is Claude Code's. Which rows are user scope is read (never written)
  from Claude Code's `.claude.json` top-level `mcpServers`; only those get
  Remove. claude.ai connectors (names starting `claude.ai `) say "Managed on
  claude.ai"; project/local/plugin servers say they're set up elsewhere.
- **Add an app**: a fixed list in Rust (`SUGGESTED`): Linear, Notion, Figma,
  Sentry, Stripe, Vercel, each the vendor's own remote MCP endpoint with OAuth.
  The webview sends only a name, never a URL. Added with
  `claude mcp add --scope user --transport http <name> <url>`. Left out:
  GitHub (its remote server wants a token header, not OAuth) and Gmail,
  Calendar and Slack, which have no vendor remote endpoint; they come from
  claude.ai's connectors, which Claude Code loads for a claude.ai account.
- **Sign in…** on a "Needs sign-in" row opens `claude` in a terminal sheet,
  where `/mcp` runs Claude Code's own OAuth. Whether a headless `--print`
  turn can start that sign-in itself is not verified, so the copy doesn't
  promise it.

Every call goes through `run_with_timeout` (60s for list, 30s for changes)
with `runner::strip_session_env`, from the agents folder, so what's listed is
what a turn sees. The project MCP modal edits the same Claude Code settings for
the active agent CLI, plus project scope; it's left as it is.

## When the Mac sleeps, a window closes, or Ship Studio quits

Agents are not a service. Each turn is one `claude --print --resume <session>`
process that Ship Studio starts on this Mac and reads to the end, and the
check-in tick is a loop inside the app. So:

- **A window closes.** By default closing a window quits Ship Studio (the
  frontend's close handler calls `exit`), so it is the same as quitting. With
  **Keep running when closed** on (opt-in, macOS), the window is hidden
  instead (`close_to_background`) and nothing stops: agents, check-ins,
  terminals and dev servers in that window carry on. Hiding rather than
  destroying matters, because a destroyed main window runs the global cleanup
  that kills agent processes. Clicking the Dock icon brings hidden windows
  back (`RunEvent::Reopen`); so do a notification and opening that project.
- **Ship Studio quits** (⌘Q, or a close with the option off). The turn in progress ends with it: its Claude Code
  process is stopped on the way out (`cleanup_agent_processes`), and any that
  outlived a crash are cleaned up at the next launch. What the agent already
  did (files written, commands run) stands. Messages queued behind that turn
  live in memory (`runner::Runtime`), so they are not sent; say it again.
  Nothing fires while the app is closed.
- **It reopens.** Every conversation is on disk and the next message resumes
  the same Claude Code session, so the agent still has its context. There is
  no automatic restart of an interrupted turn on this branch: you pick it up
  by sending the next message. Ship Studio's own confirmation cards left
  pending are marked expired (`store::expire_stale_approvals`); permission
  cards stay answerable, and a late Allow wakes the agent again. Missed
  check-ins follow the rules above: a one-time one fires once, late; a routine
  doesn't backfill.
- **The Mac sleeps.** Everything, the agent's process included, is frozen
  with it, and carries on when it wakes. If its connection dropped meanwhile
  the turn can end in an error, shown with Retry like any other. A check-in due during sleep is
  late, under the same rules.

Three things help, offered together (`get_stay_on` / `set_stay_on`), each read
back from the thing itself:

- **Keep this Mac awake** holds the same idle-sleep assertion remote access
  uses (`remote_access::power::start_keep_awake`, `caffeinate -i -s -m -w
  <pid>`), as a standing preference of its own (`AppState.keep_awake`, held
  again at launch). It dies with the app, `-s` only holds on mains power, and
  it can't stop a laptop sleeping when the lid closes (see remote access's
  lid-closed mode). Turning remote access off leaves it held if the user asked
  for it here.
- **Keep running when closed** (`AppState.keep_running_when_closed`) is
  opt-in because it changes what closing a window does for every project, not
  only Agents. Nobody who hasn't turned it on here sees any difference.
- **Open at login** is remote access's own login item
  (`remote_access::power::set_open_at_login`, the
  `studio.ship.reopen-at-login` LaunchAgent): one file, so turning it on or off
  here shows in remote access's checklist too. Hidden in a dev build, which has
  no installed app to reopen.

They are offered in two quiet places only: under the Chief of Staff's
first-run starters, with a line that says what happens ("Closing Ship Studio
stops them, and sleep pauses them.", or with Keep running on, "Closing the
window keeps them going; quitting stops them, and sleep pauses them.") and one
line suggesting an always-on Mac, such as a Mac mini or a cloud Mac, for
round-the-clock agents; and as a "Keep this Mac awake" link at the end of the
schedule popover's footnote. Elsewhere than macOS none of it shows.

## Engines: Claude Code or Codex (`agents/engine.rs`, `agents/codex.rs`)

Each agent has `engine: "claude" | "codex"` (default `claude`), so it can run
on a ChatGPT plan with the same chat, tools, memory and Chief around it. The
editor's **Runs on** shows only engines that are installed and signed in
(Codex: `codex login status`; Claude Code counts once installed), plus the
one the agent is on, and hides itself when there is one choice. Model offers
that engine's own list: Claude Code's aliases, or Codex's own
`models_cache.json` (`visibility: list`, its order). The Chief can set it on
`create_agent` / `update_agent`; both refuse an engine that isn't ready.
Switching clears the session and the model, leaves a note ("Runs on Codex
from its next message"), and the next turn gets the recent conversation
(`Agent.newEngine` → `with_recap`).

A Codex turn:

```
codex exec [resume <thread id>] --json --skip-git-repo-check
  -c sandbox_mode="workspace-write" -c approval_policy="never"
  -c sandbox_workspace_write.writable_roots=[<home or project dirs>]
  -c mcp_servers.shipstudio_agents={url=…,tool_timeout_sec=300,default_tools_approval_mode="approve"}
  -c project_doc_fallback_filenames=["CLAUDE.md"]
  -c developer_instructions=<voice + role + team rules>
  [-m <model>] -          (prompt on stdin; cwd as for Claude Code)
```

Its JSONL maps onto the same `stream::Step`s as Claude Code's stream-json:
`thread.started` → session, `item.completed agent_message` → a reply,
`item.started` command / MCP call / web search and `file_change` → the
activity line (labelled as the matching Claude Code tool), `turn.completed`
→ usage (tokens only: a plan reports no price; duration timed here),
`turn.failed` → the error, and `error` retries → "Reconnecting to Codex 2/5".
Capabilities come from what we serve it, its built-ins and `codex mcp list
--json`, read before each turn (Codex announces no tools). Failures read as
"Codex's usage limit is reached. It resets at 7:18 PM." (from its "try again
at 7:18 PM", this Mac's time) and "Codex is signed out." (checked before the
turn, which otherwise spends 20s retrying a 401), with "Sign in to Codex"
running `codex login`. A vanished thread ("no rollout found") is replaced
once, like a lost Claude session.

What differs from a Claude Code agent, all verified on Codex 0.166:

- **No streaming.** `exec --json` emits an `agent_message` only complete,
  even when the model streams it, so a Codex reply appears whole. Stop keeps
  nothing partial; it leaves the "Stopped" note.
- **No approval cards for its own commands.** `exec` forces approval to
  "never" whatever is configured, so nothing reaches a client or a
  `PermissionRequest` hook, and hooks passed with `-c` don't run without
  `--dangerously-bypass-hook-trust`, which we don't use (it would also run
  any untrusted hook in a project). So the guard is Codex's sandbox: commands
  can write only in the agent's home and the user's projects, with no
  network, and anything beyond fails inside the turn; the prompt tells it to
  say what it needs instead. Ship Studio's own cards (push, delete an agent)
  still appear, since those are our tools. The user's own Codex MCP servers
  keep their defaults, so their write tools are refused rather than asked.
  `codex app-server` routes approvals and streams deltas; moving to it is the
  way to close both gaps.
- **Memory.** `developer_instructions` is fixed at session start (a resume
  keeps the first), but Codex re-reads the project doc every turn and hands
  over a changed one, so an unbound agent's CLAUDE.md is its project doc and
  memory edits reach the next turn. A bound Codex agent runs in its project,
  whose own AGENTS.md (or CLAUDE.md) loads; its identity rides in the
  developer instructions as of its session's start.
- No Claude in Chrome; "Apps" are the MCP servers set up in Codex.

Not verified against a signed-in ChatGPT account (none on the build machine):
real model behaviour on these prompts, the real usage-limit response (its
wording was produced by Codex itself from a scripted 429), and a real reset
time. The e2e Codex scenarios run on the account when one is signed in.

## Search, model and usage

- **Search.** In Agents mode the sidebar's top field searches conversations
  (⌘F focuses it; ⌘K stays the palette, and the palette's "Search agent
  conversations" does the same). With no sidebar to hold it (compact width, or
  the rail collapsed) it opens over the chat instead. It scans every agent's
  `messages.jsonl` directly, with no index: every word must appear, case is
  ignored, newest first, at most 50 hits (`src-tauri/src/agents/search.rs`).
  Results replace the list, grouped by agent. Enter opens the first hit;
  opening one loads older history if needed, expands a collapsed agent-to-agent
  thread that holds it, centres the line, and puts focus in the composer; the
  opened hit stays marked. Snippets are re-cut on the frontend to start a few
  words before the match, so it survives the sidebar's two-line clamp. Esc
  anywhere in Agents mode clears it.
- **Messages.** Agent replies are prose on the canvas; your messages are
  bubbles. Hover or focus shows Copy and the time (the exact time is its
  tooltip); Copy isn't a Tab stop, but a clicked message takes focus and ⌘C
  copies it. The newest error, with nothing said since, offers Retry (sends
  your last message again whole: words, quotes and files, re-copied from the
  agent's home) and, for an expired login, "Sign in to Claude Code" (the same
  `claude auth login` terminal the dashboard uses). A usage limit with a known
  reset also offers "Retry at 3:00 PM": a one-time check-in at the reset whose
  note carries what you asked; once it exists the line says "Retries at …".
  "Set up Claude Code" (no Claude Code yet) runs the install terminal, then
  sign-in, and the composer unlocks when the overview says it's there.
- **Model.** Default / Opus / Sonnet / Haiku, passed as `--model` from the next
  turn. Set it when creating the agent, in the editor, or from the menu in the
  chat header. Only Claude Code's own aliases are accepted, and the backend
  enforces that too. Default means no `--model`, so whatever Claude Code
  defaults to.
- **Usage.** Each turn's final stream-json `result` event adds its token counts,
  `total_cost_usd` and `duration_ms` to the agent, all time and per day for the
  last 7 days (`src-tauri/src/agents/usage.rs`). Nothing is estimated: a turn
  that reports no cost adds tokens only, and a period containing one shows no
  dollar figure at all. The editor shows "This week" and "All time".

## Access

An agent can do what your user account can do: it runs as you, with your files,
logins, CLIs and Claude Code MCP servers. Approvals are the guard, not a
sandbox. That matches the request this was built for ("anything your computer
has access to, so does it"), and it's why the prompts forbid pushing,
deploying, sending or spending unless asked, and why those actions surface as
cards.

## Attachments and quoting (`src-tauri/src/agents/attachments.rs`)

- Paste an image (⌘V), drop files anywhere on the chat, or use the paperclip.
  Staged files sit above the text as removable chips; images show a thumbnail.
- On send each file is copied into `<home>/attachments/<message id>/`, so the
  agent reads its own copy and the chat keeps showing it after the original
  moves. Picked and dropped files are copied by path; a paste is sent as bytes.
- The log keeps what the user typed plus `attachments: [{name, path, mime,
  size}]`; the prompt the agent gets also lists the absolute paths and asks it
  to use the Read tool, which reads images and PDFs natively.
- Limits: 10 files a message, 25 MB a file, refused before sending with a
  message that says which file and why. Folders are refused.
- On the user bubble images render as thumbnails (click: full size, with Open);
  other files as chips that open in their default app
  (`agents_open_attachment`, which only opens paths under `attachments/`).
- Drops come from Tauri's window-global `tauri://drag-*` events, hit-tested
  against the chat (lib/dropTarget). The DOM drag handlers cover the browser
  harness and are inert in the app.
- Select text in an agent's reply and press ⌘L (or the Quote button that
  appears above it) to quote it. Each quote waits above the text as a chip
  (removable; more ⌘L presses add more) and is sent as a Markdown blockquote
  ahead of what you typed. User bubbles show those blockquotes as quote bars
  (`splitQuotes`); nothing else in a user's text is read as Markdown.

## @mentions and What's in flight

- **@mentions.** Typing `@` in the composer opens a small menu of your other
  agents (the app's menu surface; the field keeps focus: ↑ ↓, Return or Tab,
  Esc). Picking one writes `@Name`. `agents_send` takes the mentioned ids,
  keeps only real agents other than the recipient, records them on the
  message as `mentions: [{id, name}]`, and adds one line to the prompt
  (`prompts::mentions`): for the Chief, "delegate this to them with
  message_agent"; for anyone else, "involve them". No new routing: the
  recipient does it with `message_agent`. The bubble tints each recorded
  `@Name` in that agent's colour. A name typed without the menu still counts
  if it matches an agent exactly.
- **What's in flight** (⌘K only, id `agents.team`; it used to be the list's
  first row and the compact switcher's, and was demoted so the list is just
  agents, with ⌘J and the toggle's badge carrying "who needs you") shows,
  in a fixed order and present even when empty: who needs you (with their
  pending approval cards, answerable in place, and turns that didn't finish,
  with Retry, Retry at the reset, or Sign in), who is working (their
  activity line), the next five active check-ins, and the six latest
  replies. Every row opens that chat; a reply opens it at that line. It
  reads only the store: statuses and check-ins from the registry, cards and
  replies from each chat's recent lines (live for chats open this session,
  otherwise the last 20 lines, re-read when that agent's row changes; a
  chat with an open card reads a page). Hidden agents are left out. While
  it is open no chat is on screen, so replies keep counting as unread. It is
  never restored on reopen: Agents comes back to the last conversation.
  An answered card shows what it resolved to ("Allowed · Lead Gen is
  carrying on") for 1.2s, then folds away, and focus moves to the next
  card's Allow (or the next row). Long field values clamp to two lines with
  "Show all"; cards span the row's text column. The Chief of Staff is created
  pinned (an ordinary pin: unpin it and it sorts by recency).
- **Sections** (user-made groups in the list) are not built: they need a
  persisted field, a naming flow, collapse state, and a story for how they
  sit with the recency sort. Worth doing as its own slice once the list is
  long enough to want them.
## Files back from agents (`src-tauri/src/agents/files.rs`)

- `share_file {path, caption?}` takes `~/…`, an absolute path, or one relative
  to the agent's home. The path is canonicalised and must land inside the
  agent's home or a registered project, so `..` and symlinks are judged by
  where they really lead; folders are refused (zip first). The file is
  **copied** into `<home>/attachments/<message id>/` under the attachments
  limits, so the card survives the agent editing or deleting the original.
- It's recorded as an `agent` message with `attachments` and the caption as
  its text, so unread, notifications ("Shared report.pdf" with no caption) and
  history all treat it like a reply. Images show inline; files are the same
  chips as yours, on the left. Click opens; Show in Finder sits on hover and in
  the image view. The prompt tells agents to share rather than paste.
- **Files** (header … menu, or ⌘K "Files shared with <agent>") lists every
  attachment in the conversation, both ways, newest first
  (`agents_files`, a scan of the whole log), filterable All / From you /
  From <agent>, each with Open and Show in Finder.
- **Paths in replies** become links: Markdown links without a scheme, `~/…`
  and absolute paths under `/Users`, `/Volumes`, `/tmp` and similar written
  out in prose, and inline code that is only such a path (`/careers` isn't).
  `agents_open_path` resolves relative paths against the agent's home and
  requires the target to exist. Documents open in their default app; folders,
  apps, scripts, anything executable or with a launching extension
  (`.command`, `.app`, `.py`, `.webloc`…) are only revealed in Finder, never
  run. ⌘-click always reveals.

## Agents that work in a project (`src-tauri/src/agents/project.rs`)

An agent can be bound to one Ship Studio project (`Agent.project`, a path from
`list_projects`), from the editor's **Works in** or by the Chief
(`create_agent` / `update_agent` take `project`, a name or path; `"none"`
unbinds). Unbound agents run exactly as before; nothing is migrated.

- **The turn runs in the project** (cwd), so its CLAUDE.md, `.claude/` settings
  and `.mcp.json` load. `--add-dir` gets the agent's home first, then the usual
  folders.
- **The identity comes in the appended system prompt**, with the home's path
  so the agent can keep editing its memory. Verified on Claude Code 2.1.318: a
  CLAUDE.md in an `--add-dir` folder is not loaded; with
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` it is, but so is every other
  added folder's (every external project's rules would leak in). `--resume`
  works across a cwd change, so binding keeps the conversation.
- A bound folder that's gone fails the turn with an error naming it.
- The header shows a quiet folder chip that opens the project.

**Change cards.** Before a bound agent's turn the runner snapshots the
project's working tree as a git tree object (through a throwaway copy of the
index, so the user's staging is never touched); after the turn, however it
ended, it snapshots again and diffs the two (`--numstat`, `--name-status`). If
anything changed, a `changes` message records the files with +/- counts, the
branch and both snapshot ids. Edits already present before the turn don't
count; a commit mid-turn doesn't hide work. **View diff** opens the app's own
diff modal on this turn's change only (`agents_change_diff`, which reads the
project and snapshots from the stored card); **Open preview** opens the
project. No deploy status: nothing here knows whether that commit deployed.
Limits: another agent or the user editing the same project during the turn is
counted too; the snapshots are unreferenced git objects, so after `git gc`
prunes them the diff says it can't be shown.

## The Chief's audit trail and live hand-offs

- `create_agent`, `update_agent` and `delete_agent` leave a quiet note in the
  Chief's chat ("Created Finance · Invoices and the books", "Updated Acme
  Site's instructions", "Deleted Social Posts"), and creates and updates one in
  the target's ("Created by Chief of Staff", "Instructions updated by Chief of
  Staff"). The note's `peer` makes the name a link.
- The newest line where an agent handed work to each peer shows that peer's
  live state: working (with its activity), needs your OK, didn't finish (its
  newest outcome line is an error, read from its chat or the last few lines of
  its log), or idle.
- In the receiving chat, the brief that started the turn in progress is open
  until the turn ends (or you toggle it).

## Known limits / next

- Claude Code and Codex (see "Engines"). Opencode would slot in the same
  way: a command line and a mapping onto `stream::Step`.
- Search scans files on every query. Fine at one person's scale (tens of
  agents, thousands of lines); an index would be needed well past that.
- At most 3 turns run at once (`runner::MAX_TURNS`); the rest wait, shown as
  "Waiting for a free slot". An agent waiting on an approval card holds its
  slot until it is answered or the wait runs out.
- Nothing a turn starts outlives it. `claude --print` waits for any
  background task its Bash tool started (observed with 2.1), so a dev server
  left running would keep the agent "working" for hours; instead, a few
  seconds after the turn's result the tree is stopped. An agent can't leave a
  server running for you to look at.
- Check-ins and routines only fire while Ship Studio is open.
- Notification click-through is unverified in a signed build.
- After a restart, the interrupted turn is not re-run (it may have done half
  its work); messages queued behind it are, once. Retry then belongs to
  whatever failed last.
- Debug builds: `research/design-canvas` (not on main) disables the agent
  bridge under `debug_assertions`. Agents depends on it, so that branch needs
  an exception for the `/agents/` route before both land.
- Mobile: the import tool and remote access already put Agents within reach of
  a phone assistant. A native client would talk to the same commands.

## Testing

- `cargo test --lib agents::`: store (including frozen compatibility
  fixtures in `agents/testdata/compat/`: every registry shape and message
  kind users have on disk must load, and a write must keep what a newer build
  added), process trees, share-path validation (traversal, symlinks), prompts framing, activity labels, MCP
  tool visibility, approval descriptions, import merge rules.
- `pnpm vitest run src/lib/agents.test.ts`: chat grouping, dividers, ordering.
- `scripts/agents-e2e.sh [scenario…]` (opt-in, real turns, on Haiku): `src-tauri/examples/agents_e2e.rs` drives the real
  runner, store, bridge and MCP tools through the same Tauri commands the UI
  calls, on `claude --model haiku`, in a throwaway HOME (only the keychain is
  linked, for sign-in). Scenarios: memory across turns, quit mid-turn and
  relaunch (a second process, SIGKILLed), lost session file, a bound project agent
  (runs in the project, leaves a change card), delegation +
  two agents at once + the hop cap, Stop and interrupt, approvals (Allow,
  late Allow after a shortened wait, Always allow), a fake CLI (startup
  error, garbage output, crash, bare error code), damaged store files, 20
  rapid messages, Stop ending a turn's whole process tree (a background
  child included), quitting mid-turn (the Exit hook, then relaunch), and more
  turns than slots. `SHIPSTUDIO_AGENTS_APPROVAL_WAIT_SECS` shortens the 240s
  approval wait in debug builds only. `AGENTS_E2E_KEEP=1` keeps the HOME.
- Codex: `scripts/agents-e2e.sh codex-memory codex-stop codex-delegation`
  runs those scenarios on Codex. With Codex signed in they use the account
  (its `auth.json` copied into a throwaway `CODEX_HOME`); otherwise the real
  `codex` binary talks to a scripted Responses endpoint
  (`scripts/agents-e2e-codex-model.py`, passed in through the debug-only
  `SHIPSTUDIO_AGENTS_CODEX_CONFIG`), which proves resume, Stop/interrupt and
  delegation through the bridge, not a model's judgement.
  `AGENTS_E2E_CODEX=real|scripted|skip` forces one.
- `node scripts/harness-capture.mjs agents-`: project binding (`agents-project-*`), Chief audit (`agents-chief-audit`), brief in progress, team, What's in flight (`agents-team-overview`, via ⌘K), @mention menu, approval, first run (keep-awake off and on), new
  agent, import, Claude Code missing, the engine picker (`agents-engine-picker`) and a Codex agent's chat (`agents-codex-chat`).
