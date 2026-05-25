# Forking & shipping your own distribution

This guide is for developers who want to **fork Ship Studio and publish their
own signed, auto-updating builds** under a different name, identity, or
telemetry configuration.

If you just want to **contribute back** to upstream Ship Studio, read
[CONTRIBUTING.md](../CONTRIBUTING.md) instead.

---

## What's involved

A production Ship Studio release pipeline ships:

- A **macOS** `.dmg` (Apple Silicon + Intel), signed and notarised by Apple.
- A **Windows** `.exe` installer, signed (optional — SmartScreen reputation
  builds over time without it).
- **Auto-updater artifacts** (`latest.json` + signature) so installed builds
  upgrade themselves.

Forking means owning each of those. The good news: most of the pipeline lives
in `.github/workflows/release.yml` and `.github/workflows/release-windows.yml`
already — you mostly need to swap secrets and a handful of identifiers.

---

## 1 — Brand & identifiers

Things to change so your build is unambiguously yours, not Memberstack's:

| File | Field | What to change |
|------|-------|----------------|
| `src-tauri/tauri.conf.json` | `productName` | Your app name (`"My Studio"`) |
| `src-tauri/tauri.conf.json` | `identifier` | Reverse-DNS bundle ID (`com.acme.mystudio`) |
| `src-tauri/tauri.conf.json` | `version` | A starting semver string (`"0.1.0"`). **Must be semver** — the Tauri updater compares versions and will refuse non-semver values. |
| `src-tauri/tauri.conf.json` | `plugins.updater.endpoints` | URL(s) to *your* `latest.json` |
| `src-tauri/tauri.conf.json` | `plugins.updater.pubkey` | The pubkey for *your* signing keypair (see §3) |
| `src-tauri/tauri.conf.json` | `plugins.deep-link.desktop.schemes` | Your custom URL scheme |
| `src-tauri/Cargo.toml` | `[package].name`, `description`, `authors`, `repository`, `homepage` | Your project |
| `package.json` | `name`, `description`, `repository`, `homepage`, `bugs` | Your project |
| `.github/workflows/release.yml` | hardcoded `ship-studio/releases` references | Your releases repo (or `${{ github.repository }}` if collapsing to one repo — see §4) |
| `.github/workflows/release-windows.yml` | hardcoded `ship-studio/releases` references | Same as above |
| `README.md`, `CONTRIBUTING.md`, etc. | Repo URLs, Slack invite | Your community links |

> **Why the bundle identifier matters.** macOS treats two binaries with the
> same identifier as the same app. If you ship `com.memberstack.shipstudio`,
> macOS thinks your build is a corrupted Ship Studio update and refuses to
> install it. Change the identifier before your first release.

---

## 2 — Code signing

### macOS (required for release)

Without code signing, macOS Gatekeeper refuses to launch unsigned binaries
downloaded from the internet. You need:

1. **An Apple Developer account** ($99/year).
2. **A Developer ID Application certificate**, exported as a `.p12` file.
   - In Xcode → Settings → Accounts → Manage Certificates → `+` →
     **Developer ID Application**.
   - Export the resulting certificate (with private key) from Keychain
     Access as a `.p12`, with a password.
