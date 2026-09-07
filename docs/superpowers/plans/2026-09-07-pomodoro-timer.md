# Pomodoro Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, manually advanced Pomodoro timer to the Ship Studio workspace toolbar with focus, short-break, long-break, completion notification, and settings flows.

**Architecture:** Keep the countdown state machine and persistence in a focused `usePomodoroTimer` hook, with pure reducer/time helpers exported for deterministic tests. Render a self-contained toolbar trigger and anchored popover from `PomodoroTimer`, then mount it in `WorkspaceHeader`; derive running time from an absolute target timestamp so background throttling and sleep do not cause drift.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, browser `localStorage`/Notification APIs, existing Ship Studio button/icon/sound utilities, CSS custom properties.

## Global Constraints

- Defaults are exactly 25 minutes focus, 5 minutes short break, 15 minutes long break, and 4 focus sessions before a long break.
- No focus or break interval starts automatically.
- A completed interval remains actionable until the user explicitly starts the next phase.
- Closing the popover never pauses or resets the timer.
- Running and paused timer state survives component remount and application restart.
- The feature reuses the incumbent dark toolbar visual language and remains usable in compact workspace mode.
- No analytics, history, task list, cloud sync, backend service, or full-page timer is added.

---

### Task 1: Deterministic Pomodoro state machine and persistence

**Files:**
- Create: `src/hooks/usePomodoroTimer.ts`
- Test: `src/hooks/usePomodoroTimer.test.ts`

**Interfaces:**
- Produces: `PomodoroPhase`, `PomodoroStatus`, `PomodoroSettings`, `PomodoroState`, `PomodoroAction`, `DEFAULT_POMODORO_SETTINGS`, `createInitialPomodoroState()`, `pomodoroReducer()`, `restorePomodoroState()`, `formatPomodoroTime()`, and `usePomodoroTimer()`.
- `usePomodoroTimer()` returns `{ state, remainingSeconds, start, pause, reset, updateSettings, acknowledgeAttention }`.

- [ ] **Step 1: Write failing reducer tests**

Create `src/hooks/usePomodoroTimer.test.ts` with fake time fixed at `2026-09-07T09:00:00Z`. Cover these exact cases:

```ts
it('completes focus and offers a short break for sessions one through three', () => {
  const running = pomodoroReducer(createInitialPomodoroState(), { type: 'start', now: 1_000 });
  const complete = pomodoroReducer(running, { type: 'tick', now: 1_000 + 25 * 60_000 });
  expect(complete).toMatchObject({ phase: 'focus', status: 'complete', completedFocusCount: 1, needsAttention: true });
  const breakState = pomodoroReducer(complete, { type: 'startNext', now: 2_000_000 });
  expect(breakState).toMatchObject({ phase: 'shortBreak', status: 'running' });
});

it('offers a long break after the fourth completed focus session', () => {
  const state = { ...createInitialPomodoroState(), status: 'complete' as const, completedFocusCount: 4 };
  expect(pomodoroReducer(state, { type: 'startNext', now: 10_000 }).phase).toBe('longBreak');
});

it('returns to focus session one after the long break', () => {
  const state = { ...createInitialPomodoroState(), phase: 'longBreak' as const, status: 'complete' as const, completedFocusCount: 4 };
  expect(pomodoroReducer(state, { type: 'startNext', now: 10_000 })).toMatchObject({ phase: 'focus', status: 'running', completedFocusCount: 0 });
});
```

Also assert pause/resume preserves remaining seconds, reset restores the current phase duration, running settings changes do not alter the current target, idle settings changes update the displayed duration, corrupt persisted JSON falls back to defaults, and restoration of an elapsed target resolves exactly once to `complete`.

- [ ] **Step 2: Verify the state tests fail**

Run: `pnpm vitest run src/hooks/usePomodoroTimer.test.ts`

Expected: FAIL because `usePomodoroTimer.ts` does not exist.

- [ ] **Step 3: Implement the state model and pure reducer**

Create the exact public model:

```ts
export type PomodoroPhase = 'focus' | 'shortBreak' | 'longBreak';
export type PomodoroStatus = 'idle' | 'running' | 'paused' | 'complete';

export interface PomodoroSettings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  sessionsBeforeLongBreak: number;
}

export interface PomodoroState {
  phase: PomodoroPhase;
  status: PomodoroStatus;
  remainingSeconds: number;
  targetTimestamp: number | null;
  completedFocusCount: number;
  settings: PomodoroSettings;
  needsAttention: boolean;
}

export type PomodoroAction =
  | { type: 'start'; now: number }
  | { type: 'pause'; now: number }
  | { type: 'tick'; now: number }
  | { type: 'reset' }
  | { type: 'startNext'; now: number }
  | { type: 'updateSettings'; settings: PomodoroSettings }
  | { type: 'acknowledgeAttention' };
```

Use `ss:pomodoro:v1` as the storage key. Clamp minute inputs to `1..180` and sessions to `1..12`. `tick` only completes `running` state when `now >= targetTimestamp`; completing focus increments `completedFocusCount`, while completing a break does not. `startNext` chooses short or long break after focus and returns to focus after either break.

