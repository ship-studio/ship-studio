#!/usr/bin/env bash
#
# check-config-integrity.sh — guard rail against config-file injection.
#
# Scans high-trust config and workflow files for anomalously long single
# lines. Real config lines stay under a few hundred characters; the
# 2026-04-29 incident snuck a 5,297-char obfuscated payload onto a single
# line of `eslint.config.js`, hidden behind a whitespace gap.
#
# This script catches that exact attack class — no JS execution, no
# parsing, just `awk`. If a legitimate config file genuinely needs a long
# line, raise `MAX_LINE_LENGTH` here OR move the long content to its own
# data file. Don't add per-file exceptions silently.
#
# Exit 0: all files clean.
# Exit 1: an anomalous line was found. The CI step fails.

set -euo pipefail

# Files that must not contain extremely long lines. The list is
# intentionally conservative — any file in here runs at config-load
# time (lint, build, CI) and so is a high-value injection target.
FILES=(
  "eslint.config.js"
  ".prettierrc"
  ".prettierrc.json"
  ".prettierrc.js"
  "prettier.config.js"
  "vite.config.ts"
  "vite.config.js"
  "vitest.config.ts"
  "tsconfig.json"
  "tsconfig.node.json"
  "package.json"
  "pnpm-workspace.yaml"
  ".lintstagedrc.json"
  ".lintstagedrc.js"
)

# Same scan applied to every workflow file. New workflows are
# automatically covered.
WORKFLOWS=(.github/workflows/*.yml .github/workflows/*.yaml)

# 500 chars is well above any reasonable config-line length and well
# below the size of payloads we're trying to catch (the incident's
# payload was 5,297 chars on one line). A formatter set to 100 columns
# wouldn't ever hit 500.
MAX_LINE_LENGTH=500

fail=0

scan_file() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  # awk: print "<file>:<line> length=<n>" for any line longer than the
  # threshold. Empty output = clean.
  local hits
  hits=$(awk -v max="$MAX_LINE_LENGTH" -v file="$path" '
    length($0) > max { printf "%s:%d length=%d\n", file, NR, length($0) }
  ' "$path")
  if [[ -n "$hits" ]]; then
    echo "::error::Anomalous line length detected in $path"
    echo "$hits"
    fail=1
  fi
}

for f in "${FILES[@]}"; do
  scan_file "$f"
done

# Workflow glob may not match if a path doesn't exist; nullglob lets us
# tolerate that without an "ambiguous redirect" error.
shopt -s nullglob
for f in "${WORKFLOWS[@]}"; do
  scan_file "$f"
done

if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "One or more config files contain a single line longer than $MAX_LINE_LENGTH characters."
  echo "This pattern is associated with hidden / obfuscated payload injection."
  echo "Inspect the flagged line(s) before merging."
  exit 1
fi

echo "Config integrity OK — no anomalous line lengths."
