//! # Tauri Commands
//!
//! This module re-exports all Tauri command handlers organized by category.

pub mod assets;
pub mod claude;
pub mod conflicts;
pub mod env;
pub mod git;
pub mod github;
pub mod ide;
pub mod projects;
pub mod pty;
pub mod publishing;
pub mod pull_requests;
pub mod setup;
pub mod vercel;

// Re-export all commands for easy access in lib.rs
pub use assets::*;
pub use claude::*;
pub use conflicts::*;
pub use env::*;
pub use git::*;
pub use github::*;
pub use ide::*;
pub use projects::*;
pub use pty::*;
pub use publishing::*;
pub use pull_requests::*;
pub use setup::*;
pub use vercel::*;
