# Agents

Persistent, named agents you chat with, the way Grok Bot works on desktop, but
every agent is a Claude Code session on your own Mac. One of them, the **Chief
of Staff**, manages the rest: it creates agents, briefs them, delegates to them,
keeps track of what they're doing, and deletes them when you say so. You can
talk only to the Chief and let it run everything else.

Agents is a mode, not a page. The sidebar's **Agents** row (or ⌘K → Agents)
turns the whole window into the chat app: agent list on the left, one
conversation on the right. The house icon goes back to Projects.

## What an agent is

| Piece | Where | Notes |
| --- | --- | --- |
| Identity | `<projects root>/.shipstudio/agents/agents.json` | name, role, avatar (shape + colour key), pinned/hidden, unread, Claude session id |
| Home | `<projects root>/.shipstudio/agents/<id>/` | the agent's working directory |
| Instructions + memory | `<home>/CLAUDE.md` | Claude Code loads it every turn. Instructions on top, `## Memory` below, which the agent maintains itself. Editing instructions never touches memory. |
| Conversation | `<home>/messages.jsonl` | what *you* were shown: your messages, its replies, agent-to-agent lines, approval cards, errors |

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
- an `is_error` result, or a non-zero exit with no result, becomes an error
  bubble, classified through `classify_agent_cli_failure` so usage limits and
  expired logins read the same as everywhere else.

A vanished session (`--resume` → "No conversation found") is replaced once with
a fresh one. **Stop** kills the process and drops the queue. A turn is capped
at 3 hours.

## Tools agents get (`src-tauri/src/agents/mcp.rs`)

Served by the existing loopback agent bridge at
`/mcp/<bridge token>/agents/<agent id>`. The id in the path is the caller, and
the URL is passed only inline to the process Ship Studio spawned for that agent.

| Tool | Who | What |
| --- | --- | --- |
| `list_agents` | all | names, roles, busy / waiting |
| `message_agent` | all | async: records "Messaged X" here and "Message from Y" there, queues a turn for X |
| `list_projects` | all | Ship Studio projects and paths |
| `create_agent` | Chief | name, role, instructions, optional `first_task` |
| `update_agent` | Chief | name / role / instructions (memory kept) |
| `delete_agent` | Chief | puts an Allow / Deny card in the Chief's chat first |
| `approve` | CLI only | the permission prompt tool (below) |

**Loops.** Agents messaging agents can ping-pong. A user message starts a chain
at hop 0; each `message_agent` from a turn at hop *n* delivers at *n+1*, and
`message_agent` refuses past hop 6. The prompts also tell agents not to send
acknowledgements to each other.

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
**Deny** just records the answer. Live cards survive restarts, because the
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
them under Permissions with Revoke.

## Steering a working agent

Sending mid-turn queues the message for the next turn (default). The newest
queued bubble says "Queued, sends when <agent> finishes" with **Interrupt and
send now**; ⌘↵ in the composer sends and interrupts at once. A message is
queued when it was sent after the turn in progress began (`isQueued`: its `ts`
is after `status.since`). `agents_interrupt` cancels the turn without dropping
the queue (Stop drops it); the cut-off reply is kept as `stopped`, a note
"Interrupted to read your new message" is recorded, and the next turn's prompt
opens with `prompts::interrupted`: what it was working on, its last step, and
that the work already done stands. A card the interrupted turn was waiting on
stays live, with the usual late-Allow behaviour.

## Notifications (`src-tauri/src/agents/notify.rs`)

The backend decides, since it knows when a message is recorded and when a turn ends.

- **On screen** = a *focused* window is showing that agent (`agents_focus` reports which agent each window shows; focus is asked of the window at that moment). Messages on screen neither notify nor count as unread.
- A reply or error off screen notifies with the agent's name and the first line. Inside a turn they are held and posted once when it ends, with the latest text. An approval posts at once, with a sound.
- Bursts across agents are capped (3 per 20s); the rest stay silent but still count.
- **Mute** (row context menu) stops OS notifications for that agent; a bell-off mark shows in its row. Unread and the badge still count it.
- **Dock badge** and the sidebar nav badge = unread + pending approvals across non-hidden agents. Approval cards don't add to unread; they count as pending until answered.
- Clicking a notification focuses a window and emits `agents://open`; the app switches to Agents and opens that agent. Focusing a window clears the unread of the agent it shows.
- Uses `tauri-plugin-notification` (2.8, click reporting on macOS). Not verified in a real build yet: the dev binary posts under another app's identity, so click-through should be checked in a signed build.

## Import from Grok Bot (or any connected assistant)

Only the other assistant knows its own agents, instructions and memory, so the
import runs from its side. Remote access gains an `import_agents` tool:
`{source, agents: [{name, role, instructions, memory, is_main}]}`. Ship Studio
creates each agent, writes its instructions, and appends its memory under
`### Imported from <source>`. The `is_main` agent merges into the Chief of
Staff. Re-importing updates same-named agents instead of duplicating them.
Imported agents don't run until you message them. Every import is audited like
any other remote-access action.

The **Import agents** button in Agents mode shows the one message to send your
assistant and links to Remote access setup.

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

## Search, model and usage

- **Search.** In Agents mode the sidebar's top field searches conversations
  (⌘F focuses it; ⌘K stays the palette, and the palette's "Search agent
  conversations" does the same). With no sidebar to hold it (compact width, or
  the rail collapsed) it opens over the chat instead. It scans every agent's
  `messages.jsonl` directly, with no index: every word must appear, case is
  ignored, newest first, at most 50 hits (`src-tauri/src/agents/search.rs`).
  Results replace the list, grouped by agent. Enter opens the first hit;
  opening one loads older history if needed, expands a collapsed agent-to-agent
  thread that holds it, centres the line, and puts focus in the composer. Esc
  anywhere in Agents mode clears it (in the composer, Esc closes search before
  it would stop a working agent).
- **Messages.** Agent replies are prose on the canvas; your messages are
  bubbles. Hover or focus shows Copy and the time (the exact time is its
  tooltip). The newest error, with nothing said since, offers Retry (sends
  your last message again, words only) and, for an expired login, "Sign in to
  Claude Code" (the same `claude auth login` terminal the dashboard uses).
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

## Known limits / next

- Claude Code only. The runner is CLI-specific in `run_turn`; Codex
  (`codex exec --json`) and Opencode would slot in there.
- No OS notification when an agent replies while Ship Studio is in the
  background. The unread badge is the only signal.
- Agents can't send files back to you yet (a `share_file` tool would post a
  file card).
- Search scans files on every query. Fine at one person's scale (tens of
  agents, thousands of lines); an index would be needed well past that.
- Many agents can run at once; there's no global concurrency cap.
- Debug builds: `research/design-canvas` (not on main) disables the agent
  bridge under `debug_assertions`. Agents depends on it, so that branch needs
  an exception for the `/agents/` route before both land.
- Mobile: the import tool and remote access already put Agents within reach of
  a phone assistant. A native client would talk to the same commands.

## Testing

- `cargo test --lib agents::`: store, prompts framing, activity labels, MCP
  tool visibility, approval descriptions, import merge rules.
- `pnpm vitest run src/lib/agents.test.ts`: chat grouping, dividers, ordering.
- `node scripts/harness-capture.mjs agents-`: team, approval, first run, new
  agent, import, Claude Code missing.
