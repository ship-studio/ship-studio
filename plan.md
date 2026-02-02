# Ship Studio Compact Mode - Feature Plan

## Overview

Compact Mode is a minimal, floating interface for Ship Studio that allows users to interact with Claude Code without taking up significant screen real estate. It's designed for laptop users and those who want Ship Studio visible while working in other applications.

## User Problems Being Solved

1. **Screen real estate** - Current full-screen layout is too large for laptop users
2. **Multi-tasking** - Users want Ship Studio visible while working in their IDE or browser
3. **Quick interactions** - Users want to send quick commands without context-switching to a full window
4. **Preview alongside other apps** - Users want to see their site preview in a regular browser window they can position freely

---

## Feature Specification

### Core Concept

A compact two-row floating interface (~400×90px collapsed) that:
- Auto-expands to show Claude's output (max 300px total height)
- Auto-collapses back to minimal size after responses complete
- Can stay on top of other windows (optional toggle)
- Can be freely dragged anywhere on screen
- Provides quick access to key Ship Studio actions

### Visual Design

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ROW 1: INPUT                                                               │
│  ┌──────────────────────────────────────────────────┐                      │
│  │  Ask Claude...                              [➤]  │   [📌] [⬜] [×]      │
│  └──────────────────────────────────────────────────┘   pin  expand close  │
├────────────────────────────────────────────────────────────────────────────┤
│ ROW 2: ACTIONS                                                             │
│  [●] [↻]  [📁]  [🔑]  [➕]  │  main ▾  │  PR: Open  │  [▲ Publish]        │
│  health restart assets .env repo   branch    status      publish          │
└────────────────────────────────────────────────────────────────────────────┘
```

**Collapsed State (~400×90px) - Two Rows**

*Row 1 - Input Row:*
- Full-width text input field with placeholder "Ask Claude..."
- Send button
- Pin/unpin button (always on top toggle)
- Expand to full mode button
- Close (×) button

*Row 2 - Actions Row (all icon-only buttons):*
- Health status indicator (colored dot)
- Restart server button
- Assets button
- .env button
- Create Repo button
- Branch indicator + dropdown
- PR status indicator
- Publish dropdown button

**Expanded State (~400×300px max)**
- Both rows remain visible at top
- Scrollable terminal output area below
- Auto-scrolls to latest output
- Smooth animation between states

**Style**
- Solid dark background with slight transparency (~90% opacity)
- Rounded corners (12px radius)
- Subtle border for definition
- Matches Ship Studio's existing dark theme

---

## Behavior Specification

### Entering Compact Mode

1. User clicks "Compact Mode" button (located near "Open in Browser" / "Hide Preview" in toolbar)
2. Ship Studio opens a new browser window with the current localhost URL (e.g., `http://localhost:3000`)
3. Main window transforms/animates to compact size (400×60)
4. Window becomes borderless/frameless
5. Position defaults to last saved position, or bottom-center of screen if first time

### While in Compact Mode

**Input Handling**
- User types in input field
- Press Enter or click send to submit
- Input is sent to Claude Code (same as terminal)

**Output Display**
- When Claude starts responding, window auto-expands (animated)
- Terminal output streams in the expanded area
- When response completes, wait 3-5 seconds, then auto-collapse
- User can manually pin expanded state to prevent auto-collapse

**Always on Top**
- Toggle via pin button in the UI
- When pinned: window stays above all other windows
- When unpinned: window behaves normally (can go behind other windows)
- Pin state persists between sessions

**Dragging**
- Window can be freely dragged by clicking anywhere on the header bar
- No snap-to-edge behavior (free positioning)
- Position is saved and restored between sessions

### Exiting Compact Mode

**Via Expand Button**
- Click expand button to return to full Ship Studio window
- Browser window remains open (user can close manually if desired)

**Via Close Button**
- Shows dialog: "Return to full mode or quit Ship Studio?"
- Options: "Full Mode" / "Quit" / "Cancel"

### Server Controls in Compact Mode

- Health indicator dot (green/yellow/red) always visible
- Clicking health dot shows quick status popup
- Restart server button visible and functional
- Server output appears in expanded terminal area

---

## Technical Implementation

### Tauri Window Configuration

**New Window Properties for Compact Mode**
```rust
// When entering compact mode
window.set_decorations(false)?;  // Remove title bar
window.set_size(LogicalSize::new(400.0, 90.0))?;  // Two-row collapsed height
window.set_min_size(Some(LogicalSize::new(400.0, 90.0)))?;
window.set_max_size(Some(LogicalSize::new(400.0, 300.0)))?;  // For expanded
window.set_always_on_top(pinned)?;
window.set_resizable(false)?;
```

**Position Persistence**
- Save position to `.shipstudio/preferences.json` or similar
- Restore on entering compact mode

### New Tauri Commands Needed

