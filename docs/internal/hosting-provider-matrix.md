# Hosting provider API matrix

Empirically verified against live accounts. Anything not marked **verified** is
from documentation only and must not become load-bearing UI logic until checked.

Last verified: 2026-09-05.

## Credential durability — the finding that shapes the whole design

| Provider   | CLI credential file                                            | Expiry                                                | Usable as our credential?                                                                                                                        |
| ---------- | -------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vercel     | `~/Library/Application Support/com.vercel.cli/auth.json`         | **~7 hours** (`expiresAt` seconds, plus `refreshToken`) | **No** — short-lived OAuth access token. Refreshing it means implementing Vercel's OAuth flow against a file the docs say must not be edited manually. |
| Netlify    | `~/Library/Preferences/netlify/config.json` → `users.<userId>.auth.token` | none present                                          | Opportunistically, yes                                                                                                                             |
| Cloudflare | `~/Library/Preferences/.wrangler/config/default.toml` on macOS — **not** the documented `~/.config/.wrangler` | **~1 hour** (`expiration_time`, ISO-8601, plus a `refresh_token`) | Opportunistically, but it lapses within the hour |

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
- **`links` carries both addresses.** `links.alias` is the site's,
  `links.permalink` is the deploy's own, and `deploy_ssl_url` is the branch's.
  Verified on a real deploy — none of them needs assembling.
- **Timestamps are ISO-8601 strings** (`2026-02-22T17:26:51.942Z`), not epoch
  milliseconds like Vercel.
- **`manual_deploy`** marks a CLI or drag-and-drop deploy, which carries no
  commit and must never be matched to a push.
- **`admin_url` is the site's page, not the deploy's.** There is no per-deploy
  admin link in the response.
- **No build-log endpoint is published.** `error_message` on the deploy record
  is the only failure detail available, so the adapter returns an empty log
  rather than inventing an endpoint.
- Endpoints verified against a live account: `GET /user`, `GET /sites`,
  `GET /sites/{id}`, `GET /sites/{id}/deploys?branch=`.
- Still unconfirmed: how a canceled or `ignore`-command build appears in the
  `state` enum. Needs a deliberately canceled build to observe.

### Known limitation: neither list is paginated

Netlify paginates with `page` / `per_page` and returns the first page when
`page` is omitted. This adapter requests one page for both list calls and
follows no `Link` header, which has two consequences worth stating rather than
leaving to be discovered:

- **`find_for_commit` scans one page of 100 deploys on the branch.** A commit
  further back than that answers `NotFound`. The degradation is in the honest
  direction — the UI shows "no deploy reported yet", never a failure and never
  another commit's status — and the question is always about a commit the user
  has just pushed, which sits at the top of the list. Vercel needs none of this
  because it filters by `sha` server-side; Netlify has no such filter, so a
  bounded scan is the shape of the thing.
- **`list_projects` shows the first 100 sites.** An account with more than that
  has sites the link picker cannot offer, and there is no in-app way around it.
  This is the more user-visible of the two and the better candidate for the
  first follow-up.

Both are limitations, not defects: neither shows a wrong deployment, a wrong
site, or a wrong status. Full pagination is a loop plus a stopping rule for each
call, and is deliberately not in the change that introduced this adapter.

## Cloudflare Pages — verified

Verified against a live account and a real deployment. A disposable Pages
project, `shipstudio-hosting-testbed`, was created and deployed to for this;
it exists to be re-verified against and can be deleted whenever.

- **`latest_stage` is authoritative; `stages` is not.** On a deployment that
  had already succeeded, the `stages` array still reported
  `("queued", "active")` alongside `("deploy", "success")`. Walking that array
  would report a finished deployment as permanently queued. Only `latest_stage`
  is read.
- **`aliases` came back `null`, not an empty array**, and did not contain the
  project's address. The site's address comes from the project's `domains` /
  `subdomain`, which is a separate call.
- **A direct upload reports `commit_hash: ""`** — an empty string, not null —
  with `deployment_trigger.type: "ad_hoc"`. Both are checked, because an
  empty-string match would pair an upload with any commit.
- **Timestamps carry microseconds** (`2026-09-06T03:49:12.456043Z`).
- **The build-log endpoint works and matches the documented shape**:
  `/deployments/{id}/history/logs` returns `{ data: [{ ts, line }], total,
  includes_container_logs }`. Cloudflare does not separate stdout from stderr.
- **`url` already carries its scheme**, unlike Vercel's.
- Endpoints verified: `GET /accounts`, `/accounts/{id}/pages/projects`,
  `/accounts/{id}/pages/projects/{name}`, `.../deployments`, and
  `.../deployments/{id}/history/logs`.
- Still unobserved: a **failing** build, a **skipped** commit, and a
  **git-triggered** deployment (the testbed deploys by direct upload). The
  stage reducer and `skip_reason` handling are therefore still exercised only
  against documented shapes.
