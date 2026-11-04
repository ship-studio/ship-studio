//! The companion on the real desktop: the backend that calls the Agents
//! command functions, the subscription to their events, the Mac's status,
//! `tailscale serve`, and turning it all on and off.

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Listener};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::hub::HubItem;
use super::router::{AgentToggles, ApprovalAnswer, Backend, ScheduleOp, SendExtras};
use super::wire::{ClaudeInfo, Event, Known, MacStatus, PowerInfo, Route, RouteKind};
use super::{Companion, Registry, TAILNET_HTTPS_PORT};
use crate::agents::{runner, store};
use crate::commands::agents as cmd;
use crate::errors::CommandError;
use crate::remote_access::{power, tailscale};

/// The Phone panel listens for this and re-reads `companion_status`.
pub const EVENT_CHANGED: &str = "companion://changed";

static COMPANION: OnceLock<Arc<Companion>> = OnceLock::new();

/// The companion, if anything has created it this run.
pub fn get() -> Option<Arc<Companion>> {
    COMPANION.get().cloned()
}

/// Create the companion (once) and subscribe it to the agents' events. The
/// journal starts here, so its epoch is this run's.
pub fn ensure(app: &AppHandle) -> Arc<Companion> {
    COMPANION
        .get_or_init(|| {
            let path = crate::commands::setup::get_app_state_path()
                .parent()
                .map(|dir| dir.join("companion.json"))
                .unwrap_or_else(|| std::path::PathBuf::from("companion.json"));
            let backend = Arc::new(DesktopBackend { app: app.clone() });
            let c = Arc::new(Companion::new(Registry::load(path), backend));
            subscribe(app, &c);
            tauri::async_runtime::spawn(watch_projects(c.clone()));
            c
        })
        .clone()
}

/// `notify::on_screen` for a phone's label.
pub fn is_showing(label: &str) -> bool {
    get().is_some_and(|c| c.label_on_screen(label))
}

// ============================================================================
// Events: the desktop's own, journaled as they are emitted
// ============================================================================

/// The overview is rebuilt at most this often: `agents://registry` fires on
/// every message, and the overview reads every agent.
const REGISTRY_DEBOUNCE: Duration = Duration::from_millis(150);

fn subscribe(app: &AppHandle, c: &Arc<Companion>) {
    let hub = c.clone();
    app.listen_any(runner::EVENT_MESSAGE, move |event| {
        if let Ok(message) = serde_json::from_str::<Value>(event.payload()) {
            hub.hub.publish(Event::Message { message });
        }
    });
    let hub = c.clone();
    app.listen_any(runner::EVENT_STATUS, move |event| {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            agent_id: String,
            status: Value,
        }
        if let Ok(p) = serde_json::from_str::<Payload>(event.payload()) {
            hub.hub.publish(Event::Status {
                agent_id: p.agent_id,
                status: p.status,
            });
        }
    });
    let hub = c.clone();
    app.listen_any(runner::EVENT_DRAFT, move |event| {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            agent_id: String,
            id: String,
            text: String,
        }
        if let Ok(p) = serde_json::from_str::<Payload>(event.payload()) {
            hub.hub.draft(p.agent_id, p.id, p.text);
        }
    });
    let hub = c.clone();
    let pending = Arc::new(AtomicBool::new(false));
    app.listen_any(runner::EVENT_REGISTRY, move |_| {
        if pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let (hub, pending) = (hub.clone(), pending.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(REGISTRY_DEBOUNCE).await;
            pending.store(false, Ordering::SeqCst);
            match hub.backend.overview().await {
                Ok(overview) => {
                    hub.hub.publish(Event::Registry { overview });
                }
                Err(e) => tracing::warn!("[Companion] Could not read the overview: {}", e),
            }
        });
    });
}

/// How often the projects are looked at while a phone has the app open.
const PROJECTS_EVERY: Duration = Duration::from_secs(2);
/// Git (branch, uncommitted count) is asked every this many looks.
const GIT_EVERY: u32 = 5;

