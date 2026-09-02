//! # Studio Talk Commands
//!
//! Frontend access to the cross-project exchange registry (the engine lives
//! in `src-tauri/src/studio_talk.rs`). The UI subscribes to the
//! `studio-exchange-updated` event for live changes and calls this to seed
//! its initial state.

use crate::errors::CommandError;
use crate::studio_talk::StudioExchange;

/// All known exchanges, newest first (in-memory; empty after app restart).
#[tauri::command]
#[tracing::instrument]
pub fn list_studio_exchanges() -> Result<Vec<StudioExchange>, CommandError> {
    Ok(crate::studio_talk::list_exchanges())
}
