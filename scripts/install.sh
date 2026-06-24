#!/usr/bin/env bash
#
# Ship Studio -- one-command installer for macOS.
#
#   curl -fsSL https://ship.studio/install | bash
#
# Downloads the latest build, installs it to /Applications, clears the
# Gatekeeper quarantine flag, and launches it -- no "unverified developer"
# prompt. (Builds are code-signed with a Developer ID but not Apple-notarized;
# running this script is your explicit consent to launch the app, which is what
# lets us skip notarization.)
#
# Uses only tools that ship with macOS (curl, tar, ditto, xattr) -- no Python,
# no Homebrew, nothing to install first.
#
# Options (env vars):
#   SHIPSTUDIO_DEST=/path        install dir (default: /Applications)
#   SHIPSTUDIO_NO_LAUNCH=1       install but don't open the app afterwards
set -euo pipefail

REPO="ship-studio/releases"
APP_NAME="Ship Studio.app"
DEST="${SHIPSTUDIO_DEST:-/Applications}"
MANIFEST="https://github.com/${REPO}/releases/latest/download/latest.json"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || err "This installer is for macOS. On Windows, run the PowerShell command from https://ship.studio/install"

# Map the CPU to the updater's platform key.
case "$(uname -m)" in
  arm64)  PLATFORM="darwin-aarch64" ;;
  x86_64) PLATFORM="darwin-x86_64" ;;
  *)      err "Unsupported architecture: $(uname -m)" ;;
esac

# Resolve the current version + download URL from the same manifest the
# auto-updater uses. Its URL points at the correct release tag's .app.tar.gz,
# so this is robust even though the newest GitHub release is a Windows one.
say "Finding the latest version..."
JSON="$(curl -fsSL "$MANIFEST")" || err "Could not reach the release manifest."
VERSION="$(printf '%s' "$JSON" | tr -d '\n' | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
URL="$(printf '%s' "$JSON" | tr -d '\n' | grep -oE "\"${PLATFORM}\"[^}]*\"url\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" | grep -oE 'https://[^"]+')"
[ -n "$URL" ] || err "No download found for ${PLATFORM} in the manifest."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading Ship Studio ${VERSION:-latest} (${PLATFORM})..."
curl -fSL --progress-bar "$URL" -o "$TMP/shipstudio.tar.gz" || err "Download failed: $URL"

say "Extracting..."
tar -xzf "$TMP/shipstudio.tar.gz" -C "$TMP"
APP_PATH="$(find "$TMP" -maxdepth 2 -name '*.app' -type d | head -1)"
[ -n "$APP_PATH" ] || err "No .app found inside the downloaded archive."

# Use sudo only if the install dir isn't writable by the current user.
run() { "$@"; }
mkdir -p "$DEST" 2>/dev/null || true
if [ ! -w "$DEST" ]; then
  say "${DEST} needs admin access -- you may be prompted for your password."
  run() { sudo "$@"; }
fi

if [ -d "${DEST}/${APP_NAME}" ]; then
  say "Removing the previous install..."
  run rm -rf "${DEST}/${APP_NAME}"
fi

say "Installing to ${DEST} ..."
run ditto "$APP_PATH" "${DEST}/${APP_NAME}"

# Clear the quarantine flag so Gatekeeper doesn't block first launch.
say "Clearing the quarantine flag..."
run xattr -dr com.apple.quarantine "${DEST}/${APP_NAME}" 2>/dev/null || true

say "Ship Studio ${VERSION:-} installed to ${DEST}."
if [ -z "${SHIPSTUDIO_NO_LAUNCH:-}" ]; then
  open "${DEST}/${APP_NAME}"
fi
