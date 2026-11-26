# Ship Studio drag-sort contract

This document freezes the observable contract for Ship Studio's owned drag-sort
interaction. It is the source of truth for every sortable feature. The engine
owns transient gesture state, projection, collision, cancellation, focus, and
announcements; the feature owns validation, persistence, and source mutation.

## Clean-room boundary

The implementation is original and dependency-free. Behavioural observation of
public examples is permitted, but do not inspect or copy source code, an npm
bundle, or a source map. No third-party drag-and-drop package is redistributed
or added to this project.

## Behavioural contract

### Lifecycle and activation

1. Pointer Events and pointer capture are used. Native HTML5 `draggable` and
   `DragEvent` APIs are not used.
2. Mouse and trackpad presses activate after 4 CSS pixels of movement. A
   press/release below that threshold remains an ordinary click.
3. Touch presses require a 250ms hold with no more than 5 CSS pixels of
   movement. Scrolling before activation cancels the candidate.
4. Pen and other pointers require a 200ms hold with a 5 CSS pixel tolerance.
5. Interactive descendants (`button`, links, inputs, textareas, selects,
   contenteditable, tabs, and interactive ARIA roles) are ignored unless the
   exact element is the registered drag handle.
6. A scope has one active operation. A second pointer cannot steal it.
7. Escape, pointer cancellation, lost pointer capture, item or scope unmount,
   and window blur cancel and restore the pre-drag order.
8. Releasing over no valid target cancels a pure sortable-list move. A feature
   adapter may give an outside release another explicit meaning.

### Visual feedback

1. Handle activation keeps a same-size placeholder at the source and renders a
   body-portaled overlay aligned to the grabbed point. Item activation can opt
   out of the overlay so the source row remains the visible in-flow drag
   surface.
2. The overlay does not intercept pointer events, uses the drag-overlay z-index
   token, measured source dimensions, an opaque Ship Studio surface, and a
   restrained elevation shadow.
3. Crossing an eligible item's midpoint projects order immediately. Items move
   with a short, interruptible reorder transition; an overlay, when configured,
   follows the pointer without a drag-phase transition. The DOM is not
   optimistically reparented and feature state is not committed during pointer
   movement.
4. Ordinary lists use directional midpoint/closest-centre collision. Precise
   nested targets use pointer containment and explicit numeric priority when
   targets overlap.
5. A valid release settles the overlay to its projected rectangle for 250ms
   using `cubic-bezier(0.25, 1, 0.5, 1)`, then clears transient styles and calls
   the feature commit exactly once. Cancellation settles back to the source.
6. Reduced-motion users skip reorder and settle animation while retaining
   target placement state and announcements. Ordinary sortable lists do not
   render insertion lines; future tree/drop-zone adapters must opt in via the
   explicit target-indicator API.
7. Near a scrollable ancestor's edge, the innermost eligible ancestor scrolls
   on animation frames at a capped speed and is remeasured after each scroll.
   The document is never scrolled when the relevant list can scroll.
8. Cursors are `grab` when available and `grabbing` while active. Text
   selection is disabled only while active and the exact previous inline value
   is restored during cleanup.

### Keyboard and accessibility

1. Each sortable item has a focusable activation surface. Handle-activated items
   use a focusable handle; item-activated items use the row itself. Space or
   Enter lifts it; arrows move the projected target along the list axis; Home
   and End choose the first and last valid position; Space or Enter drops;
   Escape cancels.
   A feature may reserve Enter for an activation surface's normal button
   action; Space remains available to lift and drop the item.
2. Tree items additionally use Left and Right for before/inside/after where
   valid. Invalid positions are skipped rather than announced as successful.
3. Focus remains on the activation surface throughout and is restored after
   commit or cancellation.
4. Handles expose a label such as `Move Variables panel` and describe the
   scope instructions.
5. A polite live region announces lift, every projected position, invalid
   targets, drop, cancellation, and persistence failure. It uses feature labels,
   one-based positions, group labels, and totals, never raw IDs.
6. Pointer and keyboard operations use the same projection, validation,
   commit, and rollback functions.

### State and failure semantics

1. IDs are stable and unique within a scope. Array indexes are never IDs.
2. The engine owns transient interaction state only. Feature state remains the
   source of truth and adapters own persistence/source mutation.