3. **An App Store Connect API key** for notarisation.
   - [App Store Connect](https://appstoreconnect.apple.com/) → Users and
     Access → Integrations → App Store Connect API → Generate Key.
   - Download the `.p8`. Note the **Key ID** and **Issuer ID**.

Encode them for GitHub Actions:

```bash
# .p12 → base64
base64 -i certificate.p12 | pbcopy        # macOS
base64 -w0 certificate.p12                # Linux

# .p8 → base64
base64 -i AuthKey_<KEY_ID>.p8 | pbcopy    # macOS
```

Add these GitHub Secrets (Settings → Secrets and variables → Actions):

| Secret | Source |
|--------|--------|
| `APPLE_CERTIFICATE` | base64 of `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password you set on the `.p12` |
| `APPLE_API_KEY` | the API Key ID (e.g. `ABC123XYZ`) |
| `APPLE_API_ISSUER` | the Issuer ID (UUID) |
| `APPLE_API_KEY_CONTENT` | base64 of the `.p8` |

The workflow at `.github/workflows/release.yml` reads all of these from
its `env:` block under the macOS build job.

### Windows (optional but recommended)

Without code signing, Windows SmartScreen warns users on first launch.
SmartScreen reputation builds up after enough installs, but a code-signed
binary skips the friction.

Buy a code-signing certificate from a CA (DigiCert, Sectigo, SSL.com, etc.).
EV certs are pricier but get reputation faster. Configure your release
workflow per the
[Tauri Windows signing guide](https://tauri.app/distribute/sign/windows/).

---

## 3 — Tauri updater keypair

The updater verifies downloaded artifacts against a public key embedded in
the app. Generate your own keypair — never reuse the one in this repo.

```bash
pnpm tauri signer generate -w ~/.tauri/myapp.key
# follow the prompts; choose a password (recommended)
```

This produces two files:

- `~/.tauri/myapp.key`     — **private key, keep secret.**
- `~/.tauri/myapp.key.pub` — public key, copy into `tauri.conf.json`.

In `src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/<you>/<releases-repo>/releases/latest/download/latest-{{target}}.json",
      "https://github.com/<you>/<releases-repo>/releases/latest/download/latest.json"
    ],
    "pubkey": "<contents of myapp.key.pub, on one line>"
  }
}
```

Add to GitHub Secrets:

| Secret | Source |
|--------|--------|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/myapp.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you set (or empty) |

---

## 4 — Release infrastructure

The upstream pipeline uses a **two-repo split**:

- **Source repo** — `ship-studio/ship-studio` (this one). Where development
  and PRs happen.
- **Releases repo** — `ship-studio/releases`. Where built binaries are
  published. The updater endpoint points here.

This split keeps the source repo's release tab uncluttered and lets the
releases repo stay public even if the source repo is private. **For a
public OSS fork it's optional** — you can publish releases on the source
repo and drop the second repo entirely. To do that:

1. Update `src-tauri/tauri.conf.json` → `plugins.updater.endpoints` to point
   at your *source* repo's `releases/latest/...` URL.
2. In `.github/workflows/release.yml` and `release-windows.yml`, change
   wherever the workflow `gh release create`s into `ship-studio/releases`
   so it uses the current repo (`${{ github.repository }}`).
3. Drop the `RELEASES_PAT` secret (you only needed it to write into a
   different repo).

If you want to keep the two-repo split:

- Create `<you>/<releases-repo>`.
- Set `RELEASES_PAT` to a Personal Access Token (classic) with `repo` scope
  that can write into that releases repo.
- Update the workflows' hard-coded `ship-studio/releases` references to
  your releases repo's `<owner>/<name>`.

---

## 5 — Telemetry

The official Ship Studio build sends events to a Memberstack-owned
[PostHog](https://posthog.com/) project and crash reports to
[Sentry](https://sentry.io/). **Forks must not reuse these keys** — they're
write-only ingest keys, but Memberstack pays for the events.

Three choices:

### a) Replace with your own keys

Sign up for PostHog and/or Sentry. Then swap the constants:

| File | Constant | Replace with |
|------|----------|--------------|
| `src-tauri/src/commands/analytics.rs:15` | `POSTHOG_API_KEY` | your `phc_…` key |
| `src-tauri/src/commands/analytics.rs:16` | `POSTHOG_HOST` | e.g. `https://eu.i.posthog.com` |
| `src-tauri/src/logging.rs:22-23` | `SENTRY_DSN` | your Sentry DSN |
| `src/instrument.ts:5-6` | `DSN` | same Sentry DSN (frontend) |

Read [docs/analytics.md](analytics.md) to see what events fire and at what
volume. Adjust as needed.

