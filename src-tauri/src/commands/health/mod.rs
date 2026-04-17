//! # Code Health Commands
//!
//! This module provides commands for detecting and running code quality scripts
//! (tests, linting, type checking, formatting) from a project's package.json.

mod deps;
mod run;

pub use deps::*;
pub use run::*;

use crate::types::PackageManager;
use std::path::Path;

/// Detect the package manager from lockfiles in the project
pub(super) fn detect_package_manager_internal(project_path: &Path) -> PackageManager {
    if project_path.join("pnpm-lock.yaml").exists() {
        PackageManager::Pnpm
    } else if project_path.join("yarn.lock").exists() {
        PackageManager::Yarn
    } else if project_path.join("bun.lockb").exists() || project_path.join("bun.lock").exists() {
        PackageManager::Bun
    } else {
        PackageManager::Npm
    }
}
