# Third-Party Notices

Harbr redistributes or depends on the following third-party software for
the native mobile preview. Apache-2.0 requires this notice to accompany
redistributed binaries — keep this file when packaging.

## scrcpy (vendored)

The Android mirror pushes **scrcpy-server** to the device for low-latency H.264
capture and input injection.

- Project: <https://github.com/Genymobile/scrcpy>
- Copyright © Genymobile / Romain Vimont and contributors
- License: Apache License 2.0 — <https://www.apache.org/licenses/LICENSE-2.0>
- Vendored artifact: `src-tauri/resources/scrcpy-server.jar` (**v4.0**, unmodified
  upstream release binary)

**Version pinning:** the jar's protocol version MUST match `SCRCPY_VERSION` in
`src-tauri/src/commands/mobile.rs` — the server validates the version argument
it is launched with. Update both together, and re-verify the control-message
wire format against the new server source (it has changed across major
versions).

## serve-sim (runtime dependency, not vendored)

The iOS mirror runs **serve-sim** via `npx` on the user's machine; Harbr
does not redistribute it.

- Project: <https://github.com/EvanBacon/serve-sim> (Evan Bacon / Expo)
- License: Apache License 2.0
