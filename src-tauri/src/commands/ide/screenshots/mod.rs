//! # Screenshot and Playwright Commands
//!
//! Commands for capturing project thumbnails, full-page and viewport screenshots,
//! image comparison, cropping, and stitching.
//!
//! Organized into submodules:
//! - `base` — crop, read as base64, and compare screenshots
//! - `playwright` — Playwright environment management, full-page and viewport captures
//! - `stitch` — stitch multiple screenshots into a single full-page image
//! - `thumbnail` — project thumbnail capture and retrieval

mod base;
mod playwright;
mod stitch;
mod thumbnail;

pub use base::*;
pub use playwright::*;
pub use stitch::*;
pub use thumbnail::*;

use crate::utils::{create_command, find_executable, get_extended_path};
use std::process::Command;

/// Build a command for a Node-ecosystem tool (`npm` / `npx` / `node`) with the
/// extended PATH. Resolves the binary via `find_executable` first — on Windows
/// npm and npx ship as `.cmd` shims, which `Command::new("npm")` can never
/// launch (Rust's PATH search only appends `.exe`). Falls back to the bare
/// name if resolution fails. Mirrors `mobile.rs::npx_command()`.
pub(super) fn node_tool_command(bin: &str) -> Command {
    let mut cmd = if let Some(path) = find_executable(bin) {
        create_command(path)
    } else {
        create_command(bin)
    };
    cmd.env("PATH", get_extended_path());
    cmd
}

#[cfg(test)]
mod tests {
    use super::node_tool_command;
    use crate::utils::get_extended_path;
    use std::ffi::OsStr;

    #[test]
    fn falls_back_to_bare_name_when_binary_not_found() {
        let cmd = node_tool_command("this-binary-definitely-does-not-exist-54321");
        assert_eq!(
            cmd.get_program(),
            OsStr::new("this-binary-definitely-does-not-exist-54321")
        );
    }

    #[test]
    fn sets_extended_path_env() {
        let cmd = node_tool_command("this-binary-definitely-does-not-exist-54321");
        let path_env = cmd
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("PATH"))
            .and_then(|(_, value)| value);
        let extended = get_extended_path();
        assert_eq!(path_env, Some(OsStr::new(extended.as_str())));
    }

    #[test]
    fn resolves_to_absolute_path_when_binary_exists() {
        // `cargo` is guaranteed to be findable while running `cargo test`.
        // Skip (rather than fail) if resolution misses on an exotic setup.
        if crate::utils::find_executable("cargo").is_none() {
            return;
        }
        let cmd = node_tool_command("cargo");
        assert!(
            std::path::Path::new(cmd.get_program()).is_absolute(),
            "expected an absolute resolved path, got {:?}",
            cmd.get_program()
        );
    }
}
