# Hosting provider API matrix

Empirically verified against live accounts. Anything not marked **verified** is
from documentation only and must not become load-bearing UI logic until checked.

Last verified: 2026-09-05.

## Credential durability — the finding that shapes the whole design

| Provider   | CLI credential file                                            | Expiry                                                | Usable as our credential?                                                                                                                        |
| ---------- | -------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vercel     | `~/Library/Application Support/com.vercel.cli/auth.json`         | **~7 hours** (`expiresAt` seconds, plus `refreshToken`) | **No** — short-lived OAuth access token. Refreshing it means implementing Vercel's OAuth flow against a file the docs say must not be edited manually. |
| Netlify    | `~/Library/Preferences/netlify/config.json` → `users.<userId>.auth.token` | none present                                          | Opportunistically, yes                                                                                                                             |
| Cloudflare | `~/.config/.wrangler/config/default.toml`                        | n/a                                                   | Absent unless the user has run wrangler; newer versions use the OS keyring                                                                          |

**Consequence.** Credential resolution is a fallback chain, not a paste-wall:

1. Keychain token via the existing `accounts.rs` mechanism (`VERCEL_TOKEN`,
   `NETLIFY_AUTH_TOKEN`, `CLOUDFLARE_API_TOKEN`) — durable and supported.
2. The CLI credential file, if present and unexpired — free instant value with
   no setup, and the only reason a first-run user sees anything at all.
3. On rejection, an honest "reconnect" state.

**Why this matters beyond auth.** An expired Vercel token returns
`403 {"code":"forbidden","invalidToken":true}` — _not_ 401. The current plugin
treats any non-200 from its git-connection probe as `'unknown'`
(`plugin-vercel/src/index.tsx:1054`) and then renders
`gitConnection === 'not-connected' ? 'not-git-connected' : 'connected'`
(`:863`), so **a 403 renders a fully "connected" card** while the production URL
silently disappears (`fetchProjectDomains` returns `[]` on non-200). Any adapter
we write must classify 401 _and_ 403 as rejection, never as healthy.

## Vercel — verified

- **SHA filter is server-side and works.**
  `GET /v6/deployments?projectId=&teamId=&sha=<sha>` returns the matching
  deployment; a bogus SHA returns zero. The 2023 community thread claiming no
  SHA filter is stale.
- **The list endpoint does not return aliases.** Keys are: `aliasAssigned`,
  `aliasError`, `buildingAt`, `checks`, `created`, `createdAt`, `creator`,
  `inspectorUrl`, `isRollbackCandidate`, `meta`, `name`, `projectId`,
  `projectSettings`, `ready`, `readyState`, `readySubstate`, `source`, `state`,
  `target`, `type`, `uid`, `url`. Real aliases require
  `GET /v13/deployments/{uid}` — so resolving a commit to its live URLs is a
  **two-call flow**. `v13/deployments/{sha}` 404s; it takes a uid or URL only.
- **Git linkage lives in `meta`, not `gitSource`.** Even with
  `withGitRepoInfo=true` the response had no `gitSource` key. Use
  `meta.githubCommitSha`, `meta.githubCommitRef`, `meta.githubCommitMessage`,
  `meta.githubCommitAuthorName`, `meta.githubCommitOrg`, `meta.githubCommitRepo`.
- `readySubstate` (e.g. `PROMOTED`) and `target` (`production`) are present and
  real.

## Netlify — verified

- **`commit_ref` carries the full SHA**; there is no server-side commit filter,
  so narrow with `?branch=<branch>` and scan client-side.
- **Every URL is returned by the API — including the branch URL.** A production
  deploy returned `url`, `ssl_url` (`https://<site>.netlify.app`), `deploy_url`,
  and `deploy_ssl_url` (`https://<branch>--<site>.netlify.app`), plus
  `admin_url`. The branch URL never needs constructing, which is exactly what
  the Netlify plugin does today.
- **The commit message field is `commit_message`, not `title`.** Both are
  nullable — the verified deploy had `commit_message: null` and `title: null`,
  so the UI must fall back to the local `git log` subject.
- **Netlify does have a skip reason: `skipped_log`** (documentation suggested it
  had only a boolean). `skipped` is `null` rather than `false` when not skipped,
  so deserialize as `Option<bool>`.
- **`pending_review_reason`** supplies the detail for the gated state.
- **`deploy_source` / `manual_deploy`** distinguish a git-triggered deploy from a
  CLI/manual one — a manual deploy has no meaningful commit linkage and must not
  be matched against a pushed SHA.
- Still unconfirmed: how a canceled or `ignore`-command build appears in the
  `state` enum. Needs a deliberately canceled build to observe.

## Cloudflare Pages — NOT VERIFIED

No wrangler credentials on the verification machine, so nothing below was
observed. Treat every field as unconfirmed until a token is available:

- Deployment list is not filterable by commit; scan
  `deployment_trigger.metadata.commit_hash`.
- State is two-dimensional (`latest_stage.name` × `latest_stage.status`) and
  needs its own reducer rather than an enum lookup.
- `is_skipped` + `skip_reason` are documented as the cleanest skip signal of the
  three providers.
- Unconfirmed: whether `aliases[]` appears on the list item or only on the detail
  call, and whether it includes attached custom domains.
- Linking needs an `account_id`; Pages projects leave nothing on disk, so the
  link must be a user pick and the account id persisted.
