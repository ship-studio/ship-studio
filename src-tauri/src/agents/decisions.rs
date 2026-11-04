//! Questions a project session can't answer itself, put to the user as a card.
//!
//! An agent works on a project through its sessions (`sessions.rs`). When one
//! of them stops on a question — Claude Code's "Do you trust the files in
//! this folder?", a permission prompt, any menu `agent_state.rs` recognises —
//! only the user may answer it. It used to be asked in the agent's chat, and
//! only a reply *there* counted, so a "yes" given to the Chief of Staff, who
//! had delegated the work, didn't: the user had to go and find the right chat.
//!
//! Now Ship Studio raises a real card with the prompt's own text and options:
//!
//! - in the chat of the agent whose session it is, and in the chat the work
//!   came from (the agent that delegated it, up the chain to whoever the user
//!   asked) or the one the user has open. One card, the same request id in
//!   each chat; answering it anywhere answers it everywhere.
//! - Answering sends that option's keys to the session, through the same
//!   writes as the remote's `press_key`. Agents can't press them while a
//!   question is up (`sessions.rs`): the card is the only way to answer.
//! - Folder trust gets one card per project. Allow records the trust the way
//!   Claude Code does when you accept its dialog (below), so that project
//!   never asks again. Nothing is trusted without the card.
//!
//! The agent's tool call waits on the card the way `approve` does, so an
//! answer within the wait carries straight on; a later one wakes the agent.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::mcp;
use super::runner::{self, Status};
use super::store::{self, AgentRef, Approval, ApprovalStatus, MessageKind};
use crate::errors::CommandError;
use crate::remote_access::agent_state::HIGHLIGHTED;
use crate::remote_access::tools::{self as shared, Decision, Outcome};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PromptKind {
    /// Claude Code's first-run "Do you trust the files in this folder?".
    Trust,
    /// "Do you want to proceed?" over a command, an edit, a fetch.
    Permission,
    /// Any other menu or y/n question.
    Choice,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Allow,
    Deny,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptOption {
    /// As the session shows it, without its number ("Yes, I trust this folder").
    pub label: String,
    /// What picks it: key names from `tools::key_bytes`.
    pub keys: Vec<String>,
    pub role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPrompt {
    pub kind: PromptKind,
    pub project: String,
    pub session_id: String,
    /// The tab's number in the project when it asked ("Claude Code 1").
    pub tab: usize,
    pub question: String,
    pub options: Vec<PromptOption>,
    /// The agent whose session it is.
    pub owner: AgentRef,
    /// Every chat holding this card, the owner's first.
    pub chats: Vec<String>,
}

// ============================================================================
// Reading the question
// ============================================================================

/// The options a card offers, with the keys that pick each one. Numbered
/// options are picked by their number; an unnumbered menu (the trust dialog)
/// by arrowing from the highlighted one, then Enter; a bare y/n by y or n.
pub fn options_for(question: &str, raw: &[String]) -> Vec<PromptOption> {
    let lower = question.to_lowercase();
    if raw.is_empty() && (lower.contains("(y/n)") || lower.contains("[y/n]")) {
        return vec![
            PromptOption {
                label: "Yes".into(),
                keys: vec!["y".into()],
                role: Role::Allow,
            },
            PromptOption {
                label: "No".into(),
                keys: vec!["n".into()],
                role: Role::Deny,
            },
        ];
    }
    let highlighted = raw.iter().position(|o| o.ends_with(HIGHLIGHTED));
    let mut options: Vec<PromptOption> = raw
        .iter()
        .enumerate()
        .map(|(i, option)| {
            let option = option.trim_end_matches(HIGHLIGHTED);
            let numbered = option.split_once(". ").filter(|(n, _)| {
                !n.is_empty() && n.len() <= 2 && n.chars().all(|c| c.is_ascii_digit())
            });
            let (label, keys) = match (numbered, highlighted) {
                (Some((n, label)), _) => (label, vec![n.to_string()]),
                (None, Some(h)) => {
                    let arrow = if i >= h { "down" } else { "up" };
                    let mut keys = vec![arrow.to_string(); i.abs_diff(h)];
                    keys.push("enter".into());
                    (option, keys)
                }
                (None, None) => (option, Vec::new()),
            };
            PromptOption {
                label: label.trim().to_string(),
                keys,
                role: Role::Other,
            }
        })
        .filter(|o| !o.keys.is_empty())
        .collect();
    // The first "Yes…" allows and the first "No…" declines; the variants
    // ("Yes, and always allow …") stay choices of their own.
    let starts = |o: &PromptOption, word: &str| {
        let l = o.label.to_lowercase();
        l == word || l.starts_with(&format!("{word},")) || l.starts_with(&format!("{word} "))
    };
    if let Some(o) = options.iter_mut().find(|o| starts(o, "yes")) {
        o.role = Role::Allow;
    }
    if let Some(o) = options.iter_mut().find(|o| starts(o, "no")) {
        o.role = Role::Deny;
    }
    options
}

pub fn kind_of(question: &str, options: &[PromptOption]) -> PromptKind {
    let lower = question.to_lowercase();
    if options
        .iter()
        .any(|o| o.label.to_lowercase().contains("trust this folder"))
    {
        PromptKind::Trust
    } else if lower.starts_with("do you want")
        || lower.starts_with("allow ")
        || lower.contains("would you like to proceed")
    {
        PromptKind::Permission
    } else {
        PromptKind::Choice
    }
}

/// The card for a question: its own words, and who is asking.
pub(crate) fn card(
    request_id: String,
    project: &str,
    outcome: &Outcome,
    decision: &Decision,
    owner: AgentRef,
    chats: Vec<String>,
) -> Approval {
    let options = options_for(&decision.question, &decision.options);
    let kind = kind_of(&decision.question, &options);
    let name = shared::project_name(project);
    let (title, detail) = match kind {
        PromptKind::Trust => (
            format!("Let Claude Code work in {name}?"),
            format!("Claude Code asks once per folder before it reads, edits and runs files in it. Allow, and {name} stays trusted, the way Claude Code records it when you accept its own dialog."),
        ),
        _ => (decision.question.clone(), decision.body.join("\n")),
    };
    Approval {
        request_id,
        title,
        detail,
        status: ApprovalStatus::Pending,
        tool: None,
        input: None,
        always: None,
        always_allowed: false,
        note: None,
        prompt: Some(SessionPrompt {
            kind,
            project: project.to_string(),
            session_id: outcome.session_id.clone(),
            tab: outcome.tab,
            question: decision.question.clone(),
            options,
            owner,
            chats,
        }),
        choice: None,
    }
}

/// Which option an answer means: the one picked, else the card's Allow or
/// Deny. `None` for a Deny on a menu with no "No" (Esc backs out of it).
pub fn pick(prompt: &SessionPrompt, allow: bool, choice: Option<usize>) -> Option<usize> {
    if let Some(i) = choice.filter(|i| *i < prompt.options.len()) {
        return Some(i);
    }
    let role = if allow { Role::Allow } else { Role::Deny };
    prompt.options.iter().position(|o| o.role == role)
}

// ============================================================================
// Where the card goes
// ============================================================================

/// Up the delegation chain from `owner` to the agent the user actually asked:
/// `origin_of` names who handed an agent its current turn. `None` when the
/// owner's own turn came from the user.
pub fn conversation_root(
    owner: &str,
    origin_of: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let mut at = owner.to_string();
    let mut seen = vec![at.clone()];
    while let Some(next) = origin_of(&at) {
        if seen.contains(&next) {
            break;
        }
        seen.push(next.clone());
        at = next;
    }
    (at != owner).then_some(at)
}

/// The owner's chat first, then where the work came from and where the user
/// is, each once.
pub fn chats_for(owner: &str, root: Option<String>, in_view: Option<String>) -> Vec<String> {
    let mut chats = vec![owner.to_string()];
    for id in [root, in_view].into_iter().flatten() {
        if !chats.contains(&id) {
            chats.push(id);
        }
    }
    chats
}

/// The card already up for this question: one per project for folder trust,
/// one per session and question otherwise.
fn open_card(project: &str, outcome: &Outcome, decision: &Decision) -> Option<Approval> {
    let options = options_for(&decision.question, &decision.options);
    let trust = kind_of(&decision.question, &options) == PromptKind::Trust;
    let same = |p: &SessionPrompt| {
        if trust {
            p.kind == PromptKind::Trust && same_path(&p.project, project)
        } else {
            p.session_id == outcome.session_id && p.question == decision.question
        }
    };
    store::list().ok()?.into_iter().find_map(|agent| {
        store::pending_approvals(&agent.id)
            .ok()?
            .into_iter()
            .find(|a| a.prompt.as_ref().is_some_and(same))
    })
}

fn same_path(a: &str, b: &str) -> bool {
    a == b || matches!((dunce::canonicalize(a), dunce::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

// ============================================================================
// Asking
// ============================================================================

/// How a question was settled while the agent waited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settled {
    /// On the card, with this option.
    Answered(String),
    /// In the session itself (the user answered in the tab).
    Gone,
    /// Not within the wait. The card stays live; an answer wakes the agent.
    NotYet,
}

/// Put the question a session is asking in front of the user, and wait.
pub(crate) async fn ask(
    app: &AppHandle,
    caller: &store::Agent,
    project: &str,
    outcome: &Outcome,
) -> Settled {
    let Some(decision) = outcome.decision.as_ref() else {
        return Settled::Gone;
    };
    let approval = match open_card(project, outcome, decision) {
        Some(open) => open,
        None => {
            let root = conversation_root(&caller.id, runner::turn_origin);
            let chats = chats_for(&caller.id, root, super::notify::chat_in_view(app))
                .into_iter()
                .filter(|id| store::get(id).is_ok())
                .collect();
            let owner = AgentRef {
                id: caller.id.clone(),
                name: caller.name.clone(),
            };
            let approval = card(store::new_id(), project, outcome, decision, owner, chats);
            post(app, &approval);
            approval
        }
    };
    let Some(prompt) = approval.prompt.clone() else {
        return Settled::Gone;
    };
    let request_id = approval.request_id;

    let before = runner::status_of(&caller.id);
    runner::set_status(
        app,
        &caller.id,
        Status {
            state: "waiting",
            activity: Some("Waiting for your OK".into()),
            since: before.since,
        },
    );
    let mut rx = mcp::register_waiter(&request_id);
    let deadline = tokio::time::Instant::now() + mcp::approval_wait();
    let settled = loop {
        tokio::select! {
            answer = &mut rx => {
                break match answer {
                    Ok(_) => store::find_approval(&caller.id, &request_id)
                        .ok()
                        .flatten()
                        .and_then(|a| a.choice)
                        .map(Settled::Answered)
                        .unwrap_or(Settled::Gone),
                    // Another call took over the wait for this card.
                    Err(_) => Settled::NotYet,
                };
            }
            _ = tokio::time::sleep(Duration::from_secs(2)) => {
                let still = shared::asking_now(&prompt.session_id)
                    .is_some_and(|d| d.question == prompt.question);
                if !still {
                    settle_everywhere(app, &prompt, &request_id, ApprovalStatus::Expired, None);
                    break Settled::Gone;
                }
                if tokio::time::Instant::now() >= deadline {
                    break Settled::NotYet;
                }
            }
        }
    };
    mcp::drop_waiter(&request_id);
    if runner::status_of(&caller.id).state == "waiting" {
        runner::set_status(
            app,
            &caller.id,
            Status {
                state: "working",
                activity: None,
                since: before.since,
            },
        );
    }
    settled
}

/// The card, in every chat it belongs in. It is announced once: the other
/// copies count as "Needs your OK" without a second notification.
fn post(app: &AppHandle, approval: &Approval) {
    let chats = approval
        .prompt
        .as_ref()
        .map(|p| p.chats.clone())
        .unwrap_or_default();
    for (i, chat) in chats.iter().enumerate() {
        let mut message = runner::new_message(chat, MessageKind::Approval, "");
        message.approval = Some(approval.clone());
        let _ = if i == 0 {
            runner::record(app, message)
        } else {
            runner::record_quietly(app, message)
        };
        store::refresh_pending(chat);
    }
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
}

/// Resolve the card in every chat that holds it; returns the copies changed.
pub fn resolve_all(
    prompt: &SessionPrompt,
    request_id: &str,
    status: ApprovalStatus,
    choice: Option<&str>,
) -> Vec<store::AgentMessage> {
    prompt
        .chats
        .iter()
        .filter_map(|chat| {
            let updated = match choice {
                Some(c) => store::answer_prompt(chat, request_id, status, c),
                None => store::set_approval_status(chat, request_id, status),
            };
            updated.ok().flatten()
        })
        .collect()
}

fn settle_everywhere(
    app: &AppHandle,
    prompt: &SessionPrompt,
    request_id: &str,
    status: ApprovalStatus,
    choice: Option<&str>,
) {
    for message in resolve_all(prompt, request_id, status, choice) {
        let _ = app.emit(runner::EVENT_MESSAGE, &message);
    }
    let _ = app.emit(runner::EVENT_REGISTRY, ());
    super::notify::refresh_badge(app);
}

/// What answering a card does, decided before anything is touched.
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub label: String,
    pub keys: Vec<String>,
    pub status: ApprovalStatus,
    /// Record the project as trusted first: only an Allow on a trust card.
    pub trust: bool,
}

pub fn plan(prompt: &SessionPrompt, allow: bool, choice: Option<usize>) -> Plan {
    let (label, keys, status) = match pick(prompt, allow, choice).map(|i| &prompt.options[i]) {
        Some(o) => (
            o.label.clone(),
            o.keys.clone(),
            if o.role == Role::Deny {
                ApprovalStatus::Denied
            } else {
                ApprovalStatus::Allowed
            },
        ),
        None => (
            "Cancelled".to_string(),
            vec!["escape".to_string()],
            ApprovalStatus::Denied,
        ),
    };
    let trust = prompt.kind == PromptKind::Trust && status == ApprovalStatus::Allowed;
    Plan {
        label,
        keys,
        status,
        trust,
    }
}

// ============================================================================
// Answering
// ============================================================================

/// The user answered a session-prompt card (in any chat holding it): send the
/// option's keys, record the trust if that's what was allowed, resolve every
/// copy, and hand the answer to whoever is waiting — or wake the owner.
/// Blocking (it writes to the PTY a beat apart).
pub fn answer(
    app: &AppHandle,
    approval: &Approval,
    allow: bool,
    choice: Option<usize>,
) -> Result<(), CommandError> {
    let Some(prompt) = approval.prompt.as_ref() else {
        return Err(CommandError::expected("That isn't a session's question."));
    };
    let request_id = approval.request_id.as_str();
    let asking = shared::asking_now(&prompt.session_id);
    if asking.as_ref().map(|d| d.question.as_str()) != Some(prompt.question.as_str()) {
        settle_everywhere(app, prompt, request_id, ApprovalStatus::Expired, None);
        return Err(CommandError::expected(
            "The session isn't asking that any more.",
        ));
    }
    let Plan {
        label,
        keys,
        status,
        trust: trusting,
    } = plan(prompt, allow, choice);
    let allowed = status == ApprovalStatus::Allowed;
    if trusting {
        let config = claude_config()
            .ok_or_else(|| CommandError::expected("Couldn't find your home folder."))?;
        trust(&config, Path::new(&prompt.project)).map_err(|e| {
            CommandError::expected(format!(
                "Couldn't record {} as trusted: {e}",
                shared::project_name(&prompt.project)
            ))
        })?;
    }
    shared::press_keys(&prompt.session_id, &keys).map_err(CommandError::expected)?;
    // One card per project: other sessions there stopped on the same dialog
    // go through with it.
    if trusting {
        for other in shared::live_agent_sessions(&prompt.project) {
            if other == prompt.session_id {
                continue;
            }
            let Some(d) = shared::asking_now(&other) else {
                continue;
            };
            let options = options_for(&d.question, &d.options);
            if kind_of(&d.question, &options) != PromptKind::Trust {
                continue;
            }
            if let Some(o) = options.iter().find(|o| o.role == Role::Allow) {
                let _ = shared::press_keys(&other, &o.keys);
            }
        }
    }
    settle_everywhere(app, prompt, request_id, status, Some(&label));

    if !mcp::answer_approval(request_id, allowed) {
        let name = shared::project_name(&prompt.project);
        runner::enqueue(
            app,
            &prompt.owner.id,
            format!(
                "[The user answered the question your session in {name} (tab {}) was waiting on, on the card: “{label}”. Call session_wait for {name} to follow it, then tell them how it went.]",
                prompt.tab
            ),
            runner::From::User,
        );
    }
    Ok(())
}

// ============================================================================
// Folder trust, as Claude Code records it
// ============================================================================

/// Claude Code's own settings file: `$CLAUDE_CONFIG_DIR/.claude.json`, else
/// `~/.claude.json`.
pub fn claude_config() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir).join(".claude.json")),
        None => dirs::home_dir().map(|h| h.join(".claude.json")),
    }
}

