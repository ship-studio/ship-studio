# Flexible panels

Every panel in the workspace can be dragged anywhere, and where you put them is
remembered per project.

The workspace has six surfaces: **Preview**, **Agent**, **Team**, **Variables**,
**Edit** (the visual/CSS editor) and **Navigator** (the element tree). Before
this, five of them had a *fixed* place — an order somebody chose once, written
into a CSS grid — and the only thing you could change was whether a panel was
docked or floating. Two people who work differently could not both be right.

Now the workspace is one **rail**: an ordered row of docked panels with the
preview somewhere in it. You drag a panel's header to move it — before or after
the preview, to either end, or out of the rail entirely to float it over the
work. Drag a floating panel back onto the rail and it docks where the indicator
says. The arrangement is saved for the project you did it in, and you can save
any arrangement as the default every *other* project starts from.

## Why it wasn't just a reorder

The six panels lived at two nesting levels with two different layout mechanisms:

- `.workspace-content` was a flex row holding Team's dock slot and a two-pane
  `SplitPane` (Agent | preview pane).
- `.preview-container` was a CSS grid whose columns were Variables, Navigator,
  canvas, Edit — in that order, spelled out as a **combinatorial** set of
  classes. Three optional panels needed eight `grid-template-columns` rules and
  seven `.preview-toolbar { grid-column }` rules, and every one of them named
  the panels in a fixed sequence. There was no representation of "order" to
  change; the order *was* the stylesheet.

So the work was not to add dragging. It was to give the workspace a layout
model it did not have, and then let a drag write to it.

## The model

```ts
interface WorkspaceLayout {
  /** The rail, left to right. Contains 'preview' exactly once. */
  order: RailItem[];        // ('agent'|'navigator'|'variables'|'editor'|'team'|'preview')[]
  /** Panels shown as a movable window instead of in the rail. */
  floating: PanelId[];
  /** Docked width in px, per panel. */
  widths: Partial<Record<PanelId, number>>;
}
```

One ordered array, not a left list and a right list. `preview` is a member of
it, so "which side is this panel on" is a comparison of two indices rather than
a second piece of state that can disagree with the first. A drag is a splice.

A floating panel **keeps its place in `order`**. That is what makes floating
reversible: re-dock it and it returns to the slot it left, instead of landing
at an end and making you drag it back.

Layout says *where a panel goes when it is shown*. It deliberately does not say
whether it is shown — visibility already belongs to each feature (`variables.open`,
`elementTreeVisible`, Team's per-project open flag, `isAgentPanelHidden`) and
moving it here would have meant re-plumbing five features to land the same
behaviour. Hiding a panel does not lose its place either.

Every read goes through `normalizeLayout`, which is total: it repairs a missing
or duplicated `preview`, drops ids it doesn't know, appends panels added by a
later version at their default position, and clamps widths. A layout from a
future build, a half-written one, or hand-edited nonsense all resolve to
something renderable — this is a preference, so no failure of it may cost you
the workspace.

## How a panel gets where it is

`DockablePanel` already rendered a **placeholder** in the layout and portaled
the real **surface** to `<body>`, positioned over the placeholder's measured
rect. That is what let a panel switch between docked and floating without
remounting an xterm terminal.

Flexible panels use the same seam. `WorkspaceDock` renders one slot per panel;
`DockablePanel` takes a `dockSlotId` and portals its *placeholder* into the
matching slot. So moving a panel moves an empty measured div, and:

- **No content is ever reparented.** The agent terminal, the preview iframe and
  the editor keep their position in the DOM for the life of the workspace. An
  iframe reloads when it is moved in the DOM; this never moves one.
- The rail's children are rendered in a **fixed** DOM order and positioned with
  the flex `order` property. Reordering is a style change, not a tree change.

`WorkspaceDock` therefore has no knowledge of what any panel contains, and a
panel has no knowledge of where it is.

## Dragging

One rule: **dragging a header does what the panel's current state implies.**

- Docked → a *layout* drag. Drop indicators appear between rail slots; release
  splices the panel there. Drag away from the rail and release to float it.
- Floating → the window moves (`DockablePanel`'s existing behaviour). Drag it
  over the rail and the indicator appears; release docks it there.

The drop index is computed by `dropIndexAt` from the slot rects and the pointer
— a pure function, unit-tested, so the interaction can be reasoned about
without a browser. Keyboard equivalents (`Move panel left` / `right` / `Float` /
`Dock`) exist for everything the pointer can do; a drag is never the only way.

## Persistence

Per project, in `localStorage`, alongside every other panel preference the
workspace already keeps there (floating positions, floating sizes, split
ratios, per-project Team open state):

| Key | Holds |
| --- | --- |
| `shipstudio.layout.default` | The layout new projects start from |
| `shipstudio.layout.project:<path>` | This project's arrangement, written only once you change something here |

Not `.shipstudio/project.json`. That file is inside the repository and is meant
for things the *project* has — its hosting link. A pane width is something a
person has, and committing one would push your arrangement onto everyone who
clones the repo.

A project with no entry uses the default, live: change your default and every
project you have not personally arranged follows it. **Reset layout** deletes
the project's entry rather than writing the default into it, so it goes back to
following.

Legacy preferences (`agentPanelPinned`, `elementTreePinned`,
`variablesPanelPinned`, `visualEditorPinned`, `teamPanelPinned`, and the four
docked-width keys) are read once to build the first default, so an existing
install opens on the arrangement it already had.

## Presets

`Default`, `Focus`, `Design` and `Review` are starting points, not modes —
applying one writes an ordinary layout you can then drag. Plus **Save as
default**, which makes the current project's arrangement the one every
unarranged project uses.

## Fullscreen

The preview's fullscreen used to be `.preview-container { position: fixed }`,
which worked because the docked panels were inside that container. They are not
any more, so the **rail** goes fullscreen instead — the preview fills it and
the panels stay beside it, which is the same result and the more useful one.
