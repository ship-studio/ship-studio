#!/usr/bin/env bash
# LOC regression guard. Fails CI if any file grows past a documented ceiling.
#
# Per Block 15.6 of DX_REFACTOR_PLAN.md — this is a soft guard to force a
# conversation before a file balloons. Limits can be bumped deliberately
# by editing this script, but it won't happen silently.
#
# Seeds based on current state after Blocks 7 + 13.
set -uo pipefail

FAIL=0

check_file() {
  local path="$1"
  local limit="$2"
  if [ ! -f "$path" ]; then
    return 0
  fi
  local lines
  lines=$(wc -l <"$path" | tr -d ' ')
  if [ "$lines" -gt "$limit" ]; then
    echo "  ✗ $path: $lines LOC (limit $limit)"
    FAIL=1
  else
    echo "  $path — $lines / $limit"
  fi
}

echo "==> Ship Studio LOC regression guard"
echo
echo "Components (.tsx limit 1200):"
# WorkspaceView + App.tsx got denser with the multi-project multitasking
# work (per-project tab state, per-project dev servers, attach-based PTY
# sessions) and again with the side-by-side agents feature (per-pane
# state, split rendering, drag handles), then again with the native mobile
# preview (web/mobile preview branch + DeviceMirror render). Raised
# deliberately — extracting a TerminalPanes sub-component from WorkspaceView
# is on the roadmap but doesn't belong in the same PR as the feature itself.
check_file src/components/WorkspaceView.tsx 1525
check_file src/components/ProjectList.tsx 800
check_file src/components/PluginManager.tsx 700
check_file src/components/ImportProject.tsx 500
check_file src/App.tsx 1250
echo
echo "CSS (limit 1200 per file):"
while IFS= read -r f; do
  check_file "$f" 1200
done < <(find src/styles -maxdepth 3 -name '*.css' 2>/dev/null)
echo

if [ $FAIL -ne 0 ]; then
  echo "==> FAIL: file(s) exceed soft LOC ceiling."
  echo "    Either extract sub-components or raise the limit in scripts/check-loc-limits.sh"
  echo "    (raise deliberately, not reflexively)."
  exit 1
fi

echo "==> OK: all files under LOC ceiling."
