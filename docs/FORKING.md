# Maintaining the Harbr fork

Harbr preserves its GitHub fork relationship and full MIT-licensed history from
[Ship Studio](https://github.com/ship-studio/ship-studio). Product branding,
release configuration, state directories, and community links belong to Harbr.

Use these remotes:

```bash
git remote add origin https://github.com/kacigaya/harbr.git
git remote add upstream https://github.com/ship-studio/ship-studio.git
```

## Sync upstream

Create an integration branch from the latest upstream `main`, merge the Harbr
branch into it, and resolve conflicts against current upstream architecture.
Keep Harbr's web server, Linux behavior, identity, local-only analytics, and
state migration intact. Run every validation gate in `CLAUDE.md` before
fast-forwarding `main`.

Do not reuse upstream telemetry, error-reporting, updater, signing, support, or
release credentials. Harbr does not send product analytics or crash reports to
upstream services. Its updater remains disabled until a Harbr signing key is
available.

Project metadata under `.shipstudio` and the `ss:*` preview protocol are stable
compatibility contracts. Legacy application state may be copied once into
Harbr-owned state storage; legacy files must remain untouched.
