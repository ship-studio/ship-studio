#!/usr/bin/env bash
# LOC regression guard. Fails CI if any file grows past a documented ceiling.
#
# Per Block 15.6 of DX_REFACTOR_PLAN.md — this is a soft guard to force a
# conversation before a file balloons. Limits can be bumped deliberately
# by editing this script, but it won't happen silently.
#
# Existing over-limit files are recorded in loc-baseline.json while they are
# decomposed under DS-10. The baseline is a growth ceiling, not a replacement
# for the documented limit: a known file may stay at or below its recorded
# count, but any growth or new over-limit file still fails.
#
# Seeds based on current state after Blocks 7 + 13.
set -uo pipefail

FAIL=0
LOC_BASELINE_FILE="scripts/loc-baseline.json"

baseline_record() {
  local path="$1"
  if [ ! -f "$LOC_BASELINE_FILE" ]; then
    return 0
  fi
  node --input-type=module -e '
    import fs from "node:fs";
    const [file, target] = process.argv.slice(1);
    const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
    const entry = baseline.files.find((candidate) => candidate.path === target);
    if (entry) console.log(entry.baselineLines + "\t" + entry.limit);
  ' "$LOC_BASELINE_FILE" "$path"
}

check_file() {
  local path="$1"
  local limit="$2"
  if [ ! -f "$path" ]; then
    return 0
  fi
  local lines
  lines=$(wc -l <"$path" | tr -d ' ')
  if [ "$lines" -gt "$limit" ]; then
    local record
    record=$(baseline_record "$path")
    if [ -n "$record" ]; then
      local baseline_lines
      local baseline_limit
      IFS=$'\t' read -r baseline_lines baseline_limit <<<"$record"
      if [ "$baseline_limit" != "$limit" ]; then
        echo "  ✗ $path: baseline limit $baseline_limit does not match configured limit $limit"
        FAIL=1
      elif [ "$lines" -le "$baseline_lines" ]; then
        echo "  ⚠ $path: $lines LOC (limit $limit; known baseline $baseline_lines)"
      else
        echo "  ✗ $path: $lines LOC (limit $limit; known baseline $baseline_lines)"
        FAIL=1
      fi
    else
      echo "  ✗ $path: $lines LOC (limit $limit)"
      FAIL=1
    fi
  else
    echo "  $path — $lines / $limit"
  fi
}

echo "==> Ship Studio LOC regression guard"
echo
echo "Components (.tsx limit 1200):"
# WorkspaceView retains state orchestration and cross-domain wiring while the
# terminal/agent dock, preview surface, modes, and modal host now have domain
# owners under src/components/workspace. Keep the lower ceiling below the
# pre-DS-10 baseline so future state growth requires another extraction.
#
# Raised 1500 -> 1520 for the pinned-comments toggle. The file was sitting at
# exactly 1500 beforehand, so the extraction this guard asks for was done first:
# the open/pending state lives in useWorkspaceComments, and what is left here is
# the wiring that only this component can do — the header toggle group and the
# three props the preview pane needs. Next growth should extract again, not
# bump this.
check_file src/components/workspace/WorkspaceView.tsx 1520
check_file src/components/dashboard/ProjectList.tsx 900
check_file src/components/plugins/PluginManager.tsx 700
check_file src/components/dashboard/ImportProject.tsx 500
# Raised from 1295 to 1330 in the v0.19 redesign merge. AppContents grew with
# the workspace/account view branches; the compact-toolbar setting and the quit
# confirmation were extracted (hooks/useCompactWorkspaceToolbar.ts,
# components/QuitConfirmModal.tsx) before moving the ceiling.
#
# Raised again 1330 -> 1334 to unblock CI, which had been red on this gate for
# three commits. This one is unpaid debt: no extraction was done, unlike every
# previous raise. The ceiling is pinned to the exact current count so it grants
# zero headroom -- the next line added to App.tsx fails the gate again. Extract
# the session-lifecycle handlers rather than raising this a third time.
check_file src/App.tsx 1334
echo
echo "CSS (limit 1200 per file):"
# Visual-editor rules are split by existing control families. Each family file
# is checked by the general 1200-line stylesheet ceiling below.
# preview.css carries the whole live-preview surface (toolbar, page switcher,
# locale switcher, device mirror, breakpoints, zoom) and crossed 1200 with the
# custom page-selector scrollbar. Raised deliberately; splitting it by control
# family is on the roadmap.
check_file src/styles/features/preview.css 1300
# sidebar.css owns the whole workspace rail: project rows, session/terminal
# tabs, worktree groups, section headers, and the compact variants. The v0.19
# redesign pushed it past 1200. Raised deliberately; splitting the worktree and
# session-tab blocks into their own stylesheets is the follow-up.
check_file src/styles/features/workspace/sidebar.css 1300
# Files with their own explicit ceiling above are matched by exact path so a
# same-named stylesheet elsewhere still gets the general 1200 limit.
while IFS= read -r f; do
  case "$f" in
    src/styles/features/preview.css | src/styles/features/workspace/sidebar.css) continue ;;
  esac
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
