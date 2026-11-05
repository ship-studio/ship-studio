//! Secrets an agent asked the user for (`request_secret`).
//!
//! The agent never sees a value. It asks; the user types it into a masked card
//! in its chat; the value goes from the webview straight into the macOS
//! Keychain, under a service of that agent's own (`ship-studio-agent-<id>`),
//! one item per environment variable. The agent gets back only a reference
//! (`secret:finance/stripe_key`) and the variable's name.
//!
//! **How it's used: environment variables, not substitution.** Every turn is
//! a fresh `claude` process, so each turn of *that* agent (no other) is
//! started with its secrets in its environment: `curl -H "Authorization:
//! Bearer $STRIPE_KEY"` works in Bash, and so does any script or SDK that reads
//! the environment. A `use_secret` tool that substitutes into an approved
//! command would need our own command runner beside Claude Code's, its own
//! approval and output handling, and would still hand the command's output
//! (which may echo the value) back to the agent: more code, the same exposure.
//! The approval card for a command shows `$STRIPE_KEY`, unexpanded.
//!
//! **Redaction** is the defence in depth: every value this run knows (loaded
//! at launch, and whenever one is saved or handed to a turn) is replaced by
//! `[secret:…]` in everything Agents persists or shows: the chat log, card
//! answers, the queue, drafts as they stream, the activity line, the prompt
//! the next turn gets, and the audit log. Values under [`MIN_REDACT`]
//! characters aren't scrubbed (they'd match ordinary words).
//!
//! What this can't cover: a turn that prints the variable sends it to Claude
//! as tool output, and Claude Code's own transcript (`~/.claude/projects`)
//! keeps it. The prompt tells agents never to print one.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::sync::{LazyLock, RwLock};

use super::store::{self, Agent, AgentMessage, ApprovalStatus};
use crate::errors::CommandError;

/// Shorter values aren't scrubbed: they'd hit ordinary text.
pub const MIN_REDACT: usize = 6;
const MAX_VALUE: usize = 16 * 1024;
const MAX_FIELDS: usize = 5;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Password,
    ApiKey,
    Token,
    Other,
}

impl Kind {
    fn parse(s: &str) -> Option<Kind> {
        serde_json::from_value(Value::String(s.to_string())).ok()
    }

    fn label(self) -> &'static str {
        match self {
            Kind::Password => "Password",
            Kind::ApiKey => "API key",
            Kind::Token => "Token",
            Kind::Other => "Value",
        }
    }
}

/// One masked input, and the variable it becomes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub label: String,
    pub env: String,
}

/// What the agent asked for, carried on its approval card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub name: String,
    pub purpose: String,
    pub kind: Kind,
    pub fields: Vec<Field>,
    pub reference: String,
}

/// A saved secret, on the agent's registry entry. Never its value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub kind: Kind,
    pub fields: Vec<Field>,
    pub reference: String,
    pub created_at: i64,
    /// The last turn started with it in its environment. Whether the agent
    /// read it isn't known, and isn't claimed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/* ---------------------------------------------------------------- vault */

fn service(agent_id: &str) -> String {
    format!("ship-studio-agent-{agent_id}")
}

#[cfg(not(test))]
mod vault {
    use crate::commands::accounts::{keychain_delete, keychain_read, keychain_write};
    use crate::errors::CommandError;
    pub fn put(service: &str, key: &str, value: &str) -> Result<(), CommandError> {
        keychain_write(service, key, value)
    }
    pub fn get(service: &str, key: &str) -> Option<String> {
        keychain_read(service, key)
    }
    pub fn delete(service: &str, key: &str) {
        keychain_delete(service, key)
    }
}

/// Tests never touch the real Keychain.
#[cfg(test)]
pub(crate) mod vault {
    use crate::errors::CommandError;
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};
    pub static ITEMS: LazyLock<Mutex<HashMap<(String, String), String>>> =
        LazyLock::new(Default::default);
    pub fn put(service: &str, key: &str, value: &str) -> Result<(), CommandError> {
        ITEMS
            .lock()
            .unwrap()
            .insert((service.into(), key.into()), value.into());
        Ok(())
    }
    pub fn get(service: &str, key: &str) -> Option<String> {
        ITEMS
            .lock()
            .unwrap()
            .get(&(service.into(), key.into()))
            .cloned()
    }
    pub fn delete(service: &str, key: &str) {
        ITEMS.lock().unwrap().remove(&(service.into(), key.into()));
    }
}

