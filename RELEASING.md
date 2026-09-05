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

1. **Build** one universal app (Apple Silicon + Intel in a single binary)
2. **Sign** it with the Developer ID certificate (hardened runtime)
3. **Notarize** the app with Apple and staple the ticket, then notarize + staple the DMG
4. **Verify** the result (`codesign`, `stapler validate`, `spctl --assess`) — the job fails if the DMG would show any Gatekeeper dialog
5. **Create** signed update bundles (`.tar.gz` + `.sig`)
6. **Read** release notes from `RELEASE_NOTES.md`
7. **Generate** `latest.json` (both `darwin-aarch64` and `darwin-x86_64` point at the universal bundle)
8. **Upload** artifacts to both repos
9. **Auto-publish** the public releases repo release

Public macOS assets: `ShipStudio_darwin-universal.dmg` (the download the site should link), plus
`ShipStudio_darwin-aarch64.dmg` / `ShipStudio_darwin-x86_64.dmg` (identical bytes, kept so old links resolve).

### Why notarization is mandatory

An un-notarized app on macOS 15+ opens to "Apple could not verify … is free of malware" with no
Open button; the only escape is System Settings → Privacy & Security → Open Anyway. Right-click →
Open no longer bypasses it. So the workflow refuses to build unless every notarization secret is
present, and refuses to publish unless `spctl` accepts the DMG. Do not weaken either gate; fix the
account instead.

## Why Two Repos?

The main `ship-studio/ship-studio` repo is **private** to protect source code. However, the auto-updater needs public URLs to download updates. The `ship-studio/releases` repo is **public** and only contains:

- `latest.json` - Version manifest for auto-updater (includes release notes)
- `ShipStudio_darwin-universal.app.tar.gz` - universal update bundle (served for both arch keys)
- `ShipStudio_darwin-universal.dmg` (+ legacy `-aarch64` / `-x86_64` copies) - user downloads

No source code is exposed.

## Required Secrets

These secrets must be configured in the main repo's GitHub settings:

| Secret | Purpose |
|--------|---------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 of the **Developer ID Application** certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID (notarization) |
| `APPLE_API_KEY` | App Store Connect API key ID (notarization) |
| `APPLE_API_KEY_CONTENT` | Base64-encoded .p8 private key (notarization) |
| `TAURI_SIGNING_PRIVATE_KEY` | Private key for update bundle signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |
| `RELEASES_PAT` | Personal Access Token with `public_repo` scope for cross-repo access |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | Service principal that may sign with the Artifact Signing certificate profile (Windows) |
| `AZURE_SIGNING_ENDPOINT` | Artifact Signing regional endpoint, e.g. `https://eus.codesigning.azure.net` (Windows) |
| `AZURE_SIGNING_ACCOUNT` / `AZURE_SIGNING_PROFILE` | Artifact Signing account name and certificate profile name (Windows) |

### Setting up the Apple secrets (one-time, per Apple Developer account)

The macOS pipeline signs and notarizes under whichever Apple Developer Program account these
secrets belong to. Everything below happens at <https://developer.apple.com/account> and takes
about 15 minutes once the membership is active.

1. **Developer ID Application certificate** → Certificates, IDs & Profiles → Certificates → `+` →
   *Developer ID Application*. Create the CSR in Keychain Access (Certificate Assistant → Request a
   Certificate From a Certificate Authority → Saved to disk). Download the `.cer`, double-click to
   add it to the login keychain, then in Keychain Access right-click the certificate (with its
   private key) → Export → `.p12` with a password.
   ```bash
   base64 -i ShipStudio.p12 | pbcopy     # → APPLE_CERTIFICATE
   ```
   The password → `APPLE_CERTIFICATE_PASSWORD`.
2. **App Store Connect API key** → <https://appstoreconnect.apple.com/access/integrations/api> →
   Team Keys → `+` → name "Ship Studio CI", access **Developer** (enough to notarize). Download the
   `.p8` (only offered once).
   ```bash
   base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy   # → APPLE_API_KEY_CONTENT
   ```
   The Key ID → `APPLE_API_KEY`; the Issuer ID shown at the top of the page → `APPLE_API_ISSUER`.
3. Set all five in the main repo: Settings → Secrets and variables → Actions.

Verify locally before tagging (optional but cheap):
```bash
xcrun notarytool history --key AuthKey_XXXXXXXXXX.p8 --key-id <KEY_ID> --issuer <ISSUER_ID>
```
A 403 here means the account's Program License Agreement is not accepted or the membership is not
active — fix that in the developer account; no code change helps.

> History: builds up to v1.0.0 were signed with a Memberstack Inc. Developer ID (team J335CB82MX)
> and, from 40b6a1a1 on, not notarized at all because that team's agreement lapsed. The bundle
> identifier stays `com.memberstack.shipstudio` regardless of which team signs — changing it would
> move every user's app data directory.

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

### Windows code signing (Azure Artifact Signing)

An unsigned installer hits SmartScreen's "Windows protected your PC" wall and Chrome's
"uncommon download" warning, so Windows builds are Authenticode-signed with
[Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (formerly Trusted
Signing; ~$10/month, no hardware token, SmartScreen reputation from day one). The workflow signs
the app exe and the NSIS installer through Tauri's `bundle.windows.signCommand`, using the
[`artifact-signing-cli`](https://crates.io/crates/artifact-signing-cli) wrapper, and then fails the
release if `Get-AuthenticodeSignature` on the installer is anything but `Valid`.

If the `AZURE_*` secrets are absent the build still succeeds **unsigned**, with a workflow warning —
acceptable for a dry run, never for a public release.

One-time setup in the Azure portal (individual developers: US/Canada only; the identity check is a
phone ID scan through Microsoft Authenticator and can complete the same day):

1. Create an **Artifact Signing account** (Basic SKU, a US region such as *East US* →
   endpoint `https://eus.codesigning.azure.net`). Name → `AZURE_SIGNING_ACCOUNT`.
2. **Identity validation** → Individual → Public. It is prefilled from the Azure billing account,
   so the billing account's legal name/address must match your government ID. Complete the
   Verified ID flow when the status flips to *Action Required*.
3. **Certificate profile** → Public Trust, bound to that identity. Name → `AZURE_SIGNING_PROFILE`.
4. **Service principal for CI**: Microsoft Entra ID → App registrations → New → note the
   Application (client) ID and Directory (tenant) ID; Certificates & secrets → New client secret.
   Then on the Artifact Signing account → Access control (IAM) → Add role assignment →
   *Artifact Signing Certificate Profile Signer* → that app. These become `AZURE_CLIENT_ID`,
   `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`.

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

- [ ] A **published** (not draft) release exists in `ship-studio/releases` with 2 Windows artifacts (`-setup.exe`, `-setup.exe.sig`), 2 manifests (`latest-windows.json`, carried-forward `latest.json`), and the carried-forward macOS DMGs (`ShipStudio_darwin-*.dmg`)
- [ ] The workflow log's "Find and stage updater artifacts" step shows `Authenticode status: Valid` (not a signing warning)
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
