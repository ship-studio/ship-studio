#!/usr/bin/env bash
set -euo pipefail

# Build Harbr with code signing and .pkg installer generation.
#
# Notarization env vars are optional — if set, Tauri will attempt to notarize.
# Without them, the script still builds a signed .app and .pkg.
#
# Required:
#   export APPLE_CERTIFICATE="$(base64 -i /path/to/certificate.p12)"
#   export APPLE_CERTIFICATE_PASSWORD="your-cert-password"
#   export APPLE_SIGNING_IDENTITY="Developer ID Application"
#
# Optional (for notarization — requires Apple team to be enabled):
#   export APPLE_API_ISSUER="your-issuer-id"
#   export APPLE_API_KEY="your-key-id"
#   export APPLE_API_KEY_PATH="/path/to/AuthKey_XXXXXXXX.p8"
#
# Optional (for .pkg signing — requires Developer ID Installer cert):
#   export INSTALLER_SIGNING_IDENTITY="Developer ID Installer"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

REQUIRED_VARS=(
  APPLE_CERTIFICATE
  APPLE_CERTIFICATE_PASSWORD
  APPLE_SIGNING_IDENTITY
)

echo "Checking required environment variables..."
MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    MISSING+=("$var")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo -e "${RED}Missing required environment variables:${NC}"
  for var in "${MISSING[@]}"; do
    echo "  - $var"
  done
  echo ""
  echo "Usage:"
  echo '  export APPLE_CERTIFICATE="$(base64 -i /path/to/certificate.p12)"'
  echo '  export APPLE_CERTIFICATE_PASSWORD="your-cert-password"'
  echo '  export APPLE_SIGNING_IDENTITY="Developer ID Application"'
  echo ""
  echo "  ./scripts/build-notarized.sh"
  exit 1
fi

# Check notarization vars
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  echo -e "${GREEN}Notarization credentials found — Tauri will attempt notarization.${NC}"
  if [ ! -f "$APPLE_API_KEY_PATH" ]; then
    echo -e "${RED}Error: .p8 key file not found at $APPLE_API_KEY_PATH${NC}"
    exit 1
  fi
else
  echo -e "${YELLOW}Notarization credentials not set — skipping notarization (build + sign only).${NC}"
fi

# Check installer signing identity
INSTALLER_IDENTITY="${INSTALLER_SIGNING_IDENTITY:-}"
if [ -n "$INSTALLER_IDENTITY" ]; then
  echo -e "${GREEN}Installer signing identity found — .pkg will be signed.${NC}"
else
  echo -e "${YELLOW}INSTALLER_SIGNING_IDENTITY not set — .pkg will be unsigned.${NC}"
  echo "  To sign the .pkg, create a 'Developer ID Installer' certificate and set:"
  echo '  export INSTALLER_SIGNING_IDENTITY="Developer ID Installer"'
fi

echo ""

# Build (allow updater artifact failure if signing key not set)
echo "Building Harbr..."
pnpm tauri build || {
  # Check if the .app was built despite the error (e.g. updater signing failed)
  if [ -d "src-tauri/target/release/bundle/macos/Harbr.app" ]; then
    echo -e "${YELLOW}Build completed with warnings (updater artifacts may have failed — this is OK for local testing).${NC}"
  else
    echo -e "${RED}Build failed.${NC}"
    exit 1
  fi
}

# Find the built .app
APP_PATH="src-tauri/target/release/bundle/macos/Harbr.app"
if [ ! -d "$APP_PATH" ]; then
  echo -e "${YELLOW}Could not find app at expected path, searching...${NC}"
  APP_PATH=$(find src-tauri/target/release/bundle/macos -name "*.app" -maxdepth 1 | head -1)
  if [ -z "$APP_PATH" ]; then
    echo -e "${RED}No .app bundle found in src-tauri/target/release/bundle/macos/${NC}"
    exit 1
  fi
fi

echo ""
echo "Built app: $APP_PATH"
echo ""

# Verify code signing
echo "Verifying code signature..."
if codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1; then
  echo -e "${GREEN}Code signature: valid${NC}"
else
  echo -e "${RED}Code signature: INVALID — cannot continue${NC}"
  exit 1
fi
echo ""

# Build .pkg installer
PKG_PATH="src-tauri/target/release/bundle/macos/Harbr.pkg"
echo "Creating .pkg installer..."

if [ -n "$INSTALLER_IDENTITY" ]; then
  xcrun productbuild \
    --sign "$INSTALLER_IDENTITY" \
    --component "$APP_PATH" /Applications \
    "$PKG_PATH"
  echo -e "${GREEN}Signed .pkg created: $PKG_PATH${NC}"
else
  xcrun productbuild \
    --component "$APP_PATH" /Applications \
    "$PKG_PATH"
  echo -e "${YELLOW}Unsigned .pkg created: $PKG_PATH${NC}"
fi
echo ""

# Verify .app Gatekeeper assessment
echo "Checking Gatekeeper assessment (.app)..."
if spctl --assess --verbose=2 "$APP_PATH" 2>&1; then
  echo -e "${GREEN}Gatekeeper (.app): accepted${NC}"
else
  echo -e "${YELLOW}Gatekeeper (.app): not accepted (expected without notarization)${NC}"
fi
echo ""

# Verify .pkg Gatekeeper assessment
if [ -n "$INSTALLER_IDENTITY" ]; then
  echo "Checking Gatekeeper assessment (.pkg)..."
  if spctl --assess --type install --verbose=2 "$PKG_PATH" 2>&1; then
    echo -e "${GREEN}Gatekeeper (.pkg): accepted${NC}"
  else
    echo -e "${YELLOW}Gatekeeper (.pkg): not accepted (expected without notarization)${NC}"
  fi
  echo ""
fi

# Check notarization staple if notarization was attempted
if [ -n "${APPLE_API_KEY:-}" ]; then
  echo "Checking notarization staple..."
  if xcrun stapler validate "$APP_PATH" 2>&1; then
    echo -e "${GREEN}Staple: valid${NC}"
  else
    echo -e "${YELLOW}Staple: not found (notarization may not be enabled for your team yet)${NC}"
  fi
  echo ""
fi

echo "Output:"
echo "  .app: $APP_PATH"
echo "  .pkg: $PKG_PATH"
echo ""
echo "Done."
