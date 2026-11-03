# Flexible panels

Every panel in the workspace can be dragged anywhere, and where you put them is
remembered per project.

The workspace has six surfaces: **Preview**, **Agent**, **Team**, **Variables**,
**Edit** (the visual/CSS editor) and **Navigator** (the element tree). Before
this, five of them had a *fixed* place — an order somebody chose once, written
into a CSS grid — and the only thing you could change was whether a panel was
docked or floating. Two people who work differently could not both be right.

Now the workspace is one **rail** made of columns: an ordered row of docked
columns with the preview somewhere in it. Each non-preview column can contain
one or more panels stacked vertically. You drag a panel's header to move it —
before or after another panel to stack it, onto a column gap to create a new
column, or out of the rail entirely to float it over the work. Drag a floating
panel back onto the rail and it docks where the indicator says. The arrangement
is saved for the project you did it in, and you can save any arrangement as the
default every *other* project starts from.

The Panel Layout menu is a small spatial editor for the same arrangement. It
shows columns on either side of a locked Preview column, the panels stacked in
each column, and a Floating tray. Every drag action has a named control too:
move up/down in a stack, stack with the column to the left/right, move to a new
column on either side, and float or dock. The previous flat menu is retained as
`WorkspaceLayoutMenuLegacy` and can be selected by setting
`shipstudio.layoutMenuImplementation` to `legacy` in localStorage while testing
the new editor.

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

So the work was not to add dragging. It was to give the workspace a nested
layout model it did not have, and then let a drag write to it.

## The model

```ts
interface PanelPlacement {
  panel: PanelId;
  /** Relative vertical share of this panel inside its column. */
  weight: number;
}

type WorkspaceColumn =
  | { kind: 'preview' }
  | { kind: 'panels'; width?: number; panels: PanelPlacement[] };

interface WorkspaceLayout {
  /** Columns from left to right. Preview appears exactly once. */
  columns: WorkspaceColumn[];
  /** Panels shown as movable windows instead of in the rail. */
  floating: PanelId[];
}
```

The model is an ordered list of columns, not a left list and a right list.
Preview is a locked member of that list, so “which side is this panel on” is a
comparison with one structural boundary. A non-preview column owns its width;
its panel placements own relative vertical weights. A 30/70 stack therefore
survives window resizing without storing fragile pixel heights. A drag is a
splice within a column or between columns.

When a v1 preference is read, each visible panel becomes a singleton column,
preserving its old order, floating state and saved width. Existing localStorage
keys stay unchanged; `normalizeLayout` accepts both shapes and writes the new
shape after the first change.

A floating panel **keeps its placement**. That is what makes floating
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

Flexible panels use the same seam. `WorkspaceDock` renders one slot per visible
panel inside each column;
`DockablePanel` takes a `dockSlotId` and portals its *placeholder* into the
matching slot. So moving a panel moves an empty measured div, and:

- **No content is ever reparented.** The agent terminal, the preview iframe and
  the editor keep their position in the DOM for the life of the workspace. An
  iframe reloads when it is moved in the DOM; this never moves one.
- The rail's children are rendered in a **fixed** DOM order and positioned with
  the flex `order` property. Reordering is a style change, not a tree change. A
  stack changes slot weights, not the panel surface's DOM position.

`WorkspaceDock` therefore has no knowledge of what any panel contains, and a
panel has no knowledge of where it is.

## Dragging

One rule: **dragging a header does what the panel's current state implies.**

- Docked → a *layout* drag. The live panel surface lifts and follows the cursor
  while a full-height vertical indicator means “new column” and a horizontal
  indicator inside a column means “stack above/below”. Release splices the
  panel there. Drag away from the rail and release to float it exactly where it
  was released.
- Floating → the window moves (`DockablePanel`'s existing behaviour). Drag it
  over the rail and the indicator appears; release docks it there.

The drop target is computed from the slot and column rects and the pointer — a
pure function, unit-tested, so the interaction can be reasoned about without a
browser. Keyboard equivalents (`Move panel up` / `down`, `Move to new column`,
`Stack with`, `Float` / `Dock`) exist for everything the pointer can do; a drag
is never the only way.

## Persistence

Per project, in `localStorage`, alongside every other panel preference the
workspace already keeps there (floating positions, floating sizes, split
ratios, per-project Team open state):

| Key | Holds |
| --- | --- |
| `shipstudio.layout.default` | The layout new projects start from |
| `shipstudio.layout.project:<path>` | This project's arrangement, written only once you change something here |
| `shipstudio.layout.scope` | `project` (default) or `global`, selected in the Panel Layout menu |

Not `.shipstudio/project.json`. That file is inside the repository and is meant
for things the *project* has — its hosting link. A pane width is something a
person has, and committing one would push your arrangement onto everyone who
clones the repo.

A project with no entry uses the default, live: change your default and every
project you have not personally arranged follows it. **Reset layout** deletes
the project's entry rather than writing the default into it, so it goes back to
following.

The Panel Layout menu's **Layout applies to** selector chooses how edits are
persisted. **This project** keeps the behaviour above: a project override is
created on the first edit and projects without one follow the shared default.
**All projects** makes every project read and write `shipstudio.layout.default`,
so switching projects keeps the same visible arrangement. Switching to All
projects first promotes the currently visible arrangement to the shared default;
switching back to This project copies that arrangement into the current
project's override. Existing overrides remain stored while global scope is
active, but are ignored until project scope is selected again. Save as default
and Reset this project are only shown in project scope.

Legacy preferences (`agentPanelPinned`, `elementTreePinned`,
`variablesPanelPinned`, `visualEditorPinned`, `teamPanelPinned`, and the four
docked-width keys) are read once to build the first default, so an existing
install opens on the arrangement it already had.

## Topbar Focus mode

The topbar's **Focus** mode is a temporary workspace projection: Agent stays on
the left, the currently selected Preview or Code surface stays on the right,
and the two panes start evenly split. Focus remembers an adjusted split in the
per-project `shipstudio.focus.split:<path>` localStorage preference; it is a
ratio separate from the workspace layout and is only written by an explicit
pointer or keyboard resize. The measured rail width drives the split as the
window or sidebar changes. Focus keeps each pane at least 260px wide when the
rail permits it, reducing both minima evenly below 520px; a viewport clamp
never replaces the saved ratio. Its bounds do not depend on other panels in
Agent's saved stack or the normal 900px docked-column limit.

Other workspace panel surfaces are hidden while Focus is active. Their docked
or floating placement and their open state are preserved, so leaving Focus
restores the arrangement the user had before entering it.

This is separate from the Panel Layout menu's **Focus** preset below. That
preset still writes an ordinary, editable layout.

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
