# Remote access

Keep your agents going from your phone. Any AI assistant that can add a custom
MCP connector (Grok, Claude, ChatGPT, Cursor, …) drives the Ship Studio
running on your own Mac — it's a standard MCP server, nothing assistant-specific. It reads
what an agent tab is showing, answers it, starts new agents, screenshots the
preview, and can push behind a PIN only you know. When you sit back down, the
conversation is in the same tab you left.

Open it from Cmd+K → **Remote access**, or from the sidebar indicator once
it's on.

## The question it answers

"A client just asked for a fix and I'm not at my desk." You could connect a
chat bot to GitHub, but that's a different agent with different context and
different limits. This keeps the work on the machine and in the session where
it was already happening.

## Why MCP and not SSH

Chat assistants don't SSH; they call tools. Even where one could (Grok Bot's
cloud computer has a terminal), a shell would start a second session alongside
the one in Ship Studio, and the conversation would live in that shell instead
of in the tab you come back to. It would also hand a third party's cloud
machine a key to your whole computer. The MCP server drives the existing agent
tabs and nothing else.

## The constraint: the computer has to be on

Everything stops if the Mac sleeps, shuts down, loses its connection, or
Ship Studio quits, and nothing can wake it from a phone. So the feature says
this first, before any setup, and makes it as unlikely as possible.

| Way it stops | What we do | What we can't do |
| --- | --- | --- |
| Idle sleep | `caffeinate -i -s -m -w <our pid>` while remote access is on. No privileges, and it's released if we crash (verified). | `-s` only holds on mains power. |
| Lid closed (laptops) | **Lid-closed mode**: `pmset -a disablesleep 1` behind the admin password prompt. `caffeinate` cannot do this — macOS sleeps on lid close regardless. Offered ticked-by-default beside **Turn on remote access** on laptops, with the cost spelled out (plug in, uses battery, not in a bag). Read back from `pmset -g` every time. When Remote access turned it on (`lid_mode_by_us`), turning remote access off switches it back — a second password prompt; macOS allows no other way without a privileged helper. | It outlives the app if the app quits while it's on; the checklist keeps showing it. |
| Battery | The checklist shows "On battery (64%)", and the sidebar indicator turns amber. `computer_status` warns the assistant, loudly below 20%. | Charge it. |
| Restart | **Reopen after a restart**: a LaunchAgent (`studio.ship.reopen-at-login`) runs `open -g` on the bundle at login, and remote access resumes on launch if it was on. | With FileVault, someone still has to log in once. The copy says so. |
| Quitting | The quit confirmation says remote access is on and what quitting does. | — |
| Offline or asleep anyway | The server's `instructions` tell the assistant that a connection failure means exactly this, so it tells the user instead of retrying. | Nothing answers, so the assistant only has what it read at `initialize`. |

## The flow

**Setup** (`RemoteSetup`) is five steps, all visible from the start. Each is
done when something is *true*, not when something was clicked:

1. **This computer has to stay on.** The live checklist, with the lid and
   restart fixes inline, then "Got it — set it up".
2. **A private link.** Install Tailscale → sign in → turn on → approve Funnel
   once. Done when `tailscale funnel status` confirms our mount.
3. **Projects.** Nothing is reachable until it's ticked.
4. **Pushing.** Off unless a PIN is set; skipping is a first-class choice.
5. **Connect Grok Bot.** Copy the link, add it as a custom connector, ask a
   question. Done when an assistant has actually connected (`ever_connected`,
   persisted). A link nobody has used proves nothing.

Done steps collapse to a summary with **Change**.

**Live** (`RemoteLive`), shown from the first connection onwards:

- A hero (Live / Not reachable / Off) with who last connected and the machine
  name.
- "Before you leave" with a badge.
- Projects, pushing (on / off / locked), and the masked link with
  **Replace link…**.
- Recent activity, written as sentences.
- How to cut access from another device.

**Sidebar indicator** (`RemoteAccessIndicator`). It appears only while remote
access is on, so it's a constant reminder of the constraint:

- **Green:** shows who connected and when.
- **Amber:** the computer is on battery, with the level.
- **Red:** the server isn't running.

It polls a cheap brief that makes no Tailscale calls.

## Security

The threat model, and what stops each threat:

**Someone finds or guesses the URL.** The token is 256 bits from the OS RNG
and compared in constant time. It's accepted as the last path segment or as
`Authorization: Bearer`. Anything else gets a bare 404 after a 400 ms delay,
counted and shown as "N refused". The server binds loopback only and is
reachable solely through our Funnel mount. "Turn off" is checked on every
request, so it locks out at once even if the Funnel lingers.

