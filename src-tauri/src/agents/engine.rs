//! Which CLI an agent's turns run on: Claude Code (the default) or Codex,
//! so an agent can run on a Claude or a ChatGPT subscription with the same
//! chat, tools and approvals around it. The turn itself is in `runner` (and
//! `codex` for Codex's command line and stream); this is what the editor and
//! the Chief need to choose: which engines are here, signed in, and which
//! models each offers.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::errors::CommandError;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Claude,
    Codex,
}

impl Engine {
    pub const ALL: [Engine; 2] = [Engine::Claude, Engine::Codex];

    pub fn label(self) -> &'static str {
        match self {
            Engine::Claude => "Claude Code",
            Engine::Codex => "Codex",
        }
    }

    fn binary_name(self) -> &'static str {
        match self {
            Engine::Claude => "claude",
            Engine::Codex => "codex",
        }
    }

    /// What the editor, the Chief and the registry call it.
    pub fn parse(value: &str) -> Result<Engine, CommandError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude code" | "claude-code" => Ok(Engine::Claude),
            "codex" | "chatgpt" => Ok(Engine::Codex),
            _ => Err(super::err_invalid(
                "engine",
                "Pick Claude Code (`claude`) or Codex (`codex`).",
            )),
        }
    }
}

/// A model an engine offers. `value` is passed as `--model` / `-m`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: Engine,
    pub label: &'static str,
    pub installed: bool,
    /// Codex: `codex login status` says so. Claude Code: taken as signed in
    /// once installed (its sign-in lives in the keychain; a signed-out turn
    /// says so in the chat, with a way to sign in).
    pub signed_in: bool,
    /// The engine's own models, without "Default" (no `--model` at all).
    pub models: Vec<ModelChoice>,
}

impl EngineInfo {
    pub fn ready(&self) -> bool {
        self.installed && self.signed_in
    }
}

type Probe<T> = LazyLock<Mutex<HashMap<Engine, (T, String, Instant)>>>;

/// Each engine's binary, found and validated once per PATH.
static BINARIES: Probe<PathBuf> = LazyLock::new(Default::default);

/// The engine's binary, found and validated (`--version`, which spawns a
/// process and costs ~100ms) once per PATH, not per turn. It is looked for
/// again if the file goes away, or fails to start ([`forget_binary`]).
pub async fn binary(engine: Engine) -> Option<PathBuf> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    if let Some((binary, for_path, _)) = BINARIES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&engine)
    {
        if *for_path == path_var && binary.exists() {
            return Some(binary.clone());
        }
    }
    let name = engine.binary_name();
    let binary = tokio::task::spawn_blocking(move || {
        crate::commands::claude::find_validated_binary(name, "--version")
    })
    .await
    .ok()
    .flatten()?;
    BINARIES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(engine, (binary.clone(), path_var, Instant::now()));
    Some(binary)
}

/// The cached binary failed to start: look for it again next time.
pub fn forget_binary(engine: Engine) {
    BINARIES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&engine);
}

/// Whether the engine is signed in. A yes is kept for a minute; a no only
/// for a few seconds, so signing in shows up as soon as the editor looks again.
pub async fn signed_in(engine: Engine) -> bool {
    static CACHE: Probe<bool> = LazyLock::new(Default::default);
    let Some(binary) = binary(engine).await else {
        return false;
    };
    // Claude Code's sign-in is checked by its turns. The e2e suite's
    // scripted model needs no account (debug builds only).
    if engine == Engine::Claude || super::codex::scripted() {
        return true;
    }
    if let Some((yes, _, at)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&engine) {
        let keep = if *yes { 60 } else { 5 };
        if at.elapsed() < Duration::from_secs(keep) {
            return *yes;
        }
    }
    let mut cmd = tokio::process::Command::new(binary);
    cmd.args(["login", "status"])
        .env("PATH", crate::utils::get_extended_path());
    let yes = crate::external_command::run_with_timeout(cmd, "codex login status", 15)
        .await
        .is_ok_and(|out| out.status.success());
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(engine, (yes, String::new(), Instant::now()));
    yes
}

pub async fn info(engine: Engine) -> EngineInfo {
    let installed = binary(engine).await.is_some();
    EngineInfo {
        id: engine,
        label: engine.label(),
        installed,
        signed_in: installed && signed_in(engine).await,
        models: models(engine),
    }
}

pub async fn overview() -> Vec<EngineInfo> {
    let (claude, codex) = tokio::join!(info(Engine::Claude), info(Engine::Codex));
    vec![claude, codex]
}

/// Refuse to put an agent on an engine that can't run it, in words.
pub async fn require_ready(engine: Engine) -> Result<(), CommandError> {
    let info = info(engine).await;
    if !info.installed {
        return Err(CommandError::expected(format!(
            "{} isn't installed on this Mac.",
            engine.label()
        )));
    }
    if !info.signed_in {
        return Err(CommandError::expected(format!(
            "{} isn't signed in. Sign in to it first.",
            engine.label()
        )));
    }
    Ok(())
}

/// Claude Code's own aliases, which always mean the current model of that
/// family; Codex's, as Codex itself lists them (see [`super::codex::models`]).
pub fn models(engine: Engine) -> Vec<ModelChoice> {
    match engine {
        Engine::Claude => super::store::MODELS
            .iter()
            .map(|m| ModelChoice {
                value: m.to_string(),
                label: m[..1].to_uppercase() + &m[1..],
            })
            .collect(),
        Engine::Codex => super::codex::models(),
    }
}

/// A model for this engine: empty is the engine's own default; anything
/// else must be one it offers. It becomes a CLI argument, so nothing else
/// gets through.
pub fn normalize_model(engine: Engine, model: &str) -> Result<Option<String>, CommandError> {
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    let offered = models(engine);
    if offered.iter().any(|m| m.value == model) {
        return Ok(Some(model.to_string()));
    }
    let names: Vec<&str> = offered.iter().map(|m| m.label.as_str()).collect();
    Err(super::err_invalid(
        "model",
        if names.is_empty() {
            format!(
                "{} has no models to pick from yet; use Default.",
                engine.label()
            )
        } else {
            format!("Pick {} or Default.", names.join(", "))
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engines_are_stored_as_plain_words_and_read_leniently() {
        assert_eq!(serde_json::to_string(&Engine::Codex).unwrap(), "\"codex\"");
        assert_eq!(Engine::default(), Engine::Claude);
        assert_eq!(Engine::parse(" Codex ").unwrap(), Engine::Codex);
        assert_eq!(Engine::parse("claude-code").unwrap(), Engine::Claude);
        assert!(Engine::parse("gpt").is_err());
    }

    #[test]
    fn a_claude_model_is_only_ever_one_of_its_aliases() {
        assert_eq!(normalize_model(Engine::Claude, "").unwrap(), None);
        assert_eq!(
            normalize_model(Engine::Claude, "haiku").unwrap().as_deref(),
            Some("haiku")
        );
        assert!(normalize_model(Engine::Claude, "--dangerously-skip-permissions").is_err());
        assert!(normalize_model(Engine::Codex, "opus").is_err());
    }
}
