# Agents — roadmap and gaps vs. Grok Bot

Planning doc, not a spec. Companion to [agents.md](agents.md) (what exists).
Researched 2026-11-03 against the `feature/agents` worktree and Grok Bot's
desktop bundle (`/Applications/Grok Bot.app`, `app.asar`, Oct 27 build).

**How the evidence was gathered.** Grok Bot capabilities come from (a) the
reference screenshot (UI chrome only) and (b) string identifiers in `app.asar`:
feature flags (`sand_*`, `grok_bot_*`), RPC names, and event names. An
identifier proves the code exists, **not** that the feature is shipped or on for
every user; many are flag-gated. Ship Studio claims were checked in the source
unless marked *unverified*.

---

## 1. Gap table

Status: **have** / **partial** / **missing**. Impact = how much the owner (daily
Grok Bot user) would feel its absence.

### Chat and composer

| Capability | Grok Bot evidence | Ship Studio today | Impact |
| --- | --- | --- | --- |
| Dictation into composer | mic button in composer (screenshot); `action_button_dictation`, `dictating`, `dictation_active`, `transcribeAudio` | **missing** — no audio code anywhere in `src/` or `src-tauri/src/`; no mic usage string or entitlement | **high** |
| Hands-free voice mode | waveform button (screenshot); `voice_chat`, `sand_voice_call`, `sand_voice_resumption`, `barge_in_overlap_ms_*`, `first_audio`, `audioworklet`, `cartesia`, `elevenlabs` | **missing** | **high** |
| Attachments (files, images) | `+` in composer (screenshot); `attachments`, `stageAttachmentPath/Bytes`, `readAttachmentImage`, `maxStagedAttachments`, `attachment_too_large`, `prepareImageForModel` | **missing** (agents.md "Known limits") | **high** |
| Quote selection into composer | "Add to chat ⌘L" hover on selected text (screenshot); `replyQuote`, `pinned_selection` | **missing** | med |
| Reply-to / threads off a message | `createThreadFromMessage`, `replyQuote` | **missing** | low |
| Reactions | `reactToMessage`, `reaction`, `reactionAck` | **missing** | low |
| Interrupt / steer a running turn | `interruptAgentRun`, `user_interrupt`, `steer` | **partial** — Stop kills the turn and drops the queue; new messages queue for the *next* turn, no mid-turn steer | med |
| Offline / queued send | `queued_offline`, `clientQueuedSend*` | **have** (local inbox queue; no network dependency) | — |
| Slash commands / @mentions | `sand_hide_slash_commands`, `sand_hide_at_mentions` (flags to *hide* them, so they exist) | **missing** | med (`@Finance` to route is natural) |
| Message link hover cards | `sand_message_link_hover_cards` | **missing** | low |
| Visualizations / widgets inline | `sand_enable_visualizations`, `sand_enable_page_widgets`, `sand_media` | **missing** (text bubbles only) | med |

### Agents and team