/* ------------------------------------------------------------ redaction */

/// (value, reference), longest value first so a value containing another is
/// replaced whole.
static KNOWN: LazyLock<RwLock<Vec<(String, String)>>> = LazyLock::new(Default::default);

fn remember(value: &str, reference: &str) {
    if value.chars().count() < MIN_REDACT {
        return;
    }
    let mut known = KNOWN.write().unwrap_or_else(|e| e.into_inner());
    if known.iter().any(|(v, _)| v == value) {
        return;
    }
    known.push((value.to_string(), reference.to_string()));
    known.sort_by_key(|(v, _)| std::cmp::Reverse(v.len()));
}

/// At launch: every saved value, so redaction holds before any turn runs.
pub fn load_known() {
    let Ok(agents) = store::list() else { return };
    for agent in agents {
        for secret in &agent.secrets {
            for field in &secret.fields {
                if let Some(value) = vault::get(&service(&agent.id), &field.env) {
                    remember(&value, &secret.reference);
                }
            }
        }
    }
}

/// `text` with every known value replaced by `[secret:…]`.
pub fn redact(text: &str) -> Cow<'_, str> {
    let known = KNOWN.read().unwrap_or_else(|e| e.into_inner());
    if !known.iter().any(|(v, _)| text.contains(v.as_str())) {
        return Cow::Borrowed(text);
    }
    let mut out = text.to_string();
    for (value, reference) in known.iter() {
        if out.contains(value.as_str()) {
            out = out.replace(value.as_str(), &format!("[{reference}]"));
        }
    }
    Cow::Owned(out)
}

