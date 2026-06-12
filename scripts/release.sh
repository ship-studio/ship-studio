#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/release.sh                                    # patch bump, manual release notes
#   ./scripts/release.sh minor                              # minor bump
#   ./scripts/release.sh major                              # major bump
#   ./scripts/release.sh patch -n "Fixed bug X"             # patch bump with single note
#   ./scripts/release.sh minor -n "New feature A" -n "New feature B"  # multiple notes

BUMP_TYPE="patch"
NOTES=()

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major) BUMP_TYPE="$1"; shift ;;
    -n|--note) NOTES+=("$2"); shift 2 ;;
    -h|--help)
      echo "Usage: ./scripts/release.sh [patch|minor|major] [-n \"Release note\"] [-n \"Another note\"]"
      echo ""
      echo "Examples:"
      echo "  ./scripts/release.sh                              # patch bump"
      echo "  ./scripts/release.sh minor -n \"New feature A\"     # minor bump with note"
      echo "  ./scripts/release.sh -n \"Fix X\" -n \"Fix Y\"       # patch bump with multiple notes"
      exit 0
      ;;
    *) echo "Unknown argument: $1. Use -h for help."; exit 1 ;;
  esac
done

# Read current version from package.json
CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case "$BUMP_TYPE" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEW_VERSION}"

echo "Current version: $CURRENT_VERSION"
echo "New version:     $NEW_VERSION ($BUMP_TYPE)"
echo ""

# Check for clean working tree
if ! git diff --quiet HEAD; then
  echo "Error: You have uncommitted changes. Commit or stash them first."
  exit 1
fi

# Add release notes if provided via -n flags
if [ ${#NOTES[@]} -gt 0 ]; then
  echo "Adding release notes to RELEASE_NOTES.md..."

  # Build the notes section
  NOTES_SECTION="## What's New in v${NEW_VERSION}\n"
  for note in "${NOTES[@]}"; do
    NOTES_SECTION="${NOTES_SECTION}\n- ${note}"
  done
  NOTES_SECTION="${NOTES_SECTION}\n"

  # Insert after the HTML comment closing tag
  sed -i '' "/^-->/a\\
\\
$(echo -e "$NOTES_SECTION" | sed 's/$/\\/' | sed '$ s/\\$//')
" RELEASE_NOTES.md
fi

# Check Changelog.tsx has been updated for this version (displayed on dashboard sidebar)
if ! grep -q "v${NEW_VERSION}" src/components/dashboard/Changelog.tsx; then
  echo "Error: src/components/dashboard/Changelog.tsx has no entry for v${NEW_VERSION}."
  echo "Update the changelog data before releasing — it drives the dashboard 'What's New' panel."
  exit 1
fi

# Check RELEASE_NOTES.md has been updated
if ! grep -q "## What's New in v${NEW_VERSION}" RELEASE_NOTES.md; then
  echo "Error: RELEASE_NOTES.md doesn't have a section for v${NEW_VERSION}."
  echo ""
  echo "Either add notes manually, or use the -n flag:"
  echo "  ./scripts/release.sh $BUMP_TYPE -n \"**Feature** - Description\""
  echo ""
  exit 1
fi

# Bump version in all 3 files
echo "Bumping version in package.json..."
sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" package.json

echo "Bumping version in src-tauri/Cargo.toml..."
sed -i '' "s/^version = \"${CURRENT_VERSION}\"/version = \"${NEW_VERSION}\"/" src-tauri/Cargo.toml

echo "Bumping version in src-tauri/tauri.conf.json..."
sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" src-tauri/tauri.conf.json

# Update Cargo.lock
echo "Updating Cargo.lock..."
(cd src-tauri && cargo update -p ship-studio 2>/dev/null || true)

echo ""

# Commit
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock RELEASE_NOTES.md
git commit -m "Release v${NEW_VERSION}"

# Tag
git tag -a "$TAG" -m "$TAG"

echo ""
echo "Version bumped to $NEW_VERSION and tagged as $TAG."
echo ""
echo "To release, run:"
echo "  git push origin main && git push origin $TAG"
echo ""
echo "Then wait for CI and publish the draft release at:"
echo "  https://github.com/ship-studio/ship-studio/releases"
