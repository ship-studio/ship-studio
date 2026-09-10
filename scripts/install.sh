#!/usr/bin/env bash
# Install the latest published Harbr macOS DMG.
set -euo pipefail

readonly ASSET_URL="https://github.com/kacigaya/harbr/releases/latest/download/Harbr_darwin-universal.dmg"
readonly DESTINATION="${HARBR_DEST:-/Applications}"

say() { printf '\033[1;32m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "This installer requires macOS."

install_tmp="$(mktemp -d)"
mount_point="${install_tmp}/mount"
cleanup() {
  hdiutil detach "$mount_point" -quiet 2>/dev/null || true
  rm -rf "$install_tmp"
}
trap cleanup EXIT

say "Downloading Harbr..."
curl -fL --progress-bar "$ASSET_URL" -o "${install_tmp}/Harbr.dmg"
mkdir -p "$mount_point"
hdiutil attach "${install_tmp}/Harbr.dmg" -mountpoint "$mount_point" -nobrowse -quiet
[[ -d "${mount_point}/Harbr.app" ]] || fail "The image does not contain Harbr.app."

copy=(ditto "${mount_point}/Harbr.app" "${DESTINATION}/Harbr.app")
if [[ ! -w "$DESTINATION" ]]; then copy=(sudo "${copy[@]}"); fi
say "Installing Harbr to ${DESTINATION}..."
"${copy[@]}"

if [[ -z "${HARBR_NO_LAUNCH:-}" ]]; then open "${DESTINATION}/Harbr.app"; fi
say "Harbr installed."
