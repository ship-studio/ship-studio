#!/usr/bin/env bash
# Run the UI guardrails together while retaining a readable result for each
# gate. GitHub Actions also writes the final table to its job summary.
set -uo pipefail

FAIL=0
PATTERN_STATUS=1
ICON_STATUS=1
LOC_STATUS=1

run_gate() {
  local label="$1"
  shift
  echo
  echo "==> $label"
  if "$@"; then
    return 0
  fi
  FAIL=1
  return 1
}

if run_gate "Pattern regression check" pnpm check:patterns; then
  PATTERN_STATUS=0
fi

if run_gate "Icon asset check" pnpm icons:check; then
  ICON_STATUS=0
fi

if run_gate "LOC regression guard" pnpm check:loc; then
  LOC_STATUS=0
fi

status_text() {
  if [ "$1" -eq 0 ]; then
    printf 'PASS'
  else
    printf 'FAIL'
  fi
}

echo
echo "==> UI verification baseline summary"
printf '  Pattern gate: %s\n' "$(status_text "$PATTERN_STATUS")"
printf '  Icon gate:    %s\n' "$(status_text "$ICON_STATUS")"
printf '  LOC gate:     %s\n' "$(status_text "$LOC_STATUS")"

SUMMARY_FILE=''
if printenv GITHUB_STEP_SUMMARY >/dev/null 2>&1; then
  SUMMARY_FILE=$(printenv GITHUB_STEP_SUMMARY)
fi

if [ -n "$SUMMARY_FILE" ]; then
  {
    echo "## UI verification baseline"
    echo
    echo '| Gate | Result |'
    echo '| --- | --- |'
    printf '| Pattern regression | %s |\n' "$(status_text "$PATTERN_STATUS")"
    printf '| Icon assets | %s |\n' "$(status_text "$ICON_STATUS")"
    printf '| LOC regression | %s |\n' "$(status_text "$LOC_STATUS")"
  } >>"$SUMMARY_FILE"
fi

exit "$FAIL"