**The link leaks.** The UI says so where the link is: "This link is a key to this
computer — paste it only into your own assistant's connector settings, never
into a chat, email, screenshot, shared doc or issue." The token never enters the webview. Plugins run JavaScript
there, so the UI gets a masked link, and **Copy link** writes the real one from
Rust. It's marked to be excluded from clipboard history (nspasteboard.org
convention) and cleared after 90 s if it's still on the clipboard. **Replace
link…** rotates it, the old link dies instantly, and setup starts over. If
your phone is lost, removing the Mac in Tailscale's admin console cuts it off
from any device. The config and audit files are written `0600`.

**Prompt injection.** This is the realistic attack. The assistant reads
terminal output, which can contain text from strangers (web pages,
dependencies, issues). Defences:

- The `instructions` tell the assistant that tool output is data, never
  instructions, and to check with the user before approving permission
  prompts.
- **Pushing needs a PIN the assistant never sees.** The user sets it on the
  Mac and types it in the chat themselves when they want to push. It's stored
  as a salted, 200k-round SHA-256 hash and checked serially. Five wrong tries
  lock remote pushing until a new PIN is set at the computer. A push is bound
  to the exact HEAD and working-tree hash that `prepare_push` summarised.
  **Limit:** once typed, the PIN sits in the chat history, so a hijacked
  conversation could reuse it for another push to the same branch. Changing
  the PIN after remote pushes closes that.