3. Feature adapters may keep their projected state visible while an async
   commit is pending. A failure restores the last confirmed order and surfaces
   a human-readable persistence failure.
4. A pending commit locks the scope. Speculative mutations are not queued
   against stale positions.
5. External changes replace confirmed items only while idle; during a drag they
   are deferred until commit or cancellation.

## Manual observation matrix

The matrix records the black-box qualities to preserve. “No announcement” is
intentional where the gesture remains a click or is cancelled before lift.

| Case | Initial state | Gesture | Projected state | Release/cancel result | Focus | Announcement |
| --- | --- | --- | --- | --- | --- | --- |
| Mouse | Three vertical rows, handle or row activation | Press the activation surface and move past 4px across row midpoint | Active row remains a placeholder when an overlay is configured; otherwise rows translate in flow to projected gaps | Release commits one move; under 4px is a click | Activation surface stays focused for keyboard, pointer focus is not stolen | Lift, projected position, drop |
| Touch emulation | Three rows in a scrollable list | Hold 250ms within 5px, then move; move/scroll early | Overlay follows touch and list may auto-scroll | Release commits; early scroll cancels candidate | Touch does not move focus unexpectedly | Lift and drop, or no announcement on early cancel |
| Keyboard | Focused handle in a vertical group | Space, arrows/Home/End, Space | Projected order updates without pointer events | Drop commits exactly once; Escape restores order | Handle remains focused throughout and after settle | Lift, each position, drop/cancel |
| Reduced motion | Same list with reduced-motion preference | Pointer or keyboard reorder | Target and projected state remain visible without settle animation | State commits immediately | Focus restoration is unchanged | Same semantic announcements |
| Scrolling | Variable-height rows near an inner scroll edge | Drag toward edge while pointer remains in list | Innermost list scrolls and geometry remeasures | Release uses the post-scroll target | Overlay remains aligned to grabbed point | Position updates reflect visible labels |
| Cancellation | Active drag with a confirmed order | Escape, blur, pointercancel, lost capture, or unmount | Projection disappears and original order returns | No feature commit; transient styles clean up | Original activation surface is restored when mounted | Cancelled |
| Invalid targets | Disabled/hidden row or validator-refused destination | Drag/keyboard toward invalid destination | Any stale projection clears and the target shows its invalid state | Invalid release cancels | Handle remains available | Why the target is invalid |
| Variable-height items | Rows have different measured heights | Cross each midpoint in both directions | Gap changes at each actual midpoint, not a fixed row height | Final projected order commits | Handle remains usable | One-based final position |
| Horizontal list | Items laid out left-to-right | Drag across horizontal midpoints or use left/right | Projection follows horizontal axis | Valid release commits | Handle stays focused for keyboard | Axis-neutral positions |
| Grouped list | Two labelled groups, one empty | Move within and across groups where allowed | Source removal and destination insertion compensate indexes | Commit contains source/destination group and index | Focus stays on source handle | Group labels, positions, totals |
| Nested tree targets | Flat sibling rows represent before/inside/after tree zones | Drag into a valid container or beside a sibling | Row order and indentation project the resulting hierarchy immediately | Valid placement commits; descendant/void/root targets cancel | Activation surface remains focused | Placement and target label, or refusal reason |

## Exact targets versus Ship Studio styling

These are exact behavioural targets: activation thresholds and hold times,
target switching at measured midpoints/zones, projection timing, the shared
pointer/keyboard lifecycle, cancellation and rollback, one commit per drop,
focus restoration, polite announcements, and the 250ms settle duration with
the stated easing.

These are rendered with Ship Studio styling: surface colour, border, typography,
iconography, overlay opacity, lift shadow, optional target-indicator colour,
spacing, and stacking. They consume the design-token layers and may evolve with
the rest of the product without changing the interaction contract.

### Feature integration rule

Any feature selector that styles the same element as `.drag-sort__item` must
compose its transition list with the primitive's `transform` transition. A
later `transition: background-color ...` shorthand silently removes the
sortable motion and makes projected rows snap. The Panel Layout adapter uses a
same-element composed declaration and excludes its body-portaled overlay row.
