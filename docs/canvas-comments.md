# Canvas comments

Use the **Comments** speech-bubble toggle in the workspace header's tool row — beside Agent,
Elements and Variables — to collect feedback. It badges the number of pending notes, and
opening it brings the preview forward and starts the dev server the way Variables does. Click an
actual page element, write the note, and choose **Save comment**. Adding a comment never calls an
agent or writes to website source. Hovering outlines the target in Ship Studio green
and dims the surrounding canvas. The target stays clear while writing the note.

The compact floating panel can be moved or closed without changing the
preview viewport. While composing, the backlog and send controls are hidden. Click
another element to retarget without losing draft text; Escape clears the canvas
highlight, and the next click selects a fresh target. **A note lives on the thing it is about, not in a list.** Each saved comment is a
numbered pin on its element; clicking the pin opens the note itself beside it — body,
scope, sent state, Edit and Delete — and hovering one outlines its element without
moving the page. The composer opens at the element too. Pins are placed from a live
rect on every scroll, resize and DOM change, so they follow their element instead of
drifting; a card flips to the other side of its pin rather than overflowing the frame.
A sent note's pin is outlined rather than filled.

What remains in the floating panel is only what is about the *batch* rather than any one
note: how many are selected, how much context to send, which terminal to send to, the
handoff, and a jump list for reaching a pin that is off-screen or on another route. All pending notes start selected; uncheck notes to hold them for later. Review the generated prompt
and choose the destination terminal before sending. Sending pastes one bracketed
batch into that terminal. It does not press Enter. The user starts the request in
the terminal and reviews its results before deleting comments with the trash icon.

## State and storage

- One list shows saved comments, with Edit and Delete actions. Sent comments
  show their destination; sent means the terminal accepted the paste.
- Edit changes the text, screen sizes, or target by clicking another element.
  Saving edits makes a sent comment ready to send again without a separate action.
- The trash icon removes the note from local storage. Legacy resolved notes remain
  accessible in the list and can be edited or deleted. There are no status tabs.
- Notes persist in the app webview's local storage, keyed by the full project
  path and actual working branch. They are local to this installation and are
  not committed, synced, or shared with other users.
- Each note uses a separate storage key. Storage failures surface an error and
  preserve existing data. A failed terminal handoff leaves the batch pending.
- Unsaved composer text survives closing the panel, but not leaving the project
  or branch or restarting the app. Saved backlog notes survive restarts.

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
Ship Studio pastes this into a live agent terminal rather than the clipboard, so the
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
  `ElementToolbar`. It returns `bar` (the batch panel) and `pins(scale, bounds)`,
  which `Preview` drops into the iframe wrapper for a single frame and into the
  canvas's `activeFrameOverlay` for the active frame. That overlay is an unscaled
  screen-pixel layer, so frame coordinates are multiplied by the canvas scale there.
- Pins and cards are drawn host-side in React with house primitives; the injected
  script only *reports* geometry (`locations.at`), validated by `isCommentPlacement`
  before use. Comments bind to `editorFrameRef` — the frame the user is actually in.
- The layer does not own its open state: the toggle lives in `WorkspaceHeader` and
  `WorkspaceView` holds the flag, so the header can badge the pending count (reported
  up via `onPendingCountChange`). Opening comments closes the visual editor — the two
  are mutually exclusive preview surfaces.
- `CommentsPanel`, `CommentPins` and `CommentComposer` use the existing button,
  empty-state, segmented-control, and dockable-panel primitives.
- `useCommentBridge` checks the message source against the actual preview frame.
  It only forwards validated target data and never sends a prompt on a frame event.
- `commentAgents` resolves the selected project/tab at handoff time.
  `Terminal.pastePrompt` rejects absent/exited PTYs and terminals without bracketed
  paste support, blocks known setup/permission screens and busy agents, strips terminal
  control characters, and awaits the backend write.
- Primary entry points are also registered in Cmd+K.
- Web previews only. Remote collaboration and automatic resolution are out of scope.

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
