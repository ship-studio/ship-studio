# DX Drift Audit Baseline

Captured after Blocks 1–15 of [DX_REFACTOR_PLAN.md](../DX_REFACTOR_PLAN.md) landed.

Run `bash scripts/audit-dx-drift.sh` to capture current numbers; diff against
this baseline. Trends downward = system working. Trends upward = guardrails
need tightening.

## Baseline — 2026-04-14

| Metric | Baseline |
|--------|---------:|
| Hardcoded hex colors in styles (excl. base.css, setup.css) | 142 |
| `!important` usage in styles (all 3rd-party overrides) | 28 |
| `Result<T, String>` in `#[tauri::command]` entry points | 0 |
| `Result<T, String>` including internal helpers (informational) | 37 |
| LOC — `WorkspaceView.tsx` | 1143 |
| LOC — `ProjectList.tsx` | 656 |
| LOC — `PluginManager.tsx` | 562 |
| LOC — `ImportProject.tsx` | 403 |
| LOC — `App.tsx` | 956 |
| Modal files (`*Modal.tsx`) | 15 |
| Modal files NOT importing `ModalFrame` | 0 |
| `navigator.clipboard.writeText` outside primitives | 4 (documented as legitimate) |
| `setInterval` outside approved utilities | 5 (documented as legitimate) |

## Ritual

Every quarter (Jan 1, Apr 1, Jul 1, Oct 1):
1. Run `bash scripts/audit-dx-drift.sh`
2. Diff against the latest entry in this file
3. Append a new row with date + metrics
4. If any metric is up materially, open a Linear/GitHub issue to investigate

This is intentionally a manual ritual — a recurring calendar invite or
Linear recurring issue is the right automation; the script only gathers
the numbers.
