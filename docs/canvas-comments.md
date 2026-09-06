# Canvas comments

Use the **Comments** speech-bubble icon beside the preview's Edit control to collect feedback. Click an
actual page element, write the note, choose its
screen sizes (one or more), and choose **Save comment**. Adding a comment never calls an
agent or writes to website source. Hovering outlines the target in Ship Studio green
and dims the surrounding canvas. The target stays clear while writing the note.

The compact floating panel can be moved or closed without changing the
preview viewport. While composing, the backlog and send controls are hidden. Click
another element to retarget without losing draft text; Escape clears the canvas
highlight, and the next click selects a fresh target. Notes are grouped by route without numbered canvas pins or visible counts. All pending notes
start selected; uncheck notes to hold them for later. Review the generated prompt
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

The prompt preserves the user's exact text in a `userRequest` field and separates
`applyTo` from `capturedViewport`. Each note retains a UUID for agent reference. Captured
DOM text is explicitly labelled untrusted reference data. The agent must verify
the project, branch, and target, flag ambiguities/conflicts, test the changes, and
report results by comment ID. Source hints/selectors are not treated as proof.

Pins are drawn inside the preview so they track scrolling and zoom. A selector
must match a unique element with the same tag and captured text; otherwise the
note is marked “Element not found” and can be reattached manually. This deliberately
favors a visible missing target over quietly pointing to a different element.

## Implementation boundaries

- `CanvasComments` owns review and handoff; `CommentsPanel` and `CommentComposer`
  use the existing button, segmented-control, and dockable-panel primitives.
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
frame message validation, parent selection, stale targets, saving without sending,
selected-only batch sending, and failed handoffs. Manually verify a desktop and
mobile preview, reload persistence, edit/reattach, sent/resolved filters, and a
real agent terminal before submitting a pull request.

## Screen sizes

Use All sizes for a universal change, or select any combination of Desktop, Tablet,
and Mobile. The compact buttons support multiple selections; at least one scope
remains selected. Existing single-size comments remain readable. The backlog
shows combined sizes, and the agent receives an explicit `applyTo` array with
instructions to use the project’s own breakpoints and preserve unselected sizes.
