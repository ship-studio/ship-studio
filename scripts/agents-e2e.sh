#!/bin/bash
# Opt-in end-to-end suite for Agents: real Claude Code turns on Haiku (costs a
# little money, needs `claude` signed in). Runs in a throwaway HOME; never
# touches ~/ShipStudio or ~/.claude. See src-tauri/examples/agents_e2e.rs.
#   scripts/agents-e2e.sh                  # every scenario
#   scripts/agents-e2e.sh memory burst     # some
#   AGENTS_E2E_KEEP=1 scripts/agents-e2e.sh   # keep the temp HOME to inspect
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
exec cargo run --quiet --example agents_e2e -- "$@"