```rust
// src-tauri/src/commands/window.rs (new file)

#[tauri::command]
pub fn enter_compact_mode(window: Window) -> Result<(), String>

#[tauri::command]
pub fn exit_compact_mode(window: Window) -> Result<(), String>

#[tauri::command]
pub fn set_always_on_top(window: Window, enabled: bool) -> Result<(), String>

#[tauri::command]
pub fn save_compact_position(x: i32, y: i32) -> Result<(), String>

#[tauri::command]
pub fn get_compact_position() -> Result<Option<(i32, i32)>, String>

#[tauri::command]
pub fn set_compact_expanded(window: Window, expanded: bool) -> Result<(), String>
```

### Frontend Components

**New Components**
```
src/components/
├── CompactMode/
│   ├── CompactMode.tsx           # Main compact mode container
│   ├── CompactInputRow.tsx       # Row 1: Input field + window controls
│   ├── CompactActionsRow.tsx     # Row 2: Status, restart, assets, .env, repo, branch, PR, publish
│   ├── CompactOutput.tsx         # Scrollable terminal output area
│   ├── CompactWindowControls.tsx # Pin, expand, close buttons
│   └── CompactMode.css           # Styles
```

**State Management**
```typescript
interface CompactModeState {
  isCompact: boolean;
  isExpanded: boolean;  // Is output area visible
  isPinned: boolean;    // Always on top
  position: { x: number; y: number } | null;
}
```

**Action Buttons in Row 2**
The actions row reuses existing components/logic from the full toolbar:
- Health indicator: Reuse from existing `ServerControls`
- Restart: Reuse from existing `ServerControls`
- Assets: Opens Assets modal (same as toolbar)
- .env: Opens environment variable editor (same as toolbar)
- Create Repo: Opens repo creation flow (same as toolbar)
- Branch: Shows current branch, dropdown for switching (from `BranchDropdown`)
- PR Status: Shows PR state indicator (from `BranchItem`)
- Publish: Opens publish dropdown (from `PublishDropdown`)

### Browser Window Opening

When entering compact mode, use Tauri's shell API or browser opener:
```typescript
import { open } from '@tauri-apps/plugin-shell';

// When entering compact mode
const localhostUrl = `http://localhost:${serverPort}`;
await open(localhostUrl);
```

### Terminal Integration

The compact mode terminal output needs to share state with the existing terminal:
- Option A: Render a minimal xterm.js instance in compact mode
- Option B: Create a text-only output view that receives the same PTY output
- Option B is simpler and fits the minimal aesthetic better

---

## UI/UX Details

### Animations

**Collapse/Expand**
- Duration: 200ms
- Easing: ease-out
- Height animates from 90px ↔ 300px

**Mode Transition**
- Full → Compact: Window shrinks with fade transition
- Compact → Full: Window expands with fade transition
- Duration: 300ms

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send input to Claude |
| `Escape` | Collapse output (if expanded) |
| `Cmd+Enter` | Send and stay expanded |

### Accessibility

- All buttons have aria-labels
- Input field has proper focus handling
- High contrast for status indicators

---

## Implementation Phases

### Phase 1: Core Window Mechanics ✅
- [x] Create window.rs commands for compact mode window manipulation
- [x] Implement enter/exit compact mode with size changes
- [x] Add always-on-top toggle functionality
- [x] Position save/restore logic

### Phase 2: Compact Mode UI ✅
- [x] Create CompactMode component structure
- [x] Build CompactInputRow with styling
- [x] Build CompactActionsRow with action buttons
- [x] Build CompactOutput for terminal display
- [x] Add "Compact Mode" button to full mode toolbar
- [x] Wire up compact mode state in App.tsx

### Phase 3: Terminal Integration
- [ ] Connect compact input to existing PTY (basic impl done)
- [x] Create CompactOutput component for terminal display
- [x] Implement auto-expand on output
- [x] Implement auto-collapse after delay

### Phase 4: Browser Integration ✅
- [x] Open browser window when entering compact mode
- [x] Handle server URL detection
- [ ] Graceful handling if server not running

### Phase 5: Polish & Persistence
- [ ] Add animations for transitions
- [ ] Implement position persistence
- [ ] Add close confirmation dialog
- [ ] Test edge cases and error handling

### Phase 6: Testing & Refinement
- [ ] Test on various screen sizes
- [ ] Test multi-monitor scenarios
- [ ] Test with different projects
- [ ] User feedback and iteration

---

## Open Questions

1. **Multiple projects** - If user has multiple Ship Studio windows, should each have its own compact mode?
2. **Notifications** - Should compact mode show notifications for errors/completions when collapsed?
3. **Drag handle** - Should there be a visible drag handle or is the entire header bar draggable?
4. **Width flexibility** - Should users be able to resize the compact window width, or keep it fixed at 400px?
5. **Modal handling** - How should modals (Assets, .env editor) display when triggered from compact mode?

---

## Success Metrics

- Users can comfortably use Ship Studio on a 13" laptop
- Compact mode doesn't interfere with other applications
- Transition between modes feels smooth and intuitive
- Users adopt compact mode for their regular workflow

---

## References

- Raycast command bar (similar minimal input pattern)
- macOS Spotlight (always-on-top minimal window)
- Linear's command palette (expandable interface)
- User-provided screenshots of AI compact modes