| Capability | Grok Bot evidence | Ship Studio today | Impact |
| --- | --- | --- | --- |
| Main agent that manages others | `sand_grok_main_agent`, `grok_bot_task_subagent_roster`; screenshot "Messaged / Message from" dividers | **have** (Chief of Staff, `message_agent`, hop cap 6) | — |
| Pin / hide / mark unread / unread dot | screenshot dot; `pinnedAgents` | **have** | — |
| Sidebar sections | `sidebarSections`, `move_to_section`, `move_to_new_section` | **missing** | med (owner already has 11+ agents) |
| Agent archive | `agent_archived` | **partial** (Hide) | low |
| Auto titles / activity recency | `sand_agent_titles`, `sand_sidebar_activity_recency`, `sand_attention_pill` | **partial** — activity line + "Needs your OK"; sort by recency *unverified* | low |
| Templates / sharing | `createAgentFromTemplate`, `publishBotTemplate`, `bot_template_share`, `setBotTemplateVisibility`, `sand_search_browse_shared_bots` | **missing** (import from another assistant only) | med |
| Group chats / multiplayer / teammates | `grok_bot_group_chats`, `grok_bot_multiplayer`, `sand_invite_teammates`, `grok_bot_team_*` | **missing** | low now (single user) |
| Per-agent model choice | `switchModel`, `requestedModel`, `sand_side_model_status` | **partial** — `Agent.model` exists and `runner.rs:384` passes `--model`, but no UI sets it | med |
| Memory | `add_to_memory`, `grok_bot_memory_import`, `folderMemory` | **have** (`## Memory` in each agent's CLAUDE.md, self-maintained) | — |
| Tasks page | `sand_tasks`, `sand_tasks_page` | **missing** (no cross-agent "what's in flight" view) | med |

### Proactivity, notifications, reach

| Capability | Grok Bot evidence | Ship Studio today | Impact |
| --- | --- | --- | --- |
| Routines (scheduled agent runs) | `routines`, `listGrokBotAgentRoutines`, `setGrokBotAgentRoutineEnabled`, `sand_enable_page_routine_buttons` | **missing** for agents (workflow scheduler exists for project workflows) | **high** |
| Reminders | `reminders`, `ios_read/write_reminders` | **missing** (only via whatever MCP the user has) | med |
| OS notifications + sounds | `notifications`, `setAgentNotifyOnUpdates`, `sand_notification_sounds`, `sand_notifications_enable_card`, `grok_bot_hold_push_until_desktop_inactive` | **missing** — no notification plugin in `Cargo.toml`/`package.json`; unread badge only | **high** |
| Menu-bar tray / pop-out chat | `sand_menubar_tray`, `sand_chat_popout` | **missing** | med |
| Search across conversations | search button (screenshot); `search_conversations`, `conversationSearchArgs`, `grok_bot_pages_search` | **partial** — sidebar filters agents by name only | **high** |
| Mobile app + phone tools | `sand_mobile_local_tools`, `mobile_read_calendar/contacts`, `mobile_tool_permission`, `car_session`, `carplay` | **partial** — Remote Access exposes agents to a phone assistant over MCP; no native app | med (planned) |
| Messaging (SMS/iMessage) | `grok_bot_messaging`, `sand_messages_tools`, `messages_contacts_denied` | **missing** (only via user's MCP) | low |
| Agent email inbox | `grok_bot_agent_mail`, `..._multiple_inboxes` | **missing** | low |

### Tools, safety, cost

| Capability | Grok Bot evidence | Ship Studio today | Impact |
| --- | --- | --- | --- |
| Connectors marketplace (OAuth) | `connectors`, `connectorAuth`, `connector_card`, `sand_custom_connector_entrypoint`, `grok_bot_marketplace_*` | **partial** — inherits the user's Claude Code MCP servers; no in-app connect UI for agents (Ship Studio has an MCP modal for projects) | med |
| Local computer use | `sand_enable_local_cua`, `computer_use_*`, `computer_click/type/screenshot` | **partial** — Claude Code can shell out; no GUI control | low |
| Browser | `browser_view`, `browserView` | **partial** (WebFetch; agent bridge preview tools are project-scoped) | low |
| Approval cards | `approval_card`, `grok_bot_publish_confirm_card`, `grok_bot_spend_approval_passkey` | **have** (Allow/Deny, 30-min timeout) | — |
| Permissions panel / tool allowlist | `sand_permissions_panel`, `sand_tool_allowlist`, `sand_auto_review_selector` | **missing** (no "always allow this" per agent) | med |
| Secrets vault | `grok_bot_vault`, `grok_bot_secure_values_any_site` | **missing** | low |
| Usage / spend limits | `grok_bot_check_subscription_usage`, `usageWarning`, `setSpendLimit`, `configureSpendLimit` | **missing** — `result` event's cost/usage fields are not read (`runner.rs:492`) | med |
| Library / pages / canvas | `grok_bot_library_pages`, `grok_bot_documents_ui`, `grok_bot_canvas_design_mode`, `grok_bot_files_in_agent_store` | **missing** (agent home folder exists but isn't surfaced) | med |
| Appearance / accent theming | `sand_appearance_picker_card`, `grok_bot_all_bots_color_theming` | **have** (avatar shape + colour) | — |

---

## 2. Voice

Two different features with different latency budgets. Build dictation first; voice
mode reuses its capture path.

### Verified facts about this machine / repo

| Check | Result |
| --- | --- |
| Existing audio code | none (`getUserMedia`, `MediaRecorder`, `SpeechRecognition`, `AVAudio`, `SFSpeech`, `whisper`, `cpal` — zero hits) |
| `src-tauri/Info.plist` | only `NSAppleEventsUsageDescription` (Spotify). **No** `NSMicrophoneUsageDescription`, **no** `NSSpeechRecognitionUsageDescription` |
| `src-tauri/Entitlements.plist` | only `com.apple.security.automation.apple-events`. **No** `com.apple.security.device.audio-input` — required for mic under the hardened runtime that notarized builds use. Dev builds (ad-hoc) will appear to work without it; release will silently get no audio. Same trap the plist comment already describes for Apple Events |
| WKWebView probe (plain `WKWebView`, macOS 26.6, `https://localhost` base URL, script in scratchpad) | `webkitSpeechRecognition`: **present** (function). `speechSynthesis`: present, `getVoices()` returned 0 synchronously. `MediaRecorder`, `AudioContext`: present. `navigator.mediaDevices.getUserMedia`: **absent** in that probe |
| Grok Bot's plist | `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription` (+ camera, Bluetooth) |

*Unverified:* whether `webkitSpeechRecognition.start()` actually produces results inside
Tauri's WKWebView (`tauri://localhost` origin), and whether `getUserMedia` is exposed
there (wry needs a media-capture permission delegate; the probe above didn't have one).
Both need a 30-minute spike in the real app before anything is designed around them.

### (a) Dictation into the composer

Goal: hold/tap mic, speak, text appears in the composer (live partials), user edits, sends.

| Option | How | Latency | Privacy | Cost | Risk |
| --- | --- | --- | --- | --- | --- |
| A. Web Speech API in WKWebView | `new webkitSpeechRecognition()`, `interimResults` | low (streaming) | Apple server unless on-device | free | **High**: constructor exists, but WebKit-in-app support is historically flaky ("service-not-allowed"); no control over model or locale fallback |
| B. Native Apple speech via Rust bridge | Small Swift/ObjC shim (we already link `objc2`/`block2`) or a Tauri plugin. macOS 26 `SpeechAnalyzer`/`SpeechTranscriber` (on-device, long-form, fast); fallback `SFSpeechRecognizer` with `requiresOnDeviceRecognition` on 13–15. Partials emitted as Tauri events | low, streaming partials | on-device | free | Med: Swift interop in a Rust crate; needs mic **and** speech-recognition permission prompts; SFSpeech has a ~1 min per-request cap (fine for dictation) |
| C. Local Whisper (`whisper.cpp`, Metal) | Capture PCM in Rust (`cpal`), run `small`/`base.en` or `large-v3-turbo` | batch: ~0.5–2 s after release on Apple Silicon (unverified here); streaming is hacky | on-device | free; +75–800 MB model download | Med: model management, CPU/GPU spikes while agents run |
| D. Cloud STT (OpenAI, Deepgram, ElevenLabs Scribe, Groq Whisper) | Upload clip or stream via websocket | 300 ms–1.5 s | audio leaves the Mac to a third party | ~$0.2–0.4/hr; needs an API key the user doesn't have today | Low tech risk; product risk: a new account + key for a "free, runs on your Mac" product |

**Recommendation:** **B** (native Apple, on-device), with **A** only as a throwaway spike to
learn if it works for free. Reasons: no download, no key, no cost, private, streaming
partials, and it's what "Fn Fn" system dictation users already trust. Keep C as an opt-in
"higher accuracy" engine later (better at code identifiers and names). Don't ship D unless
the owner wants cloud voices anyway (see voice mode).

Dictation UX details to not forget:
- **⌥Space / hold-Fn-style push-to-talk** in the composer, and a click toggle. Escape cancels.
- Partials render greyed in the composer; final text replaces them. Never auto-send on dictation.
- Custom vocabulary: feed agent names + project names as contextual strings (`SFSpeechRecognitionRequest.contextualStrings` / analyzer equivalent) so "Ship Studio Builder" transcribes right.
- Permission-denied state with a "Open System Settings" link; the mic icon shows why it's disabled.
- Mic indicator: macOS shows its own orange dot; ours should also show recording state.

### (b) Hands-free voice mode (waveform button)

Goal: talk to an agent conversationally; it talks back; you can interrupt.

The hard part isn't STT or TTS, it's **turn latency with Claude Code underneath**. A
`claude --print --resume` turn takes seconds to tens of seconds (process spawn, session
load, tool use). Grok's identifiers (`first_audio`, `barge_in_overlap_ms_*`,
`audioworklet`, `cartesia`, `elevenlabs`, `realtimeConversationId`) indicate a realtime
pipeline with streaming TTS. We cannot match "realtime" by piping a full Claude Code turn
through TTS.

Design that fits our architecture:
1. **Listen**: same native STT as dictation + voice-activity detection (end of speech ≈ 700 ms silence). The final utterance goes to the agent as a normal user message (it's in the chat log as text, tagged as spoken).
2. **Bridge filler**: while the turn runs, play a short earcon and speak the agent's activity line ("Checking your calendar") at most every ~8 s. This is honest (it's real `describe_activity` output), and it covers the gap.
3. **Speak**: stream each top-level text block to TTS as it arrives (we already get blocks incrementally). A voice-specific system-prompt addendum asks for short, speakable replies with no markdown/tables when the turn originated from voice.
4. **Barge-in**: user speech during playback stops TTS immediately; if a turn is still running, the new utterance queues (or Stops, configurable).
5. **Approvals by voice**: "Allow" / "Deny" spoken while a card is pending. Risky: require the exact card to be read out, and never accept voice approval for push/send/spend — those stay tap-only.

TTS options:

| Option | Quality | Latency | Cost | Notes |
| --- | --- | --- | --- | --- |
| `AVSpeechSynthesizer` (native, via bridge) | good with Premium/Personal Voice; robotic with defaults | ~100 ms, local | free | Premium voices are a user download in System Settings |
| `speechSynthesis` in WKWebView | same voices as above | low | free | voices list loaded async (0 in probe at first call); quickest spike |
| Cloud (ElevenLabs, Cartesia, OpenAI TTS) | best | 150–400 ms to first audio, streaming | ~$15–$100+/M chars | needs a key; text of every reply leaves the Mac |

**Recommendation for voice mode:** native STT + `AVSpeechSynthesizer` first (free,
private, ships without accounts), architected so a cloud TTS provider can be plugged in
behind a setting. Build it as a **floating voice HUD** (waveform, transcript, "working:
<activity>", stop) rather than a separate screen, so it works with the window in the
background and later from the menu-bar tray.

Effort: dictation (B) ~3–5 days incl. permissions, entitlements and release-build test.
Voice mode on top ~1.5–2 weeks to be good (VAD, barge-in, filler, prompt tuning).

Required config changes (both): `NSMicrophoneUsageDescription` and
`NSSpeechRecognitionUsageDescription` in `src-tauri/Info.plist`;
`com.apple.security.device.audio-input` in `src-tauri/Entitlements.plist`; verify in a
**notarized release build**, not dev.

---

## 3. Other gaps worth building

| # | Gap | Design sketch | Effort |
| --- | --- | --- | --- |
| 1 | **OS notifications** | `tauri-plugin-notification`. Fire when an agent posts a top-level reply or an approval card **and** the window isn't focused (or a different agent is open). Title = agent name, body = first line. Click → focus window, open that agent. Per-agent mute (Grok: `setAgentNotifyOnUpdates`). Approval cards always notify. Dock badge = total unread. Optional sound. | 1–2 d |
| 2 | **Attachments / images** | Paste, drag-drop, `+` picker. Copy into `<agent home>/attachments/<msg id>/`, add `attachments: [{name, path, mime, size}]` to `AgentMessage`, prompt says "Attached: <path>" so Claude Code's Read tool loads images/PDFs natively (no `--input-format stream-json` needed; that's an alternative if Read is unreliable). Thumbnails in the bubble. Size cap (e.g. 25 MB). Agent→user files: a `share_file` MCP tool that posts a file card. | 3–4 d |
| 3 | **Routines (scheduled check-ins)** | Reuse `workflow_scheduler.rs`'s tick, not a second clock. Two shapes: (a) user-defined ("every weekday 8am: brief me"), (b) agent-requested via a new MCP tool `schedule_check_in {when, note}` so "I'll check back Thursday" is real. Store in `agents.json` (or `routines.json`). A due routine queues a normal turn with a framed prompt. Inherit the scheduler's rules: fires only while app is running, never catches up, one at a time, and the UI says so. Show routines on the agent's profile with on/off. | 4–6 d |
| 4 | **Search across conversations** | Search `messages.jsonl` across all agents (plain scan is fine at this scale; add an index later). ⌘F in a chat, ⌘⇧F global; results grouped by agent, jump to message with highlight. Sidebar's search button opens it. | 2–3 d |
| 5 | **Per-agent model choice** | Backend already supports it. Add a select in `AgentEditorModal` (Default / Opus / Sonnet / Haiku, from the CLI's accepted aliases); Chief's `create_agent` / `update_agent` gain optional `model`. Show the model in the agent header. | 0.5–1 d |
| 6 | **Concurrency + cost visibility** | Read `total_cost_usd` / `usage` / `duration_ms` from the `result` event into a per-turn record. Show per-agent and today's totals in a Usage panel. Note that subscription users don't pay per token: show tokens/turns, label $ as "API-equivalent". Global cap on simultaneous turns (default 3) with a visible "Queued — 3 agents already working" state. | 2–3 d |
| 7 | **Sidebar sections** | `section: Option<String>` on `Agent`; drag between sections, collapse state in UI state. Chief always on top. Chief can `move_agent_to_section`. | 1–2 d |
| 8 | **Quote selection / reply-to** | Select text in a bubble → "Add to chat ⌘L" (like Grok) inserts `> quote` into the composer. Reply-to = same plus a `reply_to` message id rendered as a quote stub. Skip threads. | 1 d |
| 9 | **Reactions** | Low value for agents unless they mean something: 👍 = "ack, no reply needed" (no turn), 👎 = feedback appended to the next turn. Otherwise skip. | 0.5 d |
| 10 | **Agent templates / sharing** | Export an agent as a file (`.shipagent` JSON: name, role, instructions, avatar, model; **no memory by default**). Import via file or deep link `shipstudio://agent?...`. A built-in gallery of 6–8 starters (Builder, Researcher, Inbox, Finance…) for first run. Public marketplace later, if ever. | 2–3 d |
| 11 | **Mid-turn steer** | Claude Code `--print` can't accept input mid-turn. Options: keep queueing (today), or "Stop and send" which kills and resumes with the new message. Ship "Stop and send" as a composer action while busy. | 0.5–1 d |
| 12 | **Always-allow rules** | On an approval card: "Always allow this for <agent>" writes a scoped rule (tool + command prefix / domain) to the agent's `.claude/settings.json` `permissions.allow`. Visible + revocable on the agent profile. Never for push/send/spend. | 2 d |
| 13 | **Menu-bar tray + quick chat** | Tray icon with unread count, global hotkey opening a small composer to the Chief (where dictation shines). | 2–3 d |
| 14 | **Tasks view** | One list of every agent's in-flight turn, pending approval, and scheduled routine. Mostly existing state, new view. | 1–2 d |
| 15 | **Mobile companion** | Phase 1 (exists): any MCP assistant via Remote Access (`message_agent`, `wait_for_agent`, `read_agent`, `import_agents` in `remote_access/tools.rs`). Phase 2: native iOS/Android app as a thin client over the **same** Funnel endpoint with a dedicated, non-MCP JSON API (list agents, read chat, send, approve with Face ID). Push notifications need a relay (APNs/FCM need a server key), which breaks the "nothing on our infrastructure" property of Remote Access — decision below. Phone dictation is free (OS keyboard). | 3–6 wks |

---

## 4. Questions for Julian

One line each; my recommended default in brackets.

| # | Question | Default |
| --- | --- | --- |
| 1 | Voice audio stays on the Mac (Apple on-device), or are cloud STT/TTS acceptable for better quality? | On-device first; cloud TTS as opt-in later |
| 2 | Should voice mode speak full replies, or a short spoken summary with the full text on screen? | Short spoken version (voice-mode prompt addendum) |
| 3 | Can spoken "allow" approve an approval card? | Yes for reads/edits, never for push/send/spend/delete |
| 4 | Dictation shortcut: hold-to-talk, toggle, or both? Which key? | Both; ⌥Space in composer, Escape cancels |
| 5 | May agents schedule their own check-ins, or only the user? | Agents may, each shown as a card you can cancel |
| 6 | Routines only run while Ship Studio is open — acceptable, or do we need a launch agent / login item? | Acceptable for v1, say so in the UI; Remote Access already pushes "reopen at login" |
| 7 | Notify on every agent reply, or only replies to you + approvals (not agent-to-agent chatter)? | Replies addressed to you + approvals |
| 8 | Global cap on agents working at once? | 3, configurable |
| 9 | Show cost in dollars, tokens, or neither (most users are on a subscription)? | Turns + tokens; $ labelled "API-equivalent", in a settings panel only |
| 10 | Default model for new agents, and may the Chief choose models for agents it creates? | CLI default; Chief may pick, user can override |
| 11 | Should exported/shared agents ever include memory? | Never by default; explicit checkbox |
| 12 | Mobile: is a push-notification relay we operate acceptable? | Yes, a content-free relay ("Finance replied"), body fetched over the user's own Funnel |
| 13 | Mobile: native apps, or a PWA served over the Funnel first? | PWA first to learn, native once the API is stable |
| 14 | Do agents stay Claude-Code-only, or must Codex/Opencode agents ship before GA? | Claude Code only until voice + routines ship |
| 15 | Is Agents for the owner only, or a headline feature for all Ship Studio users (affects onboarding, templates, polish bar)? | Headline feature; build the starter gallery |
| 16 | Group chats (several agents in one conversation)? | Not now; Chief-mediated delegation covers it |

---

## 5. Suggested sequencing

| Order | Build | Why now |
| --- | --- | --- |
| 1 | **Notifications** + per-agent mute + Dock badge | Smallest effort, biggest daily-use fix: agents work in the background and today nobody knows when they finish. |
| 2 | **Per-agent model UI** + **cost/usage capture** + **concurrency cap** | Backend half-exists; capture data before people run 15 agents. Cap prevents quota surprises. |
| 3 | **Attachments** (paste/drop images, files) | Daily-use parity; screenshots are how people brief agents. Unblocks voice-mode "look at this". |
| 4 | **Dictation (native, on-device)** + Info.plist/entitlement changes | Owner asked for it explicitly; lays the audio/permission foundation; must be tested in a notarized build. |
| 5 | **Routines + `schedule_check_in`** on the existing scheduler tick | The intelligence gap: makes "I'll check back" true. Needs notifications (1) to be useful. |
| 6 | **Search** + **quote/⌘L** + **sections** | Polish that scales with agent count; cheap. |
| 7 | **Voice mode** (HUD, VAD, barge-in, filler, speakable prompt) | Biggest effort; depends on dictation (4) and benefits from tray (8). |
| 8 | **Tray + global hotkey quick chat**, **always-allow rules**, **templates/starter gallery** | Reduce friction once the core loop is solid; gallery matters if Agents is a headline feature (Q15). |
| 9 | **Mobile companion** (PWA → native) | Remote Access covers the phone today; native needs Q12/Q13 answered and a stable API. |

Not planned: reactions beyond ack, group chats, secrets vault, agent email inboxes,
SMS, computer use. Revisit if usage asks for them.