### b) Disable telemetry entirely

Replace the keys with empty strings. The send paths short-circuit cleanly
when keys are empty:

```rust
// src-tauri/src/commands/analytics.rs
const POSTHOG_API_KEY: &str = "";
const POSTHOG_HOST: &str = "";

// src-tauri/src/logging.rs
const SENTRY_DSN: &str = "";
```

```typescript
// src/instrument.ts
const DSN = '';
```

Verify after building that no requests fire to PostHog or Sentry domains.

### c) Build-time env-driven keys

If you want a single source tree that produces both an "official" build
(with telemetry) and a "private" build (without), convert the constants to
`option_env!()` / build-time `import.meta.env` reads. This is the same
pattern used for `CSTAR_IDENTITY_SECRET` (see §6).

---

## 6 — Optional: support / identity integrations

Two additional integrations the official build uses; safe to ignore in a
fork:

- **cStar.help** — an in-app support widget. Driven by a build-time
  `CSTAR_IDENTITY_SECRET` env var (see
  `src-tauri/src/commands/support.rs:15-18`). It's already
  `option_env!()`-based and defaults to empty, so forks get a no-op
  Help/Support panel automatically. Replace with your own integration if
  you want one.

- **The community Slack invite URL** is referenced in
  `src/components/ProjectList.tsx`, `src/components/setup/OnboardingScreen.tsx`,
  and `src/components/support/SupportHome.tsx`. Swap for your own community
  link or remove.

---

## 7 — CI: handling forked PRs

`.github/workflows/ci.yml` references `secrets.CSTAR_IDENTITY_SECRET`. Forks
have no such secret, so:

- The Rust code path defaults to `""` via `option_env!()` — clippy and
  `cargo build` pass.
- Any test that exercises HMAC signing of identity requests will produce a
  bogus signature. The CI job *passes* but the signed value is not
  meaningful.

If you don't use cStar, remove every `secrets.CSTAR_IDENTITY_SECRET` reference
from `.github/workflows/ci.yml` so contributors' forked PRs run the full
identical workflow.

---

## 8 — First release checklist

Once your fork is configured:

- [ ] All `Ship Studio` / `ship-studio/ship-studio` strings in
      user-visible places (app title, menus, About) updated to your brand.
- [ ] `tauri.conf.json` → `identifier`, `productName`, `version`, updater
      endpoints, updater pubkey, deep-link schemes updated.
- [ ] GitHub Secrets configured: `APPLE_*` (×5), `TAURI_SIGNING_*` (×2),
      `RELEASES_PAT` (if using two-repo flow), telemetry keys (if you
      went with build-time env-driven keys).
- [ ] Tested a release end-to-end: tag, build, signed `.dmg` opens on a
      clean macOS install without Gatekeeper warnings.
- [ ] Tested auto-update: previous build → new build, banner appears,
      restart succeeds.
- [ ] LICENSE preserved (MIT requires the copyright notice to stay).
- [ ] CHANGELOG / release notes describe your changes vs. upstream.

---

## Staying in sync with upstream

Forks that track upstream changes:

```bash
# add upstream remote (once)
git remote add upstream https://github.com/ship-studio/ship-studio.git

# pull upstream changes
git fetch upstream
git merge upstream/main  # or rebase, depending on your preference
```

Watch the upstream [releases](https://github.com/ship-studio/releases) and
[release notes](../RELEASE_NOTES.md) for security-relevant fixes.

If you ship a meaningful improvement, **please send a PR back to upstream**
— the project is stronger when downstream forks share what they've built.

---

## Getting help

- Stuck on signing? See the [Tauri distribution guide](https://tauri.app/distribute/).
- Stuck on PostHog/Sentry setup? Their docs are extensive; ask in our
  [Discussions](https://github.com/ship-studio/ship-studio/discussions) if
  you'd like fork-specific advice.
- Found a bug in the fork pipeline itself? Open an issue — that's a
  contribution to upstream too.