/// Record `project` as trusted the way Claude Code 2.1 does when you accept
/// its dialog: `projects["<real path>"].hasTrustDialogAccepted = true` in
/// its settings file. Observed with 2.1.318 in a throwaway HOME: accepting
/// writes exactly that key under the canonical path (`/private/tmp/…` for a
/// folder reached through `/tmp`), and a file holding only that key is
/// enough for the dialog not to show. Everything else in the file is kept;
/// a file that isn't JSON is left alone.
pub fn trust(config: &Path, project: &Path) -> Result<(), String> {
    let key = dunce::canonicalize(project)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    let mut root: Value = match std::fs::read_to_string(config) {
        Ok(raw) if raw.trim().is_empty() => json!({}),
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|_| format!("{} isn't valid JSON", config.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e.to_string()),
    };
    let Some(top) = root.as_object_mut() else {
        return Err(format!("{} isn't a JSON object", config.display()));
    };
    let projects = top.entry("projects").or_insert_with(|| json!({}));
    if !projects.is_object() {
        *projects = json!({});
    }
    let entry = projects
        .as_object_mut()
        .map(|p| p.entry(key).or_insert_with(|| json!({})));
    match entry {
        Some(e) if e.is_object() => e["hasTrustDialogAccepted"] = json!(true),
        Some(e) => *e = json!({ "hasTrustDialogAccepted": true }),
        None => return Err("unexpected settings shape".into()),
    }
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    // Replace the file in one step: Claude Code reads it on every start.
    let tmp = config.with_extension(format!("json.shipstudio-{}", store::new_id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    if let Ok(meta) = std::fs::metadata(config) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, config).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Whether Claude Code would skip the dialog for `project`: it, or a folder
/// above it, is recorded as trusted.
pub fn trusted(config: &Path, project: &Path) -> bool {
    let Ok(root) = std::fs::read_to_string(config)
        .map_err(|_| ())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).map_err(|_| ()))
    else {
        return false;
    };
    let Ok(path) = dunce::canonicalize(project) else {
        return false;
    };
    path.ancestors().any(|dir| {
        root.pointer("/projects")
            .and_then(|p| p.get(dir.to_string_lossy().as_ref()))
            .and_then(|p| p.get("hasTrustDialogAccepted"))
            .and_then(Value::as_bool)
            == Some(true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn outcome(decision: Decision) -> Outcome {
        Outcome {
            session_id: "s1".into(),
            tab: 1,
            cli: "claude".into(),
            state: "needs_decision",
            reply: Vec::new(),
            decision: Some(decision),
        }
    }

    fn owner() -> AgentRef {
        AgentRef {
            id: "site".into(),
            name: "Site Builder".into(),
        }
    }

    #[test]
    fn what_a_session_draws_is_what_the_card_offers() {
        use crate::remote_access::agent_state::{awaiting_choice_detail, classify, AgentState};
        // Claude Code 2.1.318's folder-trust dialog, recorded in a fresh HOME.
        let screen = raw(&[
            " Accessing workspace:",
            "",
            " /Users/a/ShipStudio/demo-site",
            "",
            " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
            " project, or work from your team). If not, take a moment to review what's in this folder first.",
            "",
            " Claude Code'll be able to read, edit, and execute files here.",
            "",
            " ❯ No, exit",
            "   Yes, I trust this folder",
            "",
            " Enter to confirm · Esc to cancel",
        ]);
        assert!(matches!(
            classify(&screen, true, 6_000),
            AgentState::NeedsDecision { .. }
        ));
        let (question, options) = awaiting_choice_detail(&screen).unwrap();
        let options = options_for(&question, &options);
        assert_eq!(kind_of(&question, &options), PromptKind::Trust);
        assert_eq!(options[1].keys, vec!["down", "enter"]);
        // A permission prompt, as recorded.
        let screen = raw(&[
            "⏺ Update(index.html)",
            "────────────────────────────────────────",
            " Edit file",
            " index.html",
            " Do you want to make this edit to index.html?",
            " ❯ 1. Yes",
            "   2. Yes, allow all edits during this session (shift+tab)",
            "   3. No, and tell Claude what to do differently (esc)",
        ]);
        let (question, options) = awaiting_choice_detail(&screen).unwrap();
        let options = options_for(&question, &options);
        assert_eq!(kind_of(&question, &options), PromptKind::Permission);
        assert_eq!(
            options.iter().map(|o| o.role).collect::<Vec<_>>(),
            vec![Role::Allow, Role::Other, Role::Deny]
        );
        assert_eq!(options[2].keys, vec!["3"]);
    }

    #[test]
    fn the_trust_dialog_becomes_one_allow_card_that_arrows_down_to_yes() {
        let decision = Decision {
            question: "Quick safety check: Is this a project you created or one you trust?".into(),
            options: raw(&[
                &format!("No, exit{HIGHLIGHTED}"),
                "Yes, I trust this folder",
            ]),
            body: Vec::new(),
        };
        let card = card(
            "r1".into(),
            "/Users/a/ShipStudio/demo-site",
            &outcome(decision.clone()),
            &decision,
            owner(),
            vec!["site".into(), "chief".into()],
        );
        assert_eq!(card.title, "Let Claude Code work in demo-site?");
        let prompt = card.prompt.as_ref().unwrap();
        assert_eq!(prompt.kind, PromptKind::Trust);
        assert_eq!(
            prompt.options,
            vec![
                PromptOption {
                    label: "No, exit".into(),
                    keys: vec!["enter".into()],
                    role: Role::Deny
                },
                PromptOption {
                    label: "Yes, I trust this folder".into(),
                    keys: vec!["down".into(), "enter".into()],
                    role: Role::Allow
                },
            ]
        );
        assert_eq!(pick(prompt, true, None), Some(1));
        assert_eq!(pick(prompt, false, None), Some(0));
        // Never offered as "Always allow": no tool call behind it.
        assert!(card.always.is_none() && card.tool.is_none());
    }

    #[test]
    fn a_permission_prompt_keeps_its_text_and_every_option() {
        let decision = Decision {
            question: "Do you want to proceed?".into(),
            options: raw(&[
                "1. Yes",
                "2. Yes, and always allow access to /Users/a/ShipStudio/bakery -site from this project",
                "3. No",
            ]),
            body: raw(&["Bash command", "touch made-by-bash.txt"]),
        };
        let card = card(
            "r2".into(),
            "/p/bakery",
            &outcome(decision.clone()),
            &decision,
            owner(),
            vec!["site".into()],
        );
        assert_eq!(card.title, "Do you want to proceed?");
        assert_eq!(card.detail, "Bash command\ntouch made-by-bash.txt");
        let prompt = card.prompt.unwrap();
        assert_eq!(prompt.kind, PromptKind::Permission);
        let roles: Vec<_> = prompt
            .options
            .iter()
            .map(|o| (o.label.as_str(), o.keys[0].as_str(), o.role))
            .collect();
        assert_eq!(roles[0], ("Yes", "1", Role::Allow));
        assert_eq!(roles[1].1, "2");
        assert_eq!(roles[1].2, Role::Other);
        assert_eq!(roles[2], ("No", "3", Role::Deny));
        // A specific choice wins over Allow / Deny.
        assert_eq!(pick(&prompt, true, Some(1)), Some(1));
        assert_eq!(pick(&prompt, true, Some(9)), Some(0));
    }

    fn trust_prompt() -> SessionPrompt {
        let decision = Decision {
            question: "Quick safety check: Is this a project you created or one you trust?".into(),
            options: raw(&[
                &format!("No, exit{HIGHLIGHTED}"),
                "Yes, I trust this folder",
            ]),
            body: Vec::new(),
        };
        card(
            "r1".into(),
            "/p/demo-site",
            &outcome(decision.clone()),
            &decision,
            owner(),
            vec!["site".into(), "chief".into()],
        )
        .prompt
        .unwrap()
    }

    #[test]
    fn trust_is_recorded_only_on_allow() {
        let prompt = trust_prompt();
        let allow = plan(&prompt, true, None);
        assert!(allow.trust);
        assert_eq!(allow.status, ApprovalStatus::Allowed);
        assert_eq!(allow.label, "Yes, I trust this folder");
        assert_eq!(allow.keys, vec!["down", "enter"]);
        let deny = plan(&prompt, false, None);
        assert!(!deny.trust);
        assert_eq!(deny.status, ApprovalStatus::Denied);
        assert_eq!(deny.keys, vec!["enter"]);
        // Picking "No, exit" by index is a Deny too, and trusts nothing.
        assert!(!plan(&prompt, true, Some(0)).trust);
        // Allowing a permission prompt never touches trust.
        let mut permission = prompt.clone();
        permission.kind = PromptKind::Permission;
        assert!(!plan(&permission, true, None).trust);
    }

    #[test]
    fn answering_in_either_chat_resolves_both() {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        let new = |name: &str| store::NewAgent {
            name: name.into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        };
        let site = store::create(new("Site Builder")).unwrap();
        let chief = store::create(new("Chief")).unwrap();
        for answered_in in [0usize, 1] {
            let mut prompt = trust_prompt();
            prompt.chats = vec![site.id.clone(), chief.id.clone()];
            let request_id = store::new_id();
            let mut approval = card(
                request_id.clone(),
                "/p/demo-site",
                &outcome(Decision {
                    question: prompt.question.clone(),
                    options: Vec::new(),
                    body: Vec::new(),
                }),
                &Decision {
                    question: prompt.question.clone(),
                    options: Vec::new(),
                    body: Vec::new(),
                },
                owner(),
                prompt.chats.clone(),
            );
            approval.prompt = Some(prompt.clone());
            for chat in &prompt.chats {
                let mut m = runner::new_message(chat, MessageKind::Approval, "");
                m.approval = Some(approval.clone());
                store::append_message(&m).unwrap();
                store::refresh_pending(chat);
            }
            assert_eq!(store::get(&chief.id).unwrap().pending_approvals, 1);
            // The command looks the card up in the chat it was answered in.
            let found = store::find_approval(&prompt.chats[answered_in], &request_id)
                .unwrap()
                .unwrap();
            let p = found.prompt.unwrap();
            let changed = resolve_all(
                &p,
                &request_id,
                ApprovalStatus::Allowed,
                Some("Yes, I trust this folder"),
            );
            assert_eq!(changed.len(), 2);
            for chat in [&site.id, &chief.id] {
                let a = store::find_approval(chat, &request_id).unwrap().unwrap();
                assert_eq!(a.status, ApprovalStatus::Allowed);
                assert_eq!(a.choice.as_deref(), Some("Yes, I trust this folder"));
                assert_eq!(store::get(chat).unwrap().pending_approvals, 0);
            }
            // A second answer, from the other chat, changes nothing.
            assert!(
                resolve_all(&p, &request_id, ApprovalStatus::Denied, Some("No, exit")).is_empty()
            );
        }
        store::set_root_for_tests(None);
    }

    #[test]
    fn other_questions_are_choices() {
        let yn = options_for("Overwrite file? (y/n)", &[]);
        assert_eq!(yn[0].keys, vec!["y"]);
        assert_eq!(yn[1].role, Role::Deny);
        assert_eq!(kind_of("Overwrite file? (y/n)", &yn), PromptKind::Choice);
        let menu = options_for(
            "choose an option",
            &raw(&["1. Opus", "2. Sonnet", &format!("Later{HIGHLIGHTED}")]),
        );
        assert!(menu.iter().all(|o| o.role == Role::Other));
        // No "No" to pick: Deny backs out with Esc.
        let prompt = SessionPrompt {
            kind: PromptKind::Choice,
            project: "/p".into(),
            session_id: "s".into(),
            tab: 1,
            question: "choose an option".into(),
            options: menu,
            owner: owner(),
            chats: vec!["site".into()],
        };
        assert_eq!(pick(&prompt, false, None), None);
    }

    #[test]
    fn the_card_also_goes_where_the_work_came_from_and_where_the_user_is() {
        // Chief → Site Builder: the Chief's chat is where the user asked.
        let origins = |id: &str| match id {
            "site" => Some("chief".to_string()),
            _ => None,
        };
        assert_eq!(conversation_root("site", origins), Some("chief".into()));
        assert_eq!(
            chats_for("site", Some("chief".into()), Some("chief".into())),
            vec!["site", "chief"]
        );
        // The user asked Site Builder directly, in its own chat: one card.
        assert_eq!(conversation_root("site", |_| None), None);
        assert_eq!(chats_for("site", None, Some("site".into())), vec!["site"]);
        // Two hops, and a loop never spins.
        let chain = |id: &str| match id {
            "a" => Some("b".to_string()),
            "b" => Some("chief".to_string()),
            _ => None,
        };
        assert_eq!(conversation_root("a", chain), Some("chief".into()));
        let looped = |id: &str| Some(if id == "a" { "b" } else { "a" }.to_string());
        assert_eq!(conversation_root("a", looped), Some("b".into()));
    }

    #[test]
    fn trust_is_written_the_way_claude_code_writes_it_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("demo-site");
        std::fs::create_dir(&project).unwrap();
        let config = dir.path().join(".claude.json");
        std::fs::write(
            &config,
            r#"{"oauthAccount":{"email":"a@b.c"},"projects":{"/elsewhere":{"allowedTools":["Bash"]}}}"#,
        )
        .unwrap();
        assert!(!trusted(&config, &project));
        trust(&config, &project).unwrap();
        assert!(trusted(&config, &project));
        // Folders inside a trusted one are trusted too, as Claude Code has it.
        let inner = project.join("app");
        std::fs::create_dir(&inner).unwrap();
        assert!(trusted(&config, &inner));
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        let key = dunce::canonicalize(&project).unwrap();
        assert_eq!(
            written["projects"][key.to_string_lossy().as_ref()]["hasTrustDialogAccepted"],
            true
        );
        assert_eq!(written["oauthAccount"]["email"], "a@b.c");
        assert_eq!(written["projects"]["/elsewhere"]["allowedTools"][0], "Bash");
        // A file that isn't JSON is never overwritten.
        std::fs::write(&config, "{ not json").unwrap();
        assert!(trust(&config, &project).is_err());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "{ not json");
        // No file yet: created.
        let fresh = dir.path().join("fresh.json");
        trust(&fresh, &project).unwrap();
        assert!(trusted(&fresh, &project));
    }
}
