# Comments

Comments live in **Team → Comments**, and that tab being open is what arms
clicking an element in the preview. There is no separate comments mode and no
floating comments panel: opening the tab brings the preview forward and starts
the dev server the way Variables does, and the tab says why you cannot place one
when the preview is not running.

Click an actual page element, write the note, and choose **Save comment**. Adding
a comment never calls an agent or writes to website source. Hovering outlines the
target in Harbr green and dims the surrounding canvas; the target stays
clear while writing.

**A note lives on the thing it is about, not only in a list.** Each comment is a
numbered pin on its element; clicking the pin opens the note beside it, and
hovering one outlines its element without moving the page. Pins are placed from a
live rect on every scroll, resize and DOM change, so they follow their element
instead of drifting.

A pin is drawn only when the element still matches — same tag, same text. A
comment written on another branch, or on a page that has since changed, lists in
the panel and draws no pin rather than pointing at the wrong thing.

Click another element to retarget without losing draft text; Escape clears the
highlight, and the next click selects a fresh target. Saving is asynchronous, so
the button is dead while the record is written — clicking it repeatedly cannot
file the same note twice.

## Handing comments to an agent

Nothing is selected by default. Ticking a comment reveals the send button, named
for how many are going: **Send comment to agent** for one, **Send comments to
agent** for several. Sending pastes one prompt into the chosen terminal. It does
not press Enter — you start the request and review the results yourself.

The prompt carries each thread's id, so an agent can say which note it addressed
and write a `resolve` record for it (see the `shipstudio-team` skill in
[team-multiplayer.md](team-multiplayer.md)). Everything interpolated into it is
flattened to a single line: element text is captured from a live page, and a page
can contain a line that would otherwise forge a heading in the prompt.

The tick is one piece of state shared by the pin and the panel row, so the two
can never disagree about what is going.

## State and storage

Comments are **records in the repository**, not local notes. Each one is a
write-once JSON file under `.shipstudio-team/threads/`, folded into threads at
read time, and carried between machines on a ref of their own. See
[team-multiplayer.md](team-multiplayer.md) for the record format and the
transport.

What that changes, compared with the localStorage version this replaces:

- **They are shared.** A teammate sees a comment once it has been pushed and
  they have fetched.
- **They are not branch-scoped.** The branch a note was written on is recorded
  and shown, but the note is visible from every branch — a review comment that
  only exists on the branch being reviewed is a note to yourself.
- **Editing and deleting are appends.** An edit writes an `edit` record and a
  delete writes a `retract`; the original file stays, because two people acting
  at once must never produce a merge conflict. Authorship is enforced when
  records are folded, so a record claiming to edit someone else's message is
  written and never rendered.
- **Resolution is shared**; whether *you* pasted a note into a terminal is not,
  and stays in this machine's localStorage.

Notes written before this change are migrated into records the first time their
project is opened, once, and the originals are left in localStorage untouched.

A failed write keeps the comment on screen and says so. A comment saved while
the remote is unreachable is kept and counted as unshared rather than lost.

## Element context and agent prompt

The preview proxy injects `comments_script.html`, inert until explicitly enabled.
It captures route (including query/hash), a unique CSS selector, tag, classes,
text, nearby heading, ancestors, viewport dimensions, and the element rectangle.
Source attributes are included only when present, labelled as hints. Screenshot attachments are not part of canvas comments.

The prompt is one numbered section per comment, following the convention these
visual-feedback tools have settled on (Agentation is the reference): a heading naming
the element the way a person would — `### 2. section · Welcome home` rather than an
nth-of-type selector — then **Page**, **Location** (a readable `main > div > section`
ancestry), **Selector**, **Applies to**, the **Comment ID**, and the user's words last
under **Feedback**. The number is the one drawn on the pin, so the user and the agent
can say "comment 2" and mean the same element.

**Context sent** chooses how much each comment carries: *compact* is one line per note,
*standard* is the fields above, *detailed* adds classes, nearby heading, text, the
element rect with its captured viewport, and any source hint.

What is deliberately not borrowed from a clipboard-based tool is a bare markdown dump.
Harbr pastes this into a live agent terminal rather than the clipboard, so the
preamble stays: only **Feedback** is a user request, every other field is captured page
content labelled untrusted reference data, `applyTo` is separate from the captured
viewport, and the agent must verify project, branch and target, flag ambiguities and
conflicts, test, and report by comment ID. Source hints and selectors are not proof.

Selecting a saved note locates its target in the preview. A selector must match
a unique element with the same tag and captured text. If the target has changed,
edit the note and click the intended element to update it.

## Implementation boundaries

- `useCanvasCommentsLayer` is a layer hook, not a component, because its halves mount
  in different places — the same arrangement `useElementStructure` has with
  `ElementToolbar`. It returns `pins(scale, bounds)`, which `Preview` drops into
  the iframe wrapper for a single frame and into the canvas's
  `activeFrameOverlay` for the active frame. That overlay is an unscaled
  screen-pixel layer, so frame coordinates are multiplied by the canvas scale there.
- Pins and cards are drawn host-side in React with house primitives; the injected
  script only *reports* geometry (`locations.at`), validated by `isCommentPlacement`
  before use. Comments bind to `editorFrameRef` — the frame the user is actually in.
- The layer does not own its open state. Team → Comments being open *is* the
  mode: `useTeamWorkspace` reports `commentsActive`, and `useWorkspaceComments`
  brings the preview forward when it turns on. Opening comments closes the visual
  editor — the two are mutually exclusive preview surfaces.
- `useCanvasComments` is an adapter over `teamStore`, not a store of its own. It
  maps threads into the `CanvasComment` shape the pins and composer already
  speak, so the storage moved without the preview surfaces changing.
- `CommentPins` and `CommentComposer` use the existing button, empty-state,
  checkbox and dockable-panel primitives.
- `useCommentBridge` checks the message source against the actual preview frame.
  It only forwards validated target data and never sends a prompt on a frame event.
- `commentAgents` resolves the selected project/tab at handoff time.
  `Terminal.pastePrompt` rejects absent/exited PTYs and terminals without bracketed
  paste support, blocks known setup/permission screens and busy agents, strips terminal
  control characters, and awaits the backend write.
- Primary entry points are registered in Cmd+K, scoped to a project so they open
  the workspace panel rather than the home screen.
- Placing a comment needs a live web preview. Reading, replying and resolving
  work anywhere, including a folder that is not a git repository.

## Validation

Run the usual repository gates:

```sh
pnpm check:all
pnpm test:run
pnpm rust:test
```

Focused tests cover prompt structure, branch/project isolation, corrupt storage,
frame message validation, stale targets, saving without sending,
selected-only batch sending, and failed handoffs. Manually verify a desktop and
mobile preview, reload persistence, editing, deletion, and a real agent terminal
before submitting a pull request.

## Viewport context

A note carries the viewport it was written at, and that replaces asking the user to
pick screen sizes. The prompt reports it as **Seen at: 1440 × 900** and tells the agent
it is context for what the user was looking at, not a restriction: make the change
correct at that size using the project's own breakpoints, don't invent pixel ranges,
don't break the other sizes, and narrow to one breakpoint only when the request is
plainly about that size.

Notes saved before this still carry their `scope` field and still load; it is kept for
compatibility and no longer read.
