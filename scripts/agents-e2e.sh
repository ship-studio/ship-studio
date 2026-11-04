#!/bin/bash
# Opt-in end-to-end suite for Agents: real Claude Code turns on Haiku (costs a
# little money, needs `claude` signed in). Runs in a throwaway HOME; never
# touches ~/ShipStudio or ~/.claude. See src-tauri/examples/agents_e2e/main.rs.
#   scripts/agents-e2e.sh                  # every scenario
#   scripts/agents-e2e.sh memory burst     # some
#   AGENTS_E2E_KEEP=1 scripts/agents-e2e.sh   # keep the temp HOME to inspect
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
cargo build --quiet --example agents_e2e
# Run a private copy: a shared target dir can be rebuilt by another checkout
# mid-run, and macOS kills a process whose binary is rewritten under it.
bin="$(mktemp -d)/agents_e2e"
cp "$CARGO_TARGET_DIR/debug/examples/agents_e2e" "$bin"
exec "$bin" "$@"