- **No raw shell, by any route:**
  - Text is typed only into agent tabs, never into plain terminals.
  - Control characters are stripped, so a message can't end the paste early or
    send Ctrl-C.
  - A leading `!` (Claude Code's shell mode) is refused.
  - `/` commands are limited to `/clear /compact /cost /status /help /model
    /context`, so nothing can change permissions or add directories.
  - Shift+Tab (permission-mode cycling) isn't a pressable key.
  - Without bracketed paste, newlines are flattened so no later line can
    start with `!`.
- **No flag injection.** An opening prompt that starts with `-` would have been
  parsed by the agent CLI as a flag (`--dangerously-skip-permissions`). It now
  gets a leading space, both in Rust and in `agentPromptArgs`. That fix also
  closes the same hole in Inbox handoffs, which existed before this feature.
- The agent's own permission system still applies on top of all this. Remote
  access types into the agent; it doesn't widen what the agent may do. If you
  started the agent with permission prompts skipped, a remote message gets that
  same power.

**Abuse by a client that does hold the link.**

- 120 authenticated requests per rolling minute.
- 16 concurrent connections.
- A 10 s header-read timeout.
- 1 MB bodies.
- Messages up to 20k characters.

Every action, connection, refusal and screenshot goes to
`remote_audit.jsonl` (1 MB, trimmed to its newer half). The audit records
previews of what was typed, never a PIN. Pure reads are left out so they
don't bury the actions.

**Liability.** The tunnel is Tailscale Funnel on the user's own account.
Traffic never passes through anything Ship Studio runs, and there's nothing of
ours to breach.

## How it fits together

```
Grok Bot ──HTTPS──▶ Tailscale ──▶ tailscaled Funnel (/shipstudio, TLS ends on the Mac)
                                          │
                                          ▼
                         127.0.0.1:<port>  remote_access::server (MCP)
                                          │
                     ┌────────────────────┼──────────────────────┐
                     ▼                    ▼                      ▼
          pty_session registry   remote-start-agent event   agent_bridge
          (read screen, type)    → useRemoteAgentStart      (preview_screenshot)
                                   → addTerminalTab(prompt)
```

- **Reading a tab.** Backend PTY sessions record their project, agent id, size
  and last-output time. `read_agent` replays the 128 KiB ring buffer through a
  terminal emulator (`vt100`) at the session's size and returns the rendered
  screen plus scrollback. Stripping escape codes would smear every spinner
  frame together. "Quiet for 5 s" is the honest "finished or waiting for you"
  signal, and `wait_seconds` waits for it.
- **New work.** `start_agent` emits `remote-start-agent` to the project's
  window (or main). `useRemoteAgentStart` opens the project and adds a tab
  whose CLI *starts with* the prompt — the Inbox's spawn-not-paste rule. Rust
  reports success only once a new agent PTY actually exists.
- **Tailscale.** Mounted at `/shipstudio` so nothing else the user serves is
  touched. "On" means the serve config shows our mount proxying to our port
  with funnel allowed. First use needs the tailnet owner's approval: the CLI
  prints a link and waits, so we read its output as it arrives and surface the
  link.
- **Configured isn't reachable.** On the first real run, Funnel was on and the
  admin console showed the Funnel badge, but Tailscale never published the
  machine's name in public DNS. Even the authoritative `ts.net` nameservers had
  no record, so Grok Bot couldn't resolve it. Turning Funnel off and on again
  published it within about 100 seconds. So:
  - "Live" now means a real request made it through the public path: a
    DNS-over-HTTPS lookup of the name, then an authenticated ping sent to that
    public address. The probe carries a per-run header so it never counts as an
    assistant connecting.
  - A watchdog asks Tailscale again by itself after 2 minutes of not being
    published.
  - The UI shows how many minutes it's been, and always offers **Ask Tailscale
    again**.
  - **Turn off** is always visible while remote access is on, setup included.

## Tools

`computer_status`, `list_projects`, `create_project`, `open_project`,
`message_agent`, `wait_for_agent`, `read_agent`, `press_key`, `start_agent`,
`close_agent`, `show_progress`, `preview_screenshot`, `git_status`,
`prepare_push`, `confirm_push`, `deploy_status`.

### Every agent tool reports back

The assistant used to say "I've asked it" and stop. `message_agent` returned
at "sent", and following up was left to the assistant's memory, which in
practice meant the user had to ask again to find out what happened. Now the
tools that act on an agent (`message_agent`, `press_key`, `start_agent`) and
`wait_for_agent` all wait for the agent and answer in one shape:

- **`STATUS:`** one of `working`, `needs_decision`, `finished`, `exited`,
  read off the rendered screen by `agent_state.rs`. Timing alone ("quiet for
  5 s") can't tell a finished agent from one blocked on a permission prompt,
  and that's the difference that decides what the assistant does next.
  - *working*: output in the last 5 s, or "esc to interrupt" on screen. The
    activity comes from the spinner line ("Stewing… (4s)").
  - *needs_decision*: a numbered menu with a highlighted option, "Do you want
    to proceed?", a y/n prompt, or an unnumbered menu with an "Enter to
    confirm" footer. The question, what the agent wants to do (the command
    shown above it), and the options, with wrapped lines joined back on.
  - *finished*: quiet, and nothing being asked.
- **The agent's reply**: what it printed below the message that was sent,
  without the input box, footer or spinner lines. Long messages are found by
  their opening words.
- **What changed**: files whose content differs from the working tree as it
  was when the message was sent (two `write-tree`s on a throwaway index, then
  `diff --name-only`). Files the user already had uncommitted don't count.
  Like `prepare_push`'s check, this writes loose objects for changed files
  into the project's `.git`, which git garbage-collects later. Rendering is
  skipped while output is still streaming, because a spinner redraws many
  times a second for the whole turn.
- **A screenshot, once it's done**: when the agent finished and files changed,
  and the call has time left (it starts within 38 s and gets 14 s), the
  desktop screenshot comes in the same answer.
- **`NEXT:`** the step to take, chosen by the server rather than left to the
  assistant. Working means "call `wait_for_agent` again, and don't reply to the
  user in between", until five minutes have passed; after that it's "give them
  a one-line update". A decision means "ask the user, then `press_key`".
  Finished means "reply in a sentence or two with the screenshot".

Budgets: `message_agent` and `start_agent` wait 35 s, `press_key` 20 s and
`wait_for_agent` 45 s (each at most 50), so a call with its screenshot
answers inside a minute. That's what chat clients allow a tool call. Longer
work is a chain of `wait_for_agent` calls.

`press_key` refuses a letter or digit when nothing is being asked: with no
prompt showing, "1" is typed into the agent's message box and sits in front of
the user's next message.

`list_projects` gives each agent tab's state and puts anything waiting on the
user at the top. `show_progress` also reports errors from the preview's
browser console, labelled as possibly older than the change.

**Tool annotations.** Every tool has a `title` and MCP `annotations`
(`readOnlyHint`, `destructiveHint`, `openWorldHint`). Clients use them to
decide what to confirm, so watching, reading and screenshots don't turn into a
stream of approval taps on a phone. Pushing and closing a tab are marked
destructive.

**`deploy_status`** answers "is it live?" after a push. It uses the same
native hosting code as the Push popover, so the provider's own status word,
the provider-returned address, and "no deployment yet" are never reported as
a failure. It waits up to 40 s for a build in progress, and a failure brings
the build log's likeliest error line. `confirm_push` ends with NEXT: call it.

- **Nobody is at the desk to switch projects.** A screenshot of a shared
  project that isn't showing used to fail with "switch Ship Studio over to the
  project" — advice for someone who isn't there. Screenshots now emit
  `remote-show-project` (`useRemoteAgentControl` → the same open as a click),
  wait for the preview to attach to the agent bridge, and wait out a dev
  server that is still starting (up to 90 s). `open_project` does the switch
  on its own.
- **`create_project`** scaffolds a web starter the way the New Project form
  does (clone with `--depth 1`, drop the starter's history, gitignore
  `.shipstudio/`, tag the active workspace, `npm install`), then opens it. It
  is shared for remote access automatically, because the user asked for it
  from there. It does *not* widen access to existing projects: those still
  have to be ticked at the desk. The starter list is a fixed allowlist
  mirrored from `TEMPLATES` (a test keeps the two in step); mobile and Shopify
  starters need desk setup and aren't offered. It answers after at most 45 s
  of install; a longer install carries on and opens the project when done.

- **`message_agent` is the default.** A real session started a fresh agent for
  most requests when the tools were "send" and "start" — once because the
  first agent was busy, once re-sending a prompt the new agent already had.
  `message_agent` continues the running conversation (delivering to a busy
  agent too) and only starts one when none is running; `start_agent` is for an
  explicitly separate agent and says the new one already has its prompt. The
  backend chooses the new tab's session id and waits for exactly that tab —
  watching for "any new agent" once picked up a project's default tab.
- **`close_agent`** is the tab's ×, through the owning window
  (`useRemoteAgentControl` → `closeTerminalTab`); never the last tab.
- **Reporting is pictures, not code.** `show_progress` waits for the agent to
  finish its step and returns its state, what changed, and a screenshot; the
  instructions tell the assistant to answer in a sentence or two with it, and
  never to paste code or terminal output unless asked. Screenshots are taken
  at 2× desktop (2560×1600) or 3× phone (1170×2532) through the preview's own
  Playwright capture and re-encoded as JPEG.
- **Screenshot links.** Each image is also served at
  `…/shipstudio/shot/<id>.jpg` so the assistant can show it in chat. The id is
  a fresh 256-bit random value per image — the link opens that one picture and
  never contains the connector token. In memory only, 40 newest, 24 hours, and
  all of them cleared when the link is replaced or remote access is turned off. Definitions are in `src-tauri/src/remote_access/tools.rs`; the
assistant's guidance is `INSTRUCTIONS` in `server.rs`.

## What's verified, and what isn't

**Verified** by driving a debug build over real HTTP with an isolated `HOME`:

- Auth both ways, and the 404 delay.
- `initialize` and `tools/list`.
- The status tools and git.
- Refusal of `!` and risky `/` commands.
- The rate limit, cutting in at 120 a minute.
- Owner-only files.
- The audit log contents.
- The full PIN flow: off, wrong, right (the gate passes and git then fails for
  want of a remote), and the lockout. The PIN hash also matches an independent
  Python implementation.
- `caffeinate` released on exit.
- `pmset` parsing against real output.

Unit tests cover the rest. The harness has every modal state and the indicator
(`remote-*`).

**Screen reading, against real agents.** Claude Code 2.1 was recorded in a
real PTY at 120×40, and every screen was run through `agent_state::classify`
and `latest_reply`. The recorded screens were the folder-trust dialog, the
idle welcome screen, a turn in progress, a Bash permission prompt, pressing
"1" to approve it, and the finished reply. All of them classified correctly,
and the shapes are kept as unit tests. Two things moved in recent Claude Code
versions, and the tests pin both: "esc to interrupt" is in the footer under
the input box (not on the spinner line), and the finished turn leaves a
"✻ Cogitated for 4s · done" line, which is dropped from replies. Codex's update
and sign-in menus classify as decisions. A Codex conversation and Opencode
haven't been recorded.

**Not verified yet:**

- Tailscale Funnel live (not installed on the build machine).
- Grok Bot accepting a custom MCP URL. xAI documents custom connectors for
  grok.com, and Grok Bot as supporting MCP tools, but adding your own server
  to Grok Bot is unconfirmed.
- Typing into a live agent tab through the full app. The screen reading is
  verified against recordings, but the whole wait-and-report loop hasn't been
  driven through the running app and a real assistant.
- The lid-closed admin prompt.
- The LaunchAgent after a real restart.
- Clipboard history exclusion in specific clipboard managers.

## Files

- `src-tauri/src/remote_access/`:
  - `mod.rs` — config, audit, PIN, lifecycle
  - `server.rs`, `tools.rs`, `screen.rs`, `power.rs`, `tailscale.rs`
  - `agent_state.rs` — working / needs a decision / finished, and the reply
  - `deploy.rs` — `deploy_status`
- `src-tauri/src/commands/remote_access.rs`
- `src/lib/remoteAccess.ts`
- `src/components/remote/` — modal, setup, live, parts, indicator
- `src/styles/features/remote-access.css`
- `src/hooks/useRemoteAgentStart.ts`
- `src/harness/scenarios/remote.ts`