/// Journal `projects.changed` / `projects.removed` while a phone is in the
/// foreground (see `companion/projects.rs`). Tabs are read every look; git
/// every [`GIT_EVERY`]th, its answer reused in between.
async fn watch_projects(c: Arc<Companion>) {
    use crate::remote_access::tools::{project_git, project_name, project_sessions, ProjectView};
    let mut watch = super::projects::ProjectsWatch::default();
    let mut git: std::collections::HashMap<String, (Option<String>, usize)> = Default::default();
    let mut tick: u32 = 0;
    let mut every = tokio::time::interval(PROJECTS_EVERY);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        every.tick().await;
        if !c.any_foreground() {
            continue;
        }
        let projects = all_projects().await;
        let fresh_git = tick.is_multiple_of(GIT_EVERY);
        tick = tick.wrapping_add(1);
        let mut views = Vec::with_capacity(projects.len());
        for path in &projects {
            if fresh_git || !git.contains_key(path) {
                git.insert(path.clone(), project_git(path).await);
            }
            let (branch, dirty_files) = git.get(path).cloned().unwrap_or_default();
            views.push(ProjectView {
                path: path.clone(),
                name: project_name(path).to_string(),
                branch,
                dirty_files,
                sessions: project_sessions(path),
            });
        }
        git.retain(|p, _| projects.contains(p));
        let views: Vec<Value> = views
            .into_iter()
            .filter_map(|v| serde_json::to_value(v).ok())
            .collect();
        for event in watch.diff(views) {
            c.hub.publish(event);
        }
    }
}

// ============================================================================
// The backend: the Agents commands, called as the desk calls them
// ============================================================================

struct DesktopBackend {
    app: AppHandle,
}

fn json<T: Serialize>(v: T) -> Result<Value, CommandError> {
    serde_json::to_value(v).map_err(|e| CommandError::from(format!("serialize: {e}")))
}

#[async_trait]
impl Backend for DesktopBackend {
    async fn overview(&self) -> Result<Value, CommandError> {
        Ok(super::wire::phone_overview(json(
            cmd::agents_overview(self.app.clone()).await?,
        )?))
    }

    async fn messages(
        &self,
        agent_id: &str,
        limit: usize,
        before: Option<&str>,
    ) -> Result<(Vec<Value>, bool), CommandError> {
        let (agent_id, before) = (agent_id.to_string(), before.map(str::to_string));
        let (page, more) = tokio::task::spawn_blocking(move || {
            store::messages_page(&agent_id, limit, before.as_deref())
        })
        .await
        .map_err(crate::agents::err_other)??;
        Ok((page.into_iter().map(json).collect::<Result<_, _>>()?, more))
    }

    async fn send(
        &self,
        agent_id: &str,
        text: String,
        extras: SendExtras,
    ) -> Result<Value, CommandError> {
        let mentions = (!extras.mentions.is_empty()).then_some(extras.mentions);
        let attachments = (!extras.attachments.is_empty()).then(|| {
            extras
                .attachments
                .into_iter()
                .map(|a| crate::agents::attachments::OutgoingAttachment {
                    name: a.name,
                    path: Some(a.path.display().to_string()),
                    data: None,
                })
                .collect()
        });
        json(
            cmd::agents_send(
                self.app.clone(),
                agent_id.to_string(),
                text,
                attachments,
                mentions,
                extras.client_id,
            )
            .await?,
        )
    }

    async fn stop(&self, agent_id: &str) -> Result<bool, CommandError> {
        cmd::agents_stop(agent_id.to_string()).await
    }

    async fn interrupt(&self, agent_id: &str) -> Result<bool, CommandError> {
        cmd::agents_interrupt(agent_id.to_string()).await
    }

    async fn answer_approval(&self, a: ApprovalAnswer) -> Result<(), CommandError> {
        cmd::agents_answer_approval(
            self.app.clone(),
            a.agent_id,
            a.request_id,
            a.allow,
            a.always,
            a.note,
        )
        .await
    }

