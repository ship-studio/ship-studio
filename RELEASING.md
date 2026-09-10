# Releasing Harbr

Harbr releases are built in this repository. The macOS, Windows, and Linux
workflows create draft releases with stable `Harbr_*` artifact names. Review and
publish a draft manually after testing its installers.

The in-app updater and updater bundles are intentionally disabled. Do not turn
them on until Harbr has a dedicated Tauri signing key and the public key is
configured in `src-tauri/tauri.conf.json`.

## Prepare

1. Update the version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`.
2. Refresh `pnpm-lock.yaml` and `src-tauri/Cargo.lock`.
3. Run the required gates:

   ```bash
   pnpm check:all
   pnpm test:run
   pnpm rust:test
   cargo test --manifest-path src-tauri/Cargo.toml --features web
   pnpm build
   ```

4. Commit the release and create the appropriate tag:

   - macOS: `vX.Y.Z`
   - Windows: `vX.Y.Z-win`
   - Linux desktop and server: `vX.Y.Z-linux`

5. Push the commit and tag. Inspect the draft release, install the artifacts on
   their target platforms, then publish it.

macOS notarization and Windows Authenticode signing are distribution concerns
separate from Tauri updater signing. Configure those before presenting builds
as trusted public installers.
