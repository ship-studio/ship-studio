# Releasing Ship Studio

## Quick Release (recommended)

### 1. Update RELEASE_NOTES.md (REQUIRED)

**IMPORTANT: This step is mandatory. Users see these notes in the update dialog.**

Edit `RELEASE_NOTES.md` and add a new section at the top (below the HTML comment):

```markdown
## What's New in vX.Y.Z

- **Feature name** - Description of the change
- **Bug fix** - What was fixed
```

### 2. Run the release script

```bash
./scripts/release.sh          # patch bump (0.3.2 -> 0.3.3)
./scripts/release.sh minor    # minor bump (0.3.2 -> 0.4.0)
./scripts/release.sh major    # major bump (0.3.2 -> 1.0.0)
```

The script will:
- Bump the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`
- Update `Cargo.lock`
- Commit and tag

### 3. Push

```bash
git push origin main && git push origin vX.Y.Z
```

### 4. Wait for GitHub Actions to complete (~15 minutes)

### 5. Publish the draft release in the main repo:
- https://github.com/ship-studio/ship-studio/releases
- (The public releases repo auto-publishes)

---

## What Happens Automatically

When you push a tag starting with `v`, GitHub Actions will:

1. **Build** the app for both ARM64 (Apple Silicon) and Intel Macs
2. **Sign** the app with the Apple Developer certificate
3. **Create** signed update bundles (`.tar.gz` + `.sig`)
4. **Read** release notes from `RELEASE_NOTES.md`
5. **Generate** `latest.json` manifest with notes and download URLs
6. **Upload** artifacts to both repos
7. **Auto-publish** the public releases repo release

## Why Two Repos?

The main `ship-studio/ship-studio` repo is **private** to protect source code. However, the auto-updater needs public URLs to download updates. The `ship-studio/releases` repo is **public** and only contains:

- `latest.json` - Version manifest for auto-updater (includes release notes)
- `ShipStudio_darwin-aarch64.app.tar.gz` - ARM64 update bundle
- `ShipStudio_darwin-x86_64.app.tar.gz` - Intel update bundle

No source code is exposed.

## Required Secrets

These secrets must be configured in the main repo's GitHub settings:

| Secret | Purpose |
|--------|---------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 certificate for code signing |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the certificate |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID (for notarization) |
| `APPLE_API_KEY` | App Store Connect API key ID (for notarization) |
| `APPLE_API_KEY_CONTENT` | Base64-encoded .p8 private key file (for notarization) |
| `TAURI_SIGNING_PRIVATE_KEY` | Private key for update bundle signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |
| `RELEASES_PAT` | Personal Access Token with `public_repo` scope for cross-repo access |

## Verification Checklist

After the workflow completes:

- [ ] Draft release exists in main repo
- [ ] Public release is auto-published in releases repo
- [ ] Verify public URL works:
  ```bash
  curl -sL https://github.com/ship-studio/releases/releases/latest/download/latest.json | jq
  ```
- [ ] Verify release notes are included in the JSON
- [ ] Publish the main repo draft release
- [ ] Test auto-updater shows update available in-app

## Windows Releases

Windows builds run on a separate workflow (`.github/workflows/release-windows.yml`) triggered by tags ending in `-win`. The macOS workflow explicitly excludes these tags (`'!*-win'`), so the two build pipelines are independent, but both publish to the shared `ship-studio/releases` public repo. As of v0.6.8 the Windows public release **auto-publishes**, exactly like macOS — there is no longer a manual publish step (see History below).

### How to publish a Windows build

The version a `-win` build ships comes from the source files (`package.json` etc.) **at the tagged commit**, and the workflow that runs is also the one at that commit. Two consequences:

1. **Tag at the same version as the current macOS release** so the two platforms don't drift. There is no script for this — `scripts/release.sh` only cuts macOS `vX.Y.Z` tags. Point the `-win` tag at the commit whose version matches the latest published macOS release:
   ```bash
   # ship Windows for the version currently on macOS (e.g. 0.6.8)
   git tag v0.6.8-win <commit-with-that-version>
   git push origin v0.6.8-win
   ```
2. **Any fix to `release-windows.yml` must be merged before you tag**, and the tag must point at a commit that contains it. Tagging an older commit runs the *old* workflow — this is how the pre-v0.6.8 `--draft` gate kept silently producing drafts.

### Verification

After the workflow completes (~15–25 min for the Windows build):

- [ ] A **published** (not draft) release exists in `ship-studio/releases` with 2 Windows artifacts (`-setup.exe`, `-setup.exe.sig`), 2 manifests (`latest-windows.json`, carried-forward `latest.json`), and 2 carried-forward macOS DMGs (`ShipStudio_darwin-aarch64.dmg`, `ShipStudio_darwin-x86_64.dmg`)
- [ ] `latest-windows.json` is valid and has a `windows-x86_64` platform entry:
  ```bash
  curl -sL https://github.com/ship-studio/releases/releases/latest/download/latest-windows.json | jq
  ```
- [ ] `latest.json` still resolves at the public latest URL and still points at the most recent macOS bundle (the carry-forward keeps macOS auto-update alive when this release flips the "latest" alias):
  ```bash
  curl -sL https://github.com/ship-studio/releases/releases/latest/download/latest.json | jq '.version'
  ```
- [ ] The site's static download links all still resolve (every release must carry the other platform's installers forward, or flipping the "latest" alias 404s them — this bit us when v0.6.8-win shipped without the DMGs):
  ```bash
  for f in ShipStudio_darwin-aarch64.dmg ShipStudio_darwin-x86_64.dmg ShipStudio_windows-x86_64-setup.exe; do
    curl -s -o /dev/null -w "$f -> %{http_code}\n" -L -r 0-0 \
      "https://github.com/ship-studio/releases/releases/latest/download/$f"
  done   # all three should print 206
  ```
- [ ] A draft release also lands in the main repo (the build-artifact dump); publishing it is optional — the public repo is what users and the updater read.

### History: the silent-draft gap

Before v0.6.8, `release-windows.yml` created the public release with `--draft` as a "manual publish gate." The manual publish was never performed, so every Windows build from v0.5.1 onward stopped at a draft and **no Windows download was ever live**, while the manifest still advertised a stale 0.6.0. The gate was removed once the `windows-check` job in `ci.yml` began verifying that the Windows build actually compiles and its tests pass — that automated check is what the manual gate was a stand-in for.

## Troubleshooting

### Workflow fails at "Create release in public releases repo"

The `RELEASES_PAT` secret may be missing or expired. Create a new Personal Access Token:
1. Go to https://github.com/settings/tokens
2. Generate new token (classic) with `public_repo` scope
3. Add it as `RELEASES_PAT` in repo secrets

### Auto-updater doesn't find updates

1. Ensure the release in `ship-studio/releases` is **published** (not draft)
2. Check `latest.json` URLs point to the public repo
3. Verify the app version is lower than the release version

### Release notes not showing

1. Ensure `RELEASE_NOTES.md` was updated before tagging
2. Check the workflow logs for the "Read release notes" step