/// Every string in `value`, keys included, redacted in place. Works on the
/// structure, so a replacement can never break the JSON around it.
pub fn redact_value(value: &mut Value) {
    match value {
        Value::String(s) => {
            if let Cow::Owned(clean) = redact(s) {
                *s = clean;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_value),
        Value::Object(map) => {
            let entries = std::mem::take(map);
            for (key, mut item) in entries {
                redact_value(&mut item);
                map.insert(redact(&key).into_owned(), item);
            }
        }
        _ => {}
    }
}

/// A chat message, redacted, before it's written or shown.
pub fn redact_message(message: AgentMessage) -> AgentMessage {
    if KNOWN.read().map(|k| k.is_empty()).unwrap_or(false) {
        return message;
    }
    let Ok(mut value) = serde_json::to_value(&message) else {
        return message;
    };
    redact_value(&mut value);
    serde_json::from_value(value).unwrap_or(message)
}

/* -------------------------------------------------------------- naming */

/// "Stripe key" → "stripe_key". Lower-case letters, digits and `_`, starting
/// with a letter: it becomes an environment variable name.
pub fn slug(raw: &str) -> Option<String> {
    let mut out = String::new();
    for c in raw.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    let out = out.trim_end_matches('_').to_string();
    (out.len() <= 40 && out.starts_with(|c: char| c.is_ascii_lowercase())).then_some(out)
}

/// Variables a secret may not take: ones that change how the shell, Claude
/// Code, the dynamic linker or git behave.
fn reserved(env: &str) -> bool {
    const EXACT: &[&str] = &[
        "PATH",
        "HOME",
        "USER",
        "SHELL",
        "TMPDIR",
        "PWD",
        "LANG",
        "TERM",
        "LOGNAME",
        "IFS",
        "ENV",
        "BASH_ENV",
        "ZDOTDIR",
        "CDPATH",
        "PS4",
        "NODE_OPTIONS",
        "PYTHONPATH",
        "PYTHONSTARTUP",
    ];
    const PREFIXES: &[&str] = &[
        "CLAUDE",
        "ANTHROPIC",
        "MCP_",
        "SHIPSTUDIO",
        "DYLD_",
        "LD_",
        "GIT_",
        "SSH_",
        "XDG_",
        "LC_",
    ];
    EXACT.contains(&env) || PREFIXES.iter().any(|p| env.starts_with(p))
}

/// The request `request_secret` makes, checked, for `agent`.
pub fn build_request(
    agent: &Agent,
    name: &str,
    purpose: &str,
    kind: &str,
    labels: &[String],
) -> Result<Request, CommandError> {
    let invalid = |field: &str, reason: &str| super::err_invalid(field, reason);
    let name = slug(name).ok_or_else(|| {
        invalid(
            "name",
            "Give it a short name of letters, digits and underscores, starting with a letter (stripe_key).",
        )
    })?;
    let purpose = purpose.trim();
    if purpose.is_empty() {
        return Err(invalid(
            "purpose",
            "Say what you'll use it for: the user sees it on the card.",
        ));
    }
    let kind = Kind::parse(kind)
        .ok_or_else(|| invalid("kind", "kind is password, api_key, token or other."))?;
    let base = name.to_ascii_uppercase();
    let fields: Vec<Field> = if labels.is_empty() {
        vec![Field {
            label: kind.label().to_string(),
            env: base.clone(),
        }]
    } else {
        if labels.len() > MAX_FIELDS {
            return Err(invalid("fields", "At most 5 fields."));
        }
        labels
            .iter()
            .map(|label| {
                let part = slug(label)
                    .ok_or_else(|| invalid("fields", "Each field needs a short label."))?;
                Ok(Field {
                    label: label.trim().chars().take(40).collect(),
                    env: format!("{base}_{}", part.to_ascii_uppercase()),
                })
            })
            .collect::<Result<_, CommandError>>()?
    };
    for (i, field) in fields.iter().enumerate() {
        if reserved(&field.env) {
            return Err(invalid(
                "name",
                &format!("${} is reserved. Pick another name.", field.env),
            ));
        }
        if fields[..i].iter().any(|f| f.env == field.env) {
            return Err(invalid("fields", "Two fields have the same label."));
        }
        if let Some(other) = agent
            .secrets
            .iter()
            .find(|s| s.name != name && s.fields.iter().any(|f| f.env == field.env))
        {
            return Err(invalid(
                "name",
                &format!(
                    "${} is already {}. Pick another name.",
                    field.env, other.name
                ),
            ));
        }
    }
    let owner = slug(&agent.name).unwrap_or_else(|| agent.id.clone());
    Ok(Request {
        reference: format!("secret:{owner}/{name}"),
        name,
        purpose: purpose.chars().take(300).collect(),
        kind,
        fields,
    })
}

/* ------------------------------------------------------------- storing */

/// Store the values for `request` and record it on the agent. Replaces a
/// secret of the same name.
fn put(agent_id: &str, request: &Request, values: &[String]) -> Result<Secret, CommandError> {
    if values.len() != request.fields.len() {
        return Err(super::err_invalid("values", "One value for each field."));
    }
    let values: Vec<&str> = values.iter().map(|v| v.trim()).collect();
    for (field, value) in request.fields.iter().zip(&values) {
        if value.is_empty() {
            return Err(CommandError::expected(format!("{} is empty.", field.label)));
        }
        if value.contains(['\n', '\r']) || value.len() > MAX_VALUE {
            return Err(CommandError::expected(format!(
                "{} must be one line, up to 16 KB.",
                field.label
            )));
        }
    }
    let service = service(agent_id);
    for (field, value) in request.fields.iter().zip(&values) {
        vault::put(&service, &field.env, value)?;
        remember(value, &request.reference);
    }
    let secret = Secret {
        id: store::new_id(),
        name: request.name.clone(),
        purpose: request.purpose.clone(),
        kind: request.kind,
        fields: request.fields.clone(),
        reference: request.reference.clone(),
        created_at: store::now_ms(),
        last_used_at: None,
        extra: Default::default(),
    };
    let mut replaced = Vec::new();
    store::update(agent_id, |a| {
        a.secrets.retain(|s| {
            let same = s.name == secret.name;
            if same {
                replaced.extend(s.fields.iter().map(|f| f.env.clone()));
            }
            !same
        });
        a.secrets.push(secret.clone());
    })?;
    // A field the new one doesn't have any more.
    for env in replaced
        .iter()
        .filter(|e| !secret.fields.iter().any(|f| &f.env == *e))
    {
        vault::delete(&service, env);
    }
    Ok(secret)
}

/// The user saved the card `request_id`. Returns the secret and the card,
/// now answered.
pub fn save(
    agent_id: &str,
    request_id: &str,
    values: &[String],
) -> Result<(Secret, Option<AgentMessage>), CommandError> {
    let approval = store::find_approval(agent_id, request_id)?
        .ok_or_else(|| CommandError::expected("That request no longer exists."))?;
    let Some(request) = approval.secret.as_ref() else {
        return Err(CommandError::expected(
            "That card isn't asking for a secret.",
        ));
    };
    if approval.status != ApprovalStatus::Pending {
        return Err(CommandError::expected("That request was already answered."));
    }
    let secret = put(agent_id, request, values)?;
    let card = store::set_approval_status(agent_id, request_id, ApprovalStatus::Allowed)?;
    store::refresh_pending(agent_id);
    Ok((secret, card))
}

/// The user offered one themselves (they'd pasted it in the composer).
pub fn add(agent_id: &str, name: &str, kind: &str, value: &str) -> Result<Secret, CommandError> {
    let agent = store::get(agent_id)?;
    let request = build_request(&agent, name, "Saved from the chat", kind, &[])?;
    put(agent_id, &request, &[value.to_string()])
}

/// Delete it from the Keychain and from the agent.
pub fn revoke(agent_id: &str, secret_id: &str) -> Result<(), CommandError> {
    let agent = store::get(agent_id)?;
    let Some(secret) = agent.secrets.iter().find(|s| s.id == secret_id) else {
        return Err(CommandError::expected("That secret is already gone."));
    };
    for field in &secret.fields {
        vault::delete(&service(agent_id), &field.env);
    }
    store::update(agent_id, |a| a.secrets.retain(|s| s.id != secret_id))?;
    Ok(())
}

/// The agent is being deleted: its Keychain items go with it.
pub fn forget_all(agent: &Agent) {
    for field in agent.secrets.iter().flat_map(|s| &s.fields) {
        vault::delete(&service(&agent.id), &field.env);
    }
}

/// What a turn of `agent` is started with: each variable and its value, for
/// this agent only. A value the Keychain no longer has is left out (and so
/// is its line in the prompt).
pub fn env_for(agent: &Agent) -> Vec<(String, String)> {
    let service = service(&agent.id);
    let mut env = Vec::new();
    let mut used = Vec::new();
    for secret in &agent.secrets {
        for field in &secret.fields {
            if let Some(value) = vault::get(&service, &field.env) {
                remember(&value, &secret.reference);
                env.push((field.env.clone(), value));
                used.push(secret.id.clone());
            }
        }
    }
    if !used.is_empty() {
        let now = store::now_ms();
        let _ = store::update(&agent.id, |a| {
            for s in a.secrets.iter_mut().filter(|s| used.contains(&s.id)) {
                s.last_used_at = Some(now);
            }
        });
    }
    env
}

/* ------------------------------------------------------------ prompts */

pub const RULES: &str = "\
## Secrets

When you need a password, API key, token or login, ask with `request_secret`: \
the user types it into a secure card here, it goes into the macOS Keychain, \
and you get an environment variable, never the value. Never ask the user to \
paste a credential in chat. Use a secret only through its variable \
(`\"$STRIPE_KEY\"` in a command, or read from the environment in a script). \
Never print, echo, log or write one to a file, and never put it in a message.";

/// The secrets this turn has, by variable. Empty when it has none.
pub fn prompt_section(agent: &Agent, env: &[(String, String)]) -> String {
    let lines: Vec<String> = agent
        .secrets
        .iter()
        .filter_map(|s| {
            let vars: Vec<String> = s
                .fields
                .iter()
                .filter(|f| env.iter().any(|(k, _)| k == &f.env))
                .map(|f| format!("${}", f.env))
                .collect();
            (!vars.is_empty()).then(|| {
                format!(
                    "- {} ({}): {} — {}",
                    s.name,
                    s.reference,
                    vars.join(", "),
                    s.purpose
                )
            })
        })
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "### Secrets you have\n\nIn your environment this turn:\n\n{}",
        lines.join("\n")
    )
}