    async fn focus(&self, label: &str, agent_id: Option<String>) -> Result<(), CommandError> {
        cmd::focus_as(&self.app, label, agent_id)
    }

    async fn mark_unread(&self, agent_id: &str) -> Result<(), CommandError> {
        cmd::agents_mark_unread(self.app.clone(), agent_id.to_string()).await
    }

    async fn update_agent(
        &self,
        agent_id: &str,
        toggles: AgentToggles,
    ) -> Result<Value, CommandError> {
        let input = cmd::UpdateAgentInput {
            name: None,
            shape: None,
            color: None,
            role: None,
            instructions: toggles.instructions,
            pinned: toggles.pinned,
            hidden: toggles.hidden,
            muted: toggles.muted,
            model: None,
            project: None,
        };
        json(cmd::agents_update(self.app.clone(), agent_id.to_string(), input).await?)
    }

    async fn files(&self, agent_id: &str) -> Result<Value, CommandError> {
        json(cmd::agents_files(agent_id.to_string()).await?)
    }

    async fn instructions(&self, agent_id: &str) -> Result<String, CommandError> {
        cmd::agents_instructions(agent_id.to_string()).await
    }

    async fn usage(&self, agent_id: &str) -> Result<Value, CommandError> {
        json(cmd::agents_usage(agent_id.to_string()).await?)
    }

    async fn revoke_permission(&self, agent_id: &str, rule_id: &str) -> Result<(), CommandError> {
        cmd::agents_revoke_permission(self.app.clone(), agent_id.to_string(), rule_id.to_string())
            .await
    }

    async fn change_diff(
        &self,
        agent_id: &str,
        message_id: &str,
        path: &str,
    ) -> Result<Value, CommandError> {
        json(
            cmd::agents_change_diff(
                agent_id.to_string(),
                message_id.to_string(),
                path.to_string(),
            )
            .await?,
        )
    }