- [ ] **Step 4: Implement the React hook around the reducer**

Initialize from `restorePomodoroState(localStorage.getItem('ss:pomodoro:v1'), Date.now())`. Persist every reducer state change in an effect. While running, schedule a 250 ms interval that dispatches `tick` with `Date.now()`; calculate the displayed seconds with `Math.max(0, Math.ceil((targetTimestamp - Date.now()) / 1000))` so the display does not drift.

Expose callbacks with these signatures:

```ts
start(): void;
pause(): void;
reset(): void;
startNext(): void;
updateSettings(settings: PomodoroSettings): void;
acknowledgeAttention(): void;
```

- [ ] **Step 5: Run the focused tests and commit**

Run: `pnpm vitest run src/hooks/usePomodoroTimer.test.ts`

Expected: PASS.

```bash
git add src/hooks/usePomodoroTimer.ts src/hooks/usePomodoroTimer.test.ts
git commit -m "feat: add pomodoro timer state"
```

---

### Task 2: Timer icon, completion effects, and toolbar popover

**Files:**
- Modify: `src/components/icons/utility.tsx`
- Create: `src/components/workspace/PomodoroTimer.tsx`
- Test: `src/components/workspace/PomodoroTimer.test.tsx`

**Interfaces:**
- Consumes: `usePomodoroTimer()` and `PomodoroSettings` from Task 1; `Button` from `src/components/primitives/Button.tsx`; `loadNotificationSettings()` and `playSound()` from `src/lib/sounds.ts`; `useClickOutside()` from `src/hooks/useClickOutside.ts`.
- Produces: `TimerIcon({ size, className })` through the existing `../icons` barrel and `PomodoroTimer()` for `WorkspaceHeader`.

- [ ] **Step 1: Add the supplied timer SVG as a reusable icon**

Add `TimerIcon` to `utility.tsx` using the user's paths and incumbent icon behavior:

```tsx
export function TimerIcon({ size = 14, className }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M11.5 6V12.5L16.5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
```

- [ ] **Step 2: Write failing interaction tests**

Mock `usePomodoroTimer` and render `PomodoroTimer`. Verify:

```ts
expect(screen.getByRole('button', { name: 'Open Pomodoro timer' })).toHaveAttribute('aria-expanded', 'false');
await user.click(screen.getByRole('button', { name: 'Open Pomodoro timer' }));
expect(screen.getByRole('dialog', { name: 'Pomodoro timer' })).toBeVisible();
expect(screen.getByText('25:00')).toBeVisible();
expect(screen.getByRole('button', { name: 'Start focus' })).toBeEnabled();
```

Add cases for Pause/Reset while running, `Focus complete` plus `Start break`, `Break complete` plus `Start next session`, settings field labels, settings submission, `Escape`, outside click, and the attention class on the trigger.

- [ ] **Step 3: Verify component tests fail**

Run: `pnpm vitest run src/components/workspace/PomodoroTimer.test.tsx`

Expected: FAIL because `PomodoroTimer.tsx` does not exist.

- [ ] **Step 4: Implement the anchored accessible popover**

Create `PomodoroTimer` with a relatively positioned wrapper and an absolutely positioned popover aligned beneath the trigger. Use `useClickOutside` and an Escape listener. The trigger contract is:

```tsx
<button
  className={`toolbar-icon-btn pomodoro-trigger ${isOpen ? 'is-open' : ''} ${state.needsAttention ? 'needs-attention' : ''}`}
  aria-label="Open Pomodoro timer"
  aria-expanded={isOpen}
  aria-haspopup="dialog"
  title="Pomodoro timer"
>
  <TimerIcon size={12} />
  {state.status === 'running' && <span className="pomodoro-trigger-time">{formatPomodoroTime(remainingSeconds)}</span>}
</button>
```

Render `role="dialog" aria-label="Pomodoro timer"`, a phase eyebrow, countdown, `Session N of M`, and status-specific actions. Call `acknowledgeAttention()` when the popover opens. Keep the timer mounted when the popover closes.

Expose phase/completion copy through a polite `aria-live` region, but keep the per-second countdown outside it so screen readers are not interrupted on every tick. Move focus to the popover heading when it opens and restore focus to the toolbar trigger when Escape closes it.

- [ ] **Step 5: Add settings editing without mutating a running interval**

Use local draft strings for the four labeled number inputs. Validate on `Save settings`, pass clamped numbers to `updateSettings`, and return to the timer view. Include `Cancel` to discard draft edits. Use the exact labels `Focus minutes`, `Short break minutes`, `Long break minutes`, and `Sessions before long break`.

- [ ] **Step 6: Add one-shot completion feedback**

Track the previous status in a ref. When it changes from `running` to `complete`, load the existing notification settings and call `playSound(settings.sound)` only when `settings.enabled`. If `Notification.permission === 'granted'`, create one notification titled `Focus complete` or `Break complete` with body `Ready for a short break`, `Ready for a long break`, or `Ready for the next focus session`. Never request notification permission from this component and never fire effects on restored already-complete state.

- [ ] **Step 7: Run component tests and commit**