/// What the agent is told when the user saves its request.
pub fn saved_prompt(secret: &Secret) -> String {
    let vars: Vec<String> = secret
        .fields
        .iter()
        .map(|f| format!("${}", f.env))
        .collect();
    format!(
        "[The user saved {} ({}). It's in your environment from this turn on as {}. Carry on with what you needed it for. Use it only through the variable; never print it.]",
        secret.name,
        secret.reference,
        vars.join(", ")
    )
}

/// What the agent is told when the user declines.
pub fn denied_prompt(request: &Request, note: Option<&str>) -> String {
    let said = note
        .map(|n| format!(" They said: \"{n}\". Do that instead."))
        .unwrap_or_else(|| " Don't ask for it again unless they bring it up; carry on without it, or tell them in one line what you can't do without it.".to_string());
    format!(
        "[The user declined to give you {} ({}).{said}]",
        request.name, request.purpose
    )
}

/// The tool's answer once the card is in the chat.
pub fn asked_reply(request: &Request) -> String {
    let vars: Vec<String> = request
        .fields
        .iter()
        .map(|f| format!("${}", f.env))
        .collect();
    format!(
        "Asked the user for {} in a secure card in this chat. Stop here and tell them in one short line what it's for. When they save it you'll be woken, and from then on your turns have it in {} (reference {}). You'll never see the value: use the variable, and never print it. If they decline, you'll be told.",
        request.name,
        vars.join(", "),
        request.reference
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::store::{AgentRef, Approval, MessageKind, NewAgent};

    fn with_root<F: FnOnce(&std::path::Path)>(f: F) {
        let _serial = store::tests_lock();
        let dir = tempfile::tempdir().unwrap();
        store::set_root_for_tests(Some(dir.path().to_path_buf()));
        f(dir.path());
        store::set_root_for_tests(None);
    }

    fn agent(name: &str) -> Agent {
        store::create(NewAgent {
            name: name.into(),
            role: String::new(),
            instructions: String::new(),
            shape: None,
            color: None,
            is_main: false,
        })
        .unwrap()
    }

    /// A pending card asking for `name`, as `request_secret` leaves it.
    fn ask(agent: &Agent, name: &str, labels: &[&str]) -> (String, Request) {
        let labels: Vec<String> = labels.iter().map(|s| s.to_string()).collect();
        let request =
            build_request(agent, name, "Pull last month's payouts", "api_key", &labels).unwrap();
        let mut card = AgentMessage {
            id: store::new_id(),
            agent_id: agent.id.clone(),
            ts: store::now_ms(),
            kind: MessageKind::Approval,
            text: String::new(),
            peer: None,
            approval: None,
            attachments: Vec::new(),
            check_in: None,
            stopped: false,
            mentions: Vec::new(),
            failure: None,
            changes: None,
            session: None,
            client_id: None,
        };
        let request_id = store::new_id();
        card.approval = Some(Approval {
            request_id: request_id.clone(),
            title: format!("Secure input · {name}"),
            detail: request.purpose.clone(),
            status: ApprovalStatus::Pending,
            tool: None,
            input: None,
            always: None,
            always_allowed: false,
            note: None,
            prompt: None,
            choice: None,
            secret: Some(request.clone()),
        });
        store::append_message(&card).unwrap();
        (request_id, request)
    }

    fn grep_dir(dir: &std::path::Path, needle: &str) -> Vec<std::path::PathBuf> {
        let mut hits = Vec::new();
        for entry in walkdir(dir) {
            if std::fs::read(&entry)
                .map(|b| String::from_utf8_lossy(&b).contains(needle))
                .unwrap_or(false)
            {
                hits.push(entry);
            }
        }
        hits
    }

    fn walkdir(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walkdir(&path));
            } else {
                out.push(path);
            }
        }
        out
    }

    #[test]
    fn names_become_variables_and_reserved_ones_are_refused() {
        with_root(|_| {
            let finance = agent("Finance");
            let r = build_request(&finance, "Stripe key", "Payouts", "api_key", &[]).unwrap();
            assert_eq!(r.name, "stripe_key");
            assert_eq!(r.reference, "secret:finance/stripe_key");
            assert_eq!(r.fields[0].env, "STRIPE_KEY");
            assert_eq!(r.fields[0].label, "API key");
            let login = build_request(
                &finance,
                "bank",
                "Statements",
                "password",
                &["Username".into(), "Password".into()],
            )
            .unwrap();
            assert_eq!(
                login
                    .fields
                    .iter()
                    .map(|f| f.env.as_str())
                    .collect::<Vec<_>>(),
                ["BANK_USERNAME", "BANK_PASSWORD"]
            );
            for bad in ["path", "claude_code_x", "dyld_insert", "2fa", "", "__"] {
                assert!(
                    build_request(&finance, bad, "x", "token", &[]).is_err(),
                    "{bad}"
                );
            }
            assert!(build_request(&finance, "k", "  ", "token", &[]).is_err());
            assert!(build_request(&finance, "k", "x", "cookie", &[]).is_err());
        });
    }

    #[test]
    fn values_live_in_the_agents_own_keychain_service_and_only_its_turns_get_them() {
        with_root(|_| {
            let finance = agent("Finance");
            let site = agent("Site");
            let (request_id, _) = ask(&finance, "stripe_key", &[]);
            let (secret, card) =
                save(&finance.id, &request_id, &["sk_live_scoped_123456".into()]).unwrap();
            assert_eq!(
                card.unwrap().approval.unwrap().status,
                ApprovalStatus::Allowed
            );
            assert_eq!(
                vault::get(&format!("ship-studio-agent-{}", finance.id), "STRIPE_KEY").as_deref(),
                Some("sk_live_scoped_123456")
            );
            assert!(vault::get(&format!("ship-studio-agent-{}", site.id), "STRIPE_KEY").is_none());

            // The registry holds the reference, never the value.
            let saved = store::get(&finance.id).unwrap();
            assert_eq!(saved.secrets, vec![secret.clone()]);
            assert!(!serde_json::to_string(&saved)
                .unwrap()
                .contains("sk_live_scoped_123456"));

            let env = env_for(&saved);
            assert_eq!(
                env,
                vec![("STRIPE_KEY".into(), "sk_live_scoped_123456".into())]
            );
            assert!(env_for(&store::get(&site.id).unwrap()).is_empty());
            assert!(store::get(&finance.id).unwrap().secrets[0]
                .last_used_at
                .is_some());

            // What the agent is told carries the reference and the variable only.
            for told in [
                saved_prompt(&secret),
                asked_reply(&secret_request(&secret)),
                prompt_section(&saved, &env),
            ] {
                assert!(told.contains("$STRIPE_KEY"));
                assert!(!told.contains("sk_live_scoped_123456"));
            }
            // Answered once.
            assert!(save(&finance.id, &request_id, &["again_123456".into()]).is_err());
        });
    }

    fn secret_request(s: &Secret) -> Request {
        Request {
            name: s.name.clone(),
            purpose: s.purpose.clone(),
            kind: s.kind,
            fields: s.fields.clone(),
            reference: s.reference.clone(),
        }
    }

    #[test]
    fn a_saved_value_never_reaches_a_persisted_file() {
        with_root(|root| {
            let finance = agent("Finance");
            let (request_id, _) = ask(&finance, "bank", &["Username", "Password"]);
            let value = "hunter2-correct-horse";
            save(
                &finance.id,
                &request_id,
                &["ada@example.com".into(), value.into()],
            )
            .unwrap();

            // The agent echoes it, quotes it in JSON, puts it in a card: all scrubbed.
            let mut leak = AgentMessage {
                text: format!("Logged in with {value}, and \"{value}\" again"),
                ..store::messages(&finance.id, 1).unwrap().remove(0)
            };
            leak.id = store::new_id();
            leak.kind = MessageKind::Agent;
            if let Some(a) = leak.approval.as_mut() {
                a.detail = format!("curl -u ada:{value}");
                a.input = Some(serde_json::json!({ "command": format!("echo {value}") }));
                a.request_id = store::new_id();
            }
            store::append_message(&leak).unwrap();
            let shown = redact_message(leak);
            assert!(shown.text.contains("[secret:finance/bank]"));
            assert!(!serde_json::to_string(&shown).unwrap().contains(value));

            assert!(
                grep_dir(root, value).is_empty(),
                "{:?}",
                grep_dir(root, value)
            );
            assert!(redact(&format!("x{value}y")).contains("[secret:finance/bank]"));
            // Short values aren't scrubbed: they'd hit ordinary words.
            remember("abc", "secret:x/y");
            assert_eq!(redact("abc"), "abc");
        });
    }

    #[test]
    fn revoke_deletes_from_the_keychain_and_the_agent() {
        with_root(|_| {
            let finance = agent("Finance");
            let (request_id, _) = ask(&finance, "gh_token", &[]);
            let (secret, _) =
                save(&finance.id, &request_id, &["ghp_revoke_me_123".into()]).unwrap();
            revoke(&finance.id, &secret.id).unwrap();
            assert!(store::get(&finance.id).unwrap().secrets.is_empty());
            assert!(vault::get(&format!("ship-studio-agent-{}", finance.id), "GH_TOKEN").is_none());
            assert!(env_for(&store::get(&finance.id).unwrap()).is_empty());
            assert!(revoke(&finance.id, &secret.id).is_err());

            // Deleting the agent takes its items too.
            let (request_id, _) = ask(&finance, "gh_token", &[]);
            save(&finance.id, &request_id, &["ghp_second_123".into()]).unwrap();
            store::delete(&finance.id).unwrap();
            assert!(vault::get(&format!("ship-studio-agent-{}", finance.id), "GH_TOKEN").is_none());
        });
    }

    #[test]
    fn a_declined_card_tells_the_agent_plainly_and_stores_nothing() {
        with_root(|_| {
            let finance = agent("Finance");
            let (request_id, request) = ask(&finance, "stripe_key", &[]);
            store::set_approval_status(&finance.id, &request_id, ApprovalStatus::Denied).unwrap();
            assert!(save(&finance.id, &request_id, &["sk_too_late_1234".into()]).is_err());
            assert!(store::get(&finance.id).unwrap().secrets.is_empty());
            assert!(
                vault::get(&format!("ship-studio-agent-{}", finance.id), "STRIPE_KEY").is_none()
            );
            let told = denied_prompt(&request, None);
            assert!(told.starts_with("[The user declined to give you stripe_key"));
            assert!(told.contains("Don't ask for it again"));
            assert!(denied_prompt(&request, Some("Use the test key")).contains("Use the test key"));
        });
    }

    /// A session's question can quote a secret (a command it wants to run with
    /// the key inline): the card's question, options and choice are scrubbed
    /// like any other text, on screen and on disk.
    #[test]
    fn a_session_prompt_card_is_redacted_too() {
        use crate::agents::decisions::{PromptKind, PromptOption, Role, SessionPrompt};
        with_root(|root| {
            let site = agent("Site");
            let (request_id, _) = ask(&site, "stripe", &[]);
            let value = "sk_live_session_prompt_42";
            save(&site.id, &request_id, &[value.into()]).unwrap();

            let mut card = store::messages(&site.id, 1).unwrap().remove(0);
            card.id = store::new_id();
            let approval = card.approval.as_mut().unwrap();
            approval.request_id = store::new_id();
            approval.status = ApprovalStatus::Pending;
            approval.secret = None;
            approval.detail = format!("curl -H 'Authorization: {value}'");
            approval.prompt = Some(SessionPrompt {
                kind: PromptKind::Permission,
                project: "site".into(),
                session_id: "s1".into(),
                tab: 1,
                question: format!("Run curl with {value}?"),
                options: vec![PromptOption {
                    label: format!("Yes, allow {value}"),
                    keys: vec!["1".into()],
                    role: Role::Allow,
                }],
                owner: AgentRef {
                    id: site.id.clone(),
                    name: site.name.clone(),
                },
                chats: vec![site.id.clone()],
            });
            approval.choice = Some(format!("Yes, allow {value}"));
            let request = approval.request_id.clone();
            store::append_message(&card).unwrap();
            let shown = redact_message(card);
            let prompt = shown.approval.as_ref().unwrap().prompt.as_ref().unwrap();
            assert!(prompt.question.contains("[secret:site/stripe]"));
            assert!(prompt.options[0].label.contains("[secret:site/stripe]"));
            assert!(!serde_json::to_string(&shown).unwrap().contains(value));

            store::answer_prompt(
                &site.id,
                &request,
                ApprovalStatus::Allowed,
                &format!("Yes, allow {value}"),
            )
            .unwrap();
            assert!(
                grep_dir(root, value).is_empty(),
                "{:?}",
                grep_dir(root, value)
            );
        });
    }
}
