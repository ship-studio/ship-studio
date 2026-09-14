# Pomodoro Pause on Exit Implementation Plan

Goal: restore a paused countdown after exiting the app.
Architecture: paused localStorage checkpoints plus window-local live state.
Tech stack: React, TypeScript, Vitest.

- [x] Update src/hooks/usePomodoroTimer.ts to persist paused checkpoints and retain active deadlines across remounts.
- [x] Update src/hooks/usePomodoroTimer.test.ts to cover legacy state, restart checkpoints, manual resume and workspace remounts.
- [x] Run pnpm check:all, pnpm test:run and pnpm rust:test.