    async fn shareable_path(
        &self,
        agent_id: &str,
        path: &str,
    ) -> Result<std::path::PathBuf, CommandError> {
        let home = store::agent_home(agent_id)?;
        let mut roots = vec![home.clone()];
        if let Ok(projects) = crate::commands::projects::list_projects().await {
            roots.extend(
                projects
                    .into_iter()
                    .map(|p| std::path::PathBuf::from(p.path)),
            );
        }
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            crate::agents::files::shareable(&path, &home, &roots).map_err(CommandError::expected)
        })
        .await
        .map_err(crate::agents::err_other)?
    }

    async fn search(&self, query: String) -> Result<Value, CommandError> {
        json(cmd::agents_search(query).await?)
    }

    async fn schedule(&self, op: ScheduleOp) -> Result<Value, CommandError> {
        let app = self.app.clone();
        match op {
            ScheduleOp::Preview { when } => json(cmd::agents_schedule_preview(when).await?),
            ScheduleOp::Create {
                agent_id,
                when,
                note,
            } => json(cmd::agents_schedule_create(app, agent_id, when, note).await?),
            ScheduleOp::Update {
                agent_id,
                id,
                when,
                note,
            } => json(cmd::agents_schedule_update(app, agent_id, id, when, note).await?),
            ScheduleOp::Pause {
                agent_id,
                id,
                paused,
            } => json(cmd::agents_schedule_pause(app, agent_id, id, paused).await?),
            ScheduleOp::Cancel { agent_id, id } => {
                json(cmd::agents_schedule_cancel(app, agent_id, id).await?)
            }
            ScheduleOp::RunNow { agent_id, id } => {
                json(cmd::agents_schedule_run_now(app, agent_id, id).await?)
            }
        }
    }

    async fn projects(&self) -> Result<Value, CommandError> {
        json(crate::remote_access::tools::project_views(&all_projects().await).await)
    }

    async fn session_screen(&self, session_id: &str) -> Result<Value, CommandError> {
        let projects = all_projects().await;
        json(
            crate::remote_access::tools::session_screen(&projects, session_id)
                .map_err(CommandError::expected)?,
        )
    }

    async fn session_send(
        &self,
        project: &str,
        session_id: Option<&str>,
        text: &str,
    ) -> Result<String, CommandError> {
        use crate::remote_access::tools::{deliver, resolve_project, Undelivered};
        let project = resolve_project(&all_projects().await, Some(project))
            .map_err(CommandError::expected)?;
        match deliver(&project, session_id, text).await {
            Ok((_, tab, _)) => Ok(tab.session_id),
            Err(Undelivered::Asking { question, .. }) => Err(CommandError::expected(format!(
                "Not sent: it’s waiting for your answer to “{question}”. Answer that first, then send."
            ))),
            Err(Undelivered::NotAsking { .. }) => Err(CommandError::expected("Not sent.")),
            Err(Undelivered::Other(e)) => Err(CommandError::expected(e)),
        }
    }

    async fn session_key(&self, session_id: &str, key: &str) -> Result<(), CommandError> {
        use crate::remote_access::tools::{press, project_of_session, Undelivered};
        let project = project_of_session(&all_projects().await, session_id).ok_or_else(|| {
            CommandError::expected("That session isn't open in Ship Studio any more.")
        })?;
        match press(&project, Some(session_id), key) {
            Ok(_) => Ok(()),
            Err(Undelivered::NotAsking { .. }) => Err(CommandError::expected(
                "Not pressed: it isn’t asking anything right now.",
            )),
            Err(Undelivered::Asking { .. }) => Err(CommandError::expected("Not pressed.")),
            Err(Undelivered::Other(e)) => Err(CommandError::expected(e)),
        }
    }

    async fn session_start(&self, project: &str, prompt: &str) -> Result<String, CommandError> {
        use crate::remote_access::tools::{not_a_flag, resolve_project, start_agent_with};
        let project = resolve_project(&all_projects().await, Some(project))
            .map_err(CommandError::expected)?;
        start_agent_with(&self.app, &project, &not_a_flag(prompt))
            .await
            .map(|(_, session_id)| session_id)
            .map_err(CommandError::expected)
    }

    async fn preview_screenshot(
        &self,
        project: &str,
        phone: bool,
    ) -> Result<Vec<u8>, CommandError> {
        use crate::remote_access::{shots::Device, tools};
        let project = tools::resolve_project(&all_projects().await, Some(project))
            .map_err(CommandError::expected)?;
        let device = if phone {
            Device::Phone
        } else {
            Device::Desktop
        };
        tools::capture_encoded(&self.app, &project, device, false)
            .await
            .map(|e| e.full)
            .map_err(CommandError::expected)
    }

    fn attachment_file(
        &self,
        agent_id: &str,
        rel: &str,
    ) -> Result<std::path::PathBuf, CommandError> {
        crate::agents::attachments::resolve(&store::agent_home(agent_id)?, rel)
    }

    async fn mac_status(&self) -> MacStatus {
        let power_status = power::read_power().await;
        let on_battery = match (power_status.has_battery, power_status.on_ac) {
            (_, Some(ac)) => Known::from(Some(!ac)),
            // No battery at all: it can't be running on one.
            (false, None) => Known::No,
            (true, None) => Known::Unknown,
        };
        MacStatus {
            name: self.server_name(),
            app_version: self.app_version(),
            power: PowerInfo {
                keep_awake: power::keep_awake_active(),
                lid_closed_mode: Known::from(power::lid_closed_mode_active().await),
                on_battery,
                battery_percent: power_status.battery_percent,
            },
            claude: claude_info().await,
            routes: routes(),
        }
    }

    fn server_name(&self) -> String {
        computer_name()
    }

    fn app_version(&self) -> String {
        self.app.package_info().version.to_string()
    }

    fn audit(&self, actor: &str, tool: &str, detail: String, ok: bool) {
        crate::remote_access::audit_as(Some(actor), tool, None, detail, ok);
    }

    fn changed(&self) {
        let _ = self.app.emit(EVENT_CHANGED, ());
    }
}

