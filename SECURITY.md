# Security policy

## Supported versions

We provide security fixes for the latest released version of Harbr.
Older versions are not patched.

| Version    | Supported          |
| ---------- | ------------------ |
| Latest     | :white_check_mark: |
| < Latest   | :x:                |

## Reporting a vulnerability

**Please do not file a public GitHub issue for security reports.**

Use GitHub's [private vulnerability reporting](https://github.com/kacigaya/harbr/security/advisories/new)
to file a report only the maintainers can see.

Include:

- A clear description of the vulnerability and its impact.
- Steps to reproduce (or a proof-of-concept) on a clean install of the latest
  release.
- The Harbr version and host OS — find the version in the **Harbr** menu →
  **About** (the leftmost app menu on both platforms).
- Any logs from `~/Library/Logs/Harbr/` (macOS) or
  `%LOCALAPPDATA%\Harbr\logs\` (Windows) that help reproduce.

### What to expect

- We acknowledge reports within **3 business days**.
- We aim to triage and confirm within **7 business days**.
- High-severity issues get a patched release within **14 days**; others
  within the next regular release.
- We will credit you in the release notes unless you ask us not to.

## Scope

In scope:

- The Harbr desktop app (this repository).
- Official release binaries from
  [kacigaya/harbr](https://github.com/kacigaya/harbr).
- The authenticated browser server and desktop application.

Out of scope:

- Third-party integrations Harbr shells out to (`gh`, `vercel`,
  `claude`) — report those to their respective maintainers.
- Forks that rebrand or repackage Harbr — please contact the fork
  maintainer.
- Issues that require a pre-compromised user machine (e.g. an attacker who
  already has filesystem access).

## Hall of fame

Researchers who responsibly disclose security issues will be listed here
(with permission) once their reports are resolved.
