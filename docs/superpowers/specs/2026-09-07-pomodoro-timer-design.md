# Pomodoro Timer Design

## Goal

Add a focused Pomodoro workflow to Ship Studio without introducing a separate productivity surface. The timer lives in the workspace header, follows the existing toolbar and popover visual language, and requires an explicit user action before every focus or break interval begins.

## User experience

### Entry point

- Add a timer icon to the workspace header's monochrome action row, adjacent to the notification control.
- Use the supplied 24-by-24 clock artwork, adapted to inherit the toolbar's current color and stroke treatment.
- The button uses the same hover, open, focus, tooltip, and disabled conventions as existing toolbar icon buttons.
- When an interval is running, the entry point exposes a subtle active-state indicator without widening or destabilizing the header.

### Timer popover

Selecting the timer button opens a compact anchored popover. It uses Ship Studio's existing dark surfaces, borders, radii, typography, spacing, shadows, and motion. It contains:

- the current phase: `Focus`, `Short break`, or `Long break`;
- a large `MM:SS` countdown;
- focus progress such as `Session 1 of 4`;
- context-appropriate primary and secondary controls;
- a compact settings view for durations and cycle length.

The initial defaults are 25 minutes of focus, 5 minutes for a short break, 15 minutes for a long break, and a long break after 4 completed focus sessions.

### Controls and transitions

The timer never starts the next interval automatically.

1. In an idle focus phase, the primary action is `Start focus`.
2. While counting down, the primary action is `Pause`; a secondary `Reset` action returns the current phase to its configured duration.
3. When a focus interval finishes, the popover changes to a persistent completion card reading `Focus complete`. Its primary action is `Start break`.
4. Focus sessions 1–3 lead to a short break. Session 4 leads to a long break.
5. When a break finishes, the completion card reads `Break complete`. Its primary action is `Start next session`.
6. Starting the next focus session advances the visible cycle. Completing the long break begins a fresh cycle at session 1.

Closing the popover does not pause or reset the timer. Reopening it shows the current state and remaining time.

### Completion feedback

- A completed interval always produces a visible, persistent completion state inside the timer popover.
- The timer button gains an attention state until the user opens the completion view or starts the next phase.
- If browser notification permission is already available, emit a system notification. Do not block the timer flow on notification permission.
- Play a short completion sound when allowed by the platform and user settings.
- Completion copy states what ended and presents one clear next action.

### Settings

The settings view allows whole-minute values for:

- focus duration;
- short-break duration;
- long-break duration;
- number of focus sessions before a long break.

Changes affect future intervals. If the current interval is idle, its displayed duration updates immediately. A running or paused interval keeps its existing remaining time, avoiding accidental progress loss.

## State model

Timer state is isolated from the header presentation and includes:

- current phase (`focus`, `shortBreak`, or `longBreak`);
- status (`idle`, `running`, `paused`, or `complete`);
- absolute target timestamp while running;
- remaining seconds while idle or paused;
- completed focus count within the current cycle;
- configuration values;
- whether completion needs user attention.

Countdown display is derived from the target timestamp instead of decrement-only intervals, so sleeping, background throttling, or temporarily closing the popover does not introduce drift.

## Persistence

Persist configuration and active timer state locally. On restoration:

- a future target timestamp resumes with the correct remaining time;
- an elapsed target timestamp resolves once into the appropriate completed state;
- invalid or missing stored data falls back to defaults;
- restoration never auto-starts the following phase.

No account sync or backend service is included in this version.

## Component boundaries

- A timer state hook owns transitions, timestamp calculations, persistence, and completion effects.
- A toolbar button owns the icon, active/attention treatment, tooltip, and popover trigger.
- A popover component renders the countdown, controls, completion card, session progress, and settings view.
- Small formatting and validation helpers remain independent and unit-testable.

The feature should reuse existing toolbar, popover/dropdown, form, and button patterns wherever their behavior matches.

## Accessibility and edge cases

- The toolbar button and every control have explicit accessible labels.
- Keyboard focus enters the popover predictably, `Escape` closes it, and visible focus treatment matches the app.
- Time and phase changes are announced without announcing every countdown tick.
- Durations and cycle length are clamped to sensible positive ranges and never accept invalid numeric input.
- Rapid pause/resume actions, system sleep, clock drift, and reopening the app after expiration do not duplicate phase completion.
- The layout remains usable in compact workspace mode.

## Verification

- Unit tests cover timer transitions, cycle progression, the fourth-session long break, pause/resume, reset, timestamp restoration, expiry restoration, and settings validation.
- Component tests cover button/popover interaction, completion actions, settings behavior, and accessible labels.
- Existing typecheck, lint, and relevant tests pass.
- A bounded visual pass verifies idle, running, paused, focus-complete, break-complete, settings, attention, dark-theme, and compact-header states in the Tauri app.

## Out of scope

- Productivity analytics, streaks, historical charts, task lists, cloud sync, and team timers.
- Automatic starting of focus or break intervals.
- A separate full-page Pomodoro workspace.