/// Every Ship Studio project: what agents reach (the P1 decision), and so
/// what the phone sees.
async fn all_projects() -> Vec<String> {
    crate::commands::projects::list_projects()
        .await
        .map(|list| list.into_iter().map(|p| p.path).collect())
        .unwrap_or_default()
}

static COMPUTER_NAME: OnceLock<String> = OnceLock::new();

/// The Mac's name as System Settings shows it. Read once by
/// [`read_computer_name`] when the companion comes up; until then, a plain
/// "this Mac" rather than a guess.
fn computer_name() -> String {
    COMPUTER_NAME
        .get()
        .cloned()
        .unwrap_or_else(|| "this Mac".to_string())
}

async fn read_computer_name() {
    if COMPUTER_NAME.get().is_some() {
        return;
    }
    let mut cmd = tokio::process::Command::new("/usr/sbin/scutil");
    cmd.args(["--get", "ComputerName"]);
    let name = crate::external_command::run_with_timeout(cmd, "scutil", 5)
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|n| !n.is_empty());
    if let Some(name) = name {
        let _ = COMPUTER_NAME.set(name);
    }
}

/// Claude Code installed, its version, and signed in, from the same check
/// onboarding uses. Cached a minute: it spawns processes.
async fn claude_info() -> ClaudeInfo {
    static CACHE: LazyLock<Mutex<Option<(ClaudeInfo, Instant)>>> =
        LazyLock::new(|| Mutex::new(None));
    if let Some((info, at)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        if at.elapsed() < Duration::from_secs(60) {
            return info;
        }
    }
    let bin = tokio::task::spawn_blocking(|| {
        crate::commands::claude::find_validated_binary("claude", "--version")
    })
    .await
    .ok()
    .flatten();
    let info = match bin {
        None => ClaudeInfo {
            installed: false,
            signed_in: Known::Unknown,
            version: None,
        },
        Some(bin) => {
            let mut cmd = tokio::process::Command::new(bin);
            cmd.arg("--version");
            let version = crate::external_command::run_with_timeout(cmd, "claude --version", 10)
                .await
                .ok()
                .and_then(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .split_whitespace()
                        .next()
                        .map(str::to_string)
                });
            let account = crate::commands::accounts::get_active_account_id()
                .unwrap_or_else(|_| crate::commands::accounts::DEFAULT_ACCOUNT_ID.to_string());
            let signed_in = crate::commands::setup::claude_auth_truth(&account).await;
            ClaudeInfo {
                installed: true,
                signed_in: Known::from(Some(signed_in)),
                version,
            }
        }
    };
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((info.clone(), Instant::now()));
    info
}

// ============================================================================
// Tailscale serve and the lifecycle
// ============================================================================

/// Where the tailnet route stands, as read back from Tailscale.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum ServeState {
    #[default]
    Off,
    /// Served on the tailnet at `url`.
    On {
        url: String,
    },
    /// HTTPS certificates are off on the tailnet; the owner turns them on here.
    NeedsApproval {
        url: String,
    },
    Failed {
        detail: String,
    },
}