Run: `pnpm vitest run src/components/workspace/PomodoroTimer.test.tsx`

Expected: PASS.

```bash
git add src/components/icons/utility.tsx src/components/workspace/PomodoroTimer.tsx src/components/workspace/PomodoroTimer.test.tsx
git commit -m "feat: add pomodoro timer popover"
```

---

### Task 3: Ship Studio styling and workspace integration

**Files:**
- Create: `src/styles/features/pomodoro.css`
- Modify: `src/styles/index.css`
- Modify: `src/components/workspace/WorkspaceHeader.tsx`
- Test: `src/components/workspace/WorkspaceHeader.test.tsx`

**Interfaces:**
- Consumes: `PomodoroTimer()` from Task 2 and existing CSS tokens from `src/styles/global/base.css`.
- Produces: a timer button in the left workspace action cluster immediately before `headerExtras`.

- [ ] **Step 1: Write the failing header integration test**

Render `WorkspaceHeader` with minimal typed stubs and assert its toolbar contains `Open Pomodoro timer` after `Support` and before any supplied `headerExtras` marker. Mock Tauri window APIs and plugin-dependent children at module boundaries so the test validates placement rather than unrelated integrations.

- [ ] **Step 2: Verify the header test fails**

Run: `pnpm vitest run src/components/workspace/WorkspaceHeader.test.tsx`

Expected: FAIL because the timer is not mounted.

- [ ] **Step 3: Mount the timer in the toolbar**

Import `PomodoroTimer` and render it in `.workspace-header-left` after the Support button and before `{headerExtras}`:

```tsx
<PomodoroTimer />
{headerExtras}
```

- [ ] **Step 4: Implement the visual system**

Import `./features/pomodoro.css` from `src/styles/index.css`. Style a 292 px popover with `var(--bg-secondary)`, `var(--border)`, `var(--radius-lg)`, and `var(--shadow-lg)`. Use tabular numerals for the countdown, restrained `var(--accent)` only for progress/primary action, and `var(--warning)` or the closest existing attention token for the completion dot. Ensure:

```css
.pomodoro-popover { width: min(292px, calc(100vw - 24px)); }
.pomodoro-time { font-variant-numeric: tabular-nums; }
.pomodoro-trigger.needs-attention::after { /* 5px status dot */ }
@media (prefers-reduced-motion: reduce) { .pomodoro-trigger.needs-attention::after { animation: none; } }
```

Use 8 px spacing increments, a single clear primary action, minimum 28 px toolbar targets, visible `:focus-visible` rings, and no gradients. Input styling must match existing settings fields rather than browser defaults.

- [ ] **Step 5: Run integration and full frontend checks**

Run:

```bash
pnpm vitest run src/hooks/usePomodoroTimer.test.ts src/components/workspace/PomodoroTimer.test.tsx src/components/workspace/WorkspaceHeader.test.tsx
pnpm typecheck
pnpm lint
```

Expected: all tests pass, TypeScript exits 0, ESLint exits 0.

- [ ] **Step 6: Commit the integration**

```bash
git add src/components/workspace/WorkspaceHeader.tsx src/components/workspace/WorkspaceHeader.test.tsx src/styles/index.css src/styles/features/pomodoro.css
git commit -m "feat: integrate pomodoro timer in workspace header"
```

---

### Task 4: Tauri visual and behavior verification

**Files:**
- Modify only if the bounded inspection identifies a concrete defect in files from Tasks 1–3.

**Interfaces:**
- Consumes: completed timer feature.
- Produces: verified desktop behavior and a clean final check.

- [ ] **Step 1: Start the development app**

Run: `pnpm tauri dev`

Expected: Vite starts on `http://localhost:1420`, Cargo finishes, and the Ship Studio window opens without a runtime error.

- [ ] **Step 2: Perform one bounded visual pass**

Inspect these states in the running Tauri app at normal and compact widths: idle focus, running, paused, focus complete, break complete, settings, trigger attention, and Escape/outside-click closure. Confirm the popover remains anchored, is not clipped, does not collide with adjacent actions, and matches the incumbent surface/border/type hierarchy.

- [ ] **Step 3: Fix all observed defects in one batch and confirm once**

Apply only evidence-backed corrections from the visual pass. Re-run the three focused test files and `pnpm typecheck`; reopen the affected states once and stop polishing when they match the specification.

- [ ] **Step 4: Run final validation and commit any bounded corrections**

Run:

```bash
pnpm vitest run
pnpm typecheck
pnpm lint
pnpm format:check
git status --short
```

Expected: all checks pass. Only pre-existing local `.pnpm-store/` and `pnpm-workspace.yaml` may remain untracked.

If Task 4 required corrections:

```bash
git add src/hooks/usePomodoroTimer.ts src/hooks/usePomodoroTimer.test.ts src/components/icons/utility.tsx src/components/workspace/PomodoroTimer.tsx src/components/workspace/PomodoroTimer.test.tsx src/components/workspace/WorkspaceHeader.tsx src/components/workspace/WorkspaceHeader.test.tsx src/styles/index.css src/styles/features/pomodoro.css
git commit -m "fix: polish pomodoro timer interactions"
```
