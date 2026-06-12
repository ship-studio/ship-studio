#!/usr/bin/env bash
# Quarterly DX drift audit. Run every 3 months and diff against the prior
# run to see whether the codebase is drifting back toward pre-refactor
# patterns (= guardrails need tightening) or staying clean (= system works).
#
# Block 15.11 of DX_REFACTOR_PLAN.md. Seed the baseline from DX_AUDIT_REPORT.md.
set -uo pipefail

echo "=== DX drift audit — $(date +%Y-%m-%d) ==="
echo

echo "-- Hardcoded hex colors in styles (excl. base.css, setup.css): --"
rg -c --no-heading '(color|background|border)(-[a-z-]+)?\s*:\s*#[0-9a-fA-F]{3,8}' src/styles/ \
  --glob '!src/styles/base.css' \
  --glob '!src/styles/setup.css' 2>/dev/null \
  | awk -F: '{s+=$2} END{print "  total: "s+0}'
echo

echo "-- !important usage in styles: --"
rg -c --no-heading '!important' src/styles/ 2>/dev/null \
  | awk -F: '{s+=$2} END{print "  total: "s+0}'
echo

echo "-- Result<T, String> in #[tauri::command] entry points (not helpers): --"
rg -B 3 -U 'pub async fn |pub fn ' src-tauri/src/commands/ \
  | rg -B 1 'Result<.*, String>' \
  | rg -c '#\[tauri::command\]' 2>/dev/null \
  | awk '{s+=$1} END{print "  total: "s+0}'
echo "-- Result<T, String> anywhere in Rust (incl. internal helpers, informational): --"
rg -c 'Result<.*, String>' src-tauri/src/commands/ 2>/dev/null \
  | awk -F: '{s+=$2} END{print "  total: "s+0}'
echo

echo "-- LOC of largest components: --"
for f in src/components/workspace/WorkspaceView.tsx src/components/dashboard/ProjectList.tsx \
         src/components/plugins/PluginManager.tsx src/components/dashboard/ImportProject.tsx \
         src/App.tsx; do
  if [ -f "$f" ]; then
    printf "  %-50s %5d\n" "$f" "$(wc -l <"$f" | tr -d ' ')"
  fi
done
echo

echo "-- Modal implementations (files matching *Modal.tsx): --"
find src/components -maxdepth 4 -name '*Modal.tsx' | wc -l | awk '{print "  total: "$1}'
echo

echo "-- Files bypassing ModalFrame (grep: no ModalFrame import): --"
find src/components -maxdepth 4 -name '*Modal.tsx' -print0 \
  | xargs -0 grep -L 'ModalFrame' 2>/dev/null \
  | wc -l | awk '{print "  total: "$1}'
echo

echo "-- navigator.clipboard.writeText outside primitives: --"
rg -l 'navigator\.clipboard\.writeText' src/ \
  --glob '!src/hooks/useCopyToClipboard.ts' \
  --glob '!src/components/primitives/**' \
  --glob '!src/**/*.test.{ts,tsx}' 2>/dev/null \
  | wc -l | awk '{print "  total: "$1}'
echo

echo "-- setInterval outside approved utilities: --"
rg -l 'setInterval' src/ \
  --glob '!src/hooks/usePolling.ts' \
  --glob '!src/lib/polling.ts' \
  --glob '!src/lib/logger.ts' \
  --glob '!src/lib/project.ts' \
  --glob '!src/**/*.test.{ts,tsx}' 2>/dev/null \
  | wc -l | awk '{print "  total: "$1}'
echo

echo "Done. Compare to last run's output — trends down = healthy."