struct Running {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

static RUNNING: LazyLock<Mutex<Option<Running>>> = LazyLock::new(|| Mutex::new(None));
static SERVE: LazyLock<Mutex<ServeState>> = LazyLock::new(|| Mutex::new(ServeState::Off));

pub fn running_port() -> Option<u16> {
    RUNNING.lock().ok().and_then(|r| r.as_ref().map(|r| r.port))
}

pub fn serve_state() -> ServeState {
    SERVE.lock().map(|s| s.clone()).unwrap_or_default()
}

fn set_serve(state: ServeState) {
    if let Ok(mut s) = SERVE.lock() {
        *s = state;
    }
}

/// The routes a phone can use right now. Only a serve handler we read back
/// counts; a command that exited zero proves nothing.
pub fn routes() -> Vec<Route> {
    match serve_state() {
        ServeState::On { url } => vec![Route {
            kind: RouteKind::Tailscale,
            url,
            pin: None,
        }],
        _ => Vec::new(),
    }
}

/// Start the loopback server (idempotent) on last time's port if it's free.
async fn start_server(c: Arc<Companion>) -> Result<u16, CommandError> {
    if let Some(port) = running_port() {
        return Ok(port);
    }
    let stored = c.registry.read(|s| s.port);
    let mut listener = None;
    if let Some(port) = stored {
        listener = TcpListener::bind(("127.0.0.1", port)).await.ok();
    }
    let listener = match listener {
        Some(l) => l,
        None => TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Could not open a port for the phone: {e}"))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| format!("companion address: {e}"))?
        .port();
    if stored != Some(port) {
        c.registry.write(|s| s.port = Some(port))?;
    }
    let (tx, rx) = oneshot::channel();
    tauri::async_runtime::spawn(super::server::serve(c, listener, rx));
    tracing::info!("[Companion] listening on 127.0.0.1:{}", port);
    if let Ok(mut r) = RUNNING.lock() {
        *r = Some(Running {
            port,
            shutdown: Some(tx),
        });
    }
    Ok(port)
}

/// Publish the server on the tailnet. Each outcome is kept for the panel.
async fn publish(port: u16) {
    let state = match tailscale::status().await {
        tailscale::TailscaleState::Connected { dns_name } => {
            match tailscale::enable_serve(TAILNET_HTTPS_PORT, port, &dns_name).await {
                tailscale::FunnelOutcome::On => ServeState::On {
                    url: format!("https://{dns_name}:{TAILNET_HTTPS_PORT}"),
                },
                tailscale::FunnelOutcome::NeedsApproval { url } => {
                    ServeState::NeedsApproval { url }
                }
                tailscale::FunnelOutcome::Failed { detail } => ServeState::Failed { detail },
            }
        }
        tailscale::TailscaleState::NotInstalled => ServeState::Failed {
            detail: "Tailscale isn't installed.".into(),
        },
        tailscale::TailscaleState::NeedsLogin => ServeState::Failed {
            detail: "Sign in to Tailscale first.".into(),
        },
        tailscale::TailscaleState::Unknown { detail } => ServeState::Failed { detail },
    };
    set_serve(state);
}

pub async fn bring_up(app: &AppHandle) -> Result<(), CommandError> {
    let c = ensure(app);
    read_computer_name().await;
    let port = start_server(c.clone()).await?;
    publish(port).await;
    c.backend.changed();
    Ok(())
}

pub async fn tear_down(app: &AppHandle) {
    let c = ensure(app);
    c.pairing.cancel();
    if tailscale::find_binary().is_some() {
        if let Err(e) = tailscale::disable_serve(TAILNET_HTTPS_PORT).await {
            tracing::warn!("[Companion] {}", e);
        }
    }
    set_serve(ServeState::Off);
    if let Some(mut running) = RUNNING.lock().ok().and_then(|mut r| r.take()) {
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
    }
    c.hub.signal(HubItem::Shutdown);
    c.backend.changed();
}

/// Turn the companion on or off. Paired devices are kept either way.
pub async fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), CommandError> {
    ensure(app).registry.write(|s| s.enabled = enabled)?;
    if enabled {
        bring_up(app).await
    } else {
        tear_down(app).await;
        Ok(())
    }
}

/// Ask Tailscale again (after the user switched HTTPS certificates on).
pub async fn retry_publish(app: &AppHandle) -> Result<(), CommandError> {
    let port =
        running_port().ok_or_else(|| CommandError::expected("The phone server isn't on."))?;
    publish(port).await;
    ensure(app).backend.changed();
    Ok(())
}

/// At launch: if the user left it on, put it back.
pub async fn resume_on_launch(app: AppHandle) {
    let c = ensure(&app);
    if !c.registry.read(|s| s.enabled) {
        return;
    }
    if let Err(e) = bring_up(&app).await {
        tracing::error!("[Companion] Could not resume at launch: {}", e);
    }
}
