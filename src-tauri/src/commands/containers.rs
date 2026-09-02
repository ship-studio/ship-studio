//! # Project Container Detection
//!
//! Detects Docker containers that belong to a project, the same way the dev
//! server is tracked per-project. Association is label-based and conservative
//! (see the "Never Assume Data" principle in CLAUDE.md): a container is only
//! attributed to a project when a path-carrying label proves it —
//! `com.docker.compose.project.working_dir` (Docker Compose) or
//! `devcontainer.local_folder` (Dev Containers). Plain `docker run` containers
//! carry no reliable project association and are deliberately not shown.
//!
//! Works with any engine that fronts the `docker` CLI (Docker Desktop,
//! OrbStack, Colima). Podman support can be layered on later.

use crate::errors::CommandError;
use crate::external_command::run_with_timeout;
use crate::utils::{create_command, find_executable, get_extended_path, validate_project_path};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Listing all containers is a local API call; keep it snappy so a wedged
/// daemon can't stall the sidebar poll.
const LIST_TIMEOUT_SECS: u64 = 10;
/// `docker stop` waits up to 10s (default grace period) before SIGKILL, and
/// `restart` pays that twice-ish; give lifecycle actions generous headroom.
const ACTION_TIMEOUT_SECS: u64 = 45;

const COMPOSE_WORKING_DIR_LABEL: &str = "com.docker.compose.project.working_dir";
const COMPOSE_SERVICE_LABEL: &str = "com.docker.compose.service";
const COMPOSE_PROJECT_LABEL: &str = "com.docker.compose.project";
const DEVCONTAINER_FOLDER_LABEL: &str = "devcontainer.local_folder";

/// Availability of the Docker engine on this machine.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum EngineStatus {
    /// CLI present and the daemon answered.
    Ok,
    /// No `docker` binary on the (extended) PATH.
    NotInstalled,
    /// CLI present but the daemon isn't reachable (Docker Desktop closed…).
    NotRunning,
}

/// A single host→container published port.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
pub struct PortMapping {
    pub host_port: u16,
    pub container_port: u16,
    pub protocol: String,
}

/// A container attributed to the project.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ContainerInfo {
    /// Full (untruncated) container id.
    pub id: String,
    pub name: String,
    pub image: String,
    /// Engine state: `running`, `exited`, `paused`, `restarting`, `created`…
    pub state: String,
    /// Human status line from `docker ps`, e.g. "Up 2 hours".
    pub status: String,
    /// Compose service name, when the container came from a compose file.
    pub service: Option<String>,
    /// Compose project name, when applicable.
    pub compose_project: Option<String>,
    pub ports: Vec<PortMapping>,
}

/// Result of a project container scan. `engine` lets the frontend distinguish
/// "no containers" from "Docker isn't even running" without a second command.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectContainers {
    pub engine: EngineStatus,
    pub containers: Vec<ContainerInfo>,
}

/// One line of `docker ps --format '{{json .}}'` output.
#[derive(Deserialize, Debug)]
struct DockerPsLine {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Names")]
    names: String,
    #[serde(rename = "Image")]
    image: String,
    #[serde(rename = "State")]
    state: String,
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "Ports", default)]
    ports: String,
    #[serde(rename = "Labels", default)]
    labels: String,
}

fn docker_command() -> Option<tokio::process::Command> {
    let path = find_executable("docker")?;
    let mut cmd = create_command(path);
    cmd.env("PATH", get_extended_path());
    Some(tokio::process::Command::from(cmd))
}

/// Parse the comma-joined `Labels` string ("k=v,k=v") into a map. A label
/// *value* containing a comma will be truncated at it — such a container
/// simply fails to match its project (fail closed, never misattribute).
fn parse_labels(labels: &str) -> HashMap<&str, &str> {
    labels
        .split(',')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.trim(), v))
        .collect()
}

/// True when `candidate` is `root` itself or a path underneath it.
fn is_same_or_under(candidate: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return false;
    }
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Does this container provably belong to the project at one of `roots`?
/// Only path-carrying labels count — name similarity is never enough.
fn belongs_to_project(labels: &HashMap<&str, &str>, roots: &[&str]) -> bool {
    [COMPOSE_WORKING_DIR_LABEL, DEVCONTAINER_FOLDER_LABEL]
        .iter()
        .filter_map(|key| labels.get(key))
        .any(|value| roots.iter().any(|root| is_same_or_under(value, root)))
}

/// Parse the `Ports` column ("0.0.0.0:5432->5432/tcp, :::5432->5432/tcp,
/// 6379/tcp") into published mappings. Unpublished ports (no `->`) and
/// duplicate IPv4/IPv6 rows are dropped.
fn parse_ports(ports: &str) -> Vec<PortMapping> {
    let mut seen = Vec::new();
    for entry in ports.split(',').map(str::trim) {
        let Some((host, container)) = entry.split_once("->") else {
            continue;
        };
        let Some(host_port) = host.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else {
            continue;
        };
        let (container_port_str, protocol) = container.split_once('/').unwrap_or((container, ""));
        let Ok(container_port) = container_port_str.parse::<u16>() else {
            continue;
        };
        let mapping = PortMapping {
            host_port,
            container_port,
            protocol: protocol.to_string(),
        };
        if !seen.contains(&mapping) {
            seen.push(mapping);
        }
    }
    seen
}

/// Classify a failed `docker ps` into "daemon down" vs a real error.
fn is_daemon_unreachable(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("cannot connect to the docker daemon")
        || lower.contains("docker daemon is not running")
        || lower.contains("error during connect")
        || lower.contains("is the docker daemon running")
}

/// Build the project's `ContainerInfo` list from raw `docker ps` JSON lines.
/// Pure for testability.
fn collect_project_containers(stdout: &str, roots: &[&str]) -> Vec<ContainerInfo> {
    let mut containers: Vec<ContainerInfo> = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<DockerPsLine>(line).ok())
        .filter_map(|line| {
            let labels = parse_labels(&line.labels);
            if !belongs_to_project(&labels, roots) {
                return None;
            }
            Some(ContainerInfo {
                id: line.id.clone(),
                // Multi-name containers are comma-joined; the first is canonical.
                name: line.names.split(',').next().unwrap_or(&line.id).to_string(),
                image: line.image,
                state: line.state,
                status: line.status,
                service: labels.get(COMPOSE_SERVICE_LABEL).map(|s| s.to_string()),
                compose_project: labels.get(COMPOSE_PROJECT_LABEL).map(|s| s.to_string()),
                ports: parse_ports(&line.ports),
            })
        })
        .collect();
    // Running containers first, then stable name order.
    containers.sort_by(|a, b| {
        let rank = |c: &ContainerInfo| if c.state == "running" { 0 } else { 1 };
        rank(a).cmp(&rank(b)).then_with(|| a.name.cmp(&b.name))
    });
    containers
}

/// Container ids are hex; anything else is rejected before it reaches the CLI.
fn validate_container_id(container_id: &str) -> Result<(), CommandError> {
    let valid_len = (12..=64).contains(&container_id.len());
    if !valid_len || !container_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CommandError::Validation {
            field: "container_id".into(),
            reason: "not a valid container id".into(),
        });
    }
    Ok(())
}

/// The raw path and its canonicalized form — compose may have recorded either
/// (macOS `/tmp` vs `/private/tmp`), so membership checks accept both.
fn project_roots(project_path: &str) -> Result<Vec<String>, CommandError> {
    let canonical =
        validate_project_path(project_path).map_err(|reason| CommandError::Validation {
            field: "project_path".into(),
            reason,
        })?;
    let mut roots = vec![project_path.trim_end_matches('/').to_string()];
    let canonical = canonical.to_string_lossy().to_string();
    if !roots.contains(&canonical) {
        roots.push(canonical);
    }
    Ok(roots)
}

async fn scan_project_containers(project_path: &str) -> Result<ProjectContainers, CommandError> {
    let roots = project_roots(project_path)?;

    let Some(mut cmd) = docker_command() else {
        return Ok(ProjectContainers {
            engine: EngineStatus::NotInstalled,
            containers: Vec::new(),
        });
    };
    cmd.args(["ps", "--all", "--no-trunc", "--format", "{{json .}}"]);

    let output = match run_with_timeout(cmd, "docker ps", LIST_TIMEOUT_SECS).await {
        Ok(output) => output,
        // The binary vanished between detection and spawn — treat as absent.
        Err(CommandError::Io { .. }) => {
            return Ok(ProjectContainers {
                engine: EngineStatus::NotInstalled,
                containers: Vec::new(),
            });
        }
        Err(err) => return Err(err),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if is_daemon_unreachable(&stderr) {
            return Ok(ProjectContainers {
                engine: EngineStatus::NotRunning,
                containers: Vec::new(),
            });
        }
        return Err(CommandError::Process {
            cmd: "docker ps".into(),
            exit_code: output.status.code().unwrap_or(-1),
            stderr,
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let root_refs: Vec<&str> = roots.iter().map(String::as_str).collect();
    Ok(ProjectContainers {
        engine: EngineStatus::Ok,
        containers: collect_project_containers(&stdout, &root_refs),
    })
}

/// List the Docker containers that belong to a project, plus engine
/// availability. Containers are matched by compose/devcontainer path labels
/// only — never by name similarity.
///
/// # Arguments
/// * `project_path` - Absolute path to the project directory
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn list_project_containers(
    project_path: String,
) -> Result<ProjectContainers, CommandError> {
    scan_project_containers(&project_path).await
}

/// Run a lifecycle action after re-verifying the container still belongs to
/// the project — the id came from the frontend and could be stale or spoofed.
async fn container_action(
    project_path: &str,
    container_id: &str,
    action: &str,
) -> Result<(), CommandError> {
    validate_container_id(container_id)?;
    let scan = scan_project_containers(project_path).await?;
    if !scan.containers.iter().any(|c| c.id == container_id) {
        return Err(CommandError::Validation {
            field: "container_id".into(),
            reason: "container does not belong to this project".into(),
        });
    }

    let mut cmd = docker_command().ok_or(CommandError::Io {
        message: "docker CLI not found".into(),
    })?;
    cmd.args([action, container_id]);
    let label = format!("docker {action}");
    let output = run_with_timeout(cmd, label.clone(), ACTION_TIMEOUT_SECS).await?;
    if !output.status.success() {
        return Err(CommandError::Process {
            cmd: label,
            exit_code: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }
    Ok(())
}

/// Start a stopped container that belongs to the project.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn start_project_container(
    project_path: String,
    container_id: String,
) -> Result<(), CommandError> {
    container_action(&project_path, &container_id, "start").await
}

/// Stop a running container that belongs to the project.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn stop_project_container(
    project_path: String,
    container_id: String,
) -> Result<(), CommandError> {
    container_action(&project_path, &container_id, "stop").await
}

/// Restart a container that belongs to the project.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub async fn restart_project_container(
    project_path: String,
    container_id: String,
) -> Result<(), CommandError> {
    container_action(&project_path, &container_id, "restart").await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ps_line(id: &str, name: &str, state: &str, labels: &str, ports: &str) -> String {
        serde_json::json!({
            "ID": id,
            "Names": name,
            "Image": "postgres:16",
            "State": state,
            "Status": "Up 2 hours",
            "Ports": ports,
            "Labels": labels,
        })
        .to_string()
    }

    #[test]
    fn parses_labels_into_map() {
        let labels = parse_labels("a=1,com.docker.compose.service=db,b=x=y");
        assert_eq!(labels.get("a"), Some(&"1"));
        assert_eq!(labels.get("com.docker.compose.service"), Some(&"db"));
        // split_once keeps everything after the first '=' as the value
        assert_eq!(labels.get("b"), Some(&"x=y"));
    }

    #[test]
    fn matches_compose_working_dir_exactly() {
        let line = ps_line(
            "a".repeat(64).as_str(),
            "myapp-db-1",
            "running",
            "com.docker.compose.project.working_dir=/Users/me/ShipStudio/myapp,com.docker.compose.service=db,com.docker.compose.project=myapp",
            "",
        );
        let found = collect_project_containers(&line, &["/Users/me/ShipStudio/myapp"]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].service.as_deref(), Some("db"));
        assert_eq!(found[0].compose_project.as_deref(), Some("myapp"));
    }

    #[test]
    fn matches_compose_file_in_subdirectory() {
        let line = ps_line(
            "b".repeat(64).as_str(),
            "myapp-db-1",
            "running",
            "com.docker.compose.project.working_dir=/Users/me/ShipStudio/myapp/infra",
            "",
        );
        let found = collect_project_containers(&line, &["/Users/me/ShipStudio/myapp"]);
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn does_not_match_sibling_project_with_shared_prefix() {
        let line = ps_line(
            "c".repeat(64).as_str(),
            "myapp2-db-1",
            "running",
            "com.docker.compose.project.working_dir=/Users/me/ShipStudio/myapp2",
            "",
        );
        assert!(collect_project_containers(&line, &["/Users/me/ShipStudio/myapp"]).is_empty());
    }

    #[test]
    fn matches_devcontainer_label() {
        let line = ps_line(
            "d".repeat(64).as_str(),
            "vsc-myapp-abc",
            "running",
            "devcontainer.local_folder=/Users/me/ShipStudio/myapp",
            "",
        );
        assert_eq!(
            collect_project_containers(&line, &["/Users/me/ShipStudio/myapp"]).len(),
            1
        );
    }

    #[test]
    fn ignores_unlabeled_containers() {
        let line = ps_line("e".repeat(64).as_str(), "myapp", "running", "", "");
        assert!(collect_project_containers(&line, &["/Users/me/ShipStudio/myapp"]).is_empty());
    }

    #[test]
    fn sorts_running_before_stopped_then_by_name() {
        let root = "com.docker.compose.project.working_dir=/p";
        let lines = [
            ps_line("f".repeat(64).as_str(), "b-stopped", "exited", root, ""),
            ps_line("1".repeat(64).as_str(), "z-running", "running", root, ""),
            ps_line("2".repeat(64).as_str(), "a-running", "running", root, ""),
        ]
        .join("\n");
        let names: Vec<String> = collect_project_containers(&lines, &["/p"])
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, ["a-running", "z-running", "b-stopped"]);
    }

    #[test]
    fn parses_ports_and_dedupes_ipv6_twin() {
        let ports = parse_ports("0.0.0.0:5432->5432/tcp, :::5432->5432/tcp, 6379/tcp");
        assert_eq!(
            ports,
            vec![PortMapping {
                host_port: 5432,
                container_port: 5432,
                protocol: "tcp".into(),
            }]
        );
    }

    #[test]
    fn parses_remapped_host_port() {
        let ports = parse_ports("127.0.0.1:15432->5432/tcp");
        assert_eq!(ports[0].host_port, 15432);
        assert_eq!(ports[0].container_port, 5432);
    }

    #[test]
    fn empty_ports_string_parses_to_nothing() {
        assert!(parse_ports("").is_empty());
    }

    #[test]
    fn classifies_daemon_down_stderr() {
        assert!(is_daemon_unreachable(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
        ));
        assert!(is_daemon_unreachable(
            "error during connect: Get \"http://...\": open //./pipe/docker_engine"
        ));
        assert!(!is_daemon_unreachable("permission denied"));
    }

    #[test]
    fn rejects_malformed_container_ids() {
        assert!(validate_container_id("abc").is_err()); // too short
        assert!(validate_container_id("g".repeat(12).as_str()).is_err()); // not hex
        assert!(validate_container_id("deadbeef1234; rm -rf /").is_err());
        assert!(validate_container_id("deadbeef1234").is_ok());
        assert!(validate_container_id("a".repeat(64).as_str()).is_ok());
    }

    #[test]
    fn is_same_or_under_handles_trailing_slash_and_empty() {
        assert!(is_same_or_under("/a/b", "/a/b/"));
        assert!(is_same_or_under("/a/b/c", "/a/b"));
        assert!(!is_same_or_under("/a/bc", "/a/b"));
        assert!(!is_same_or_under("/a/b", ""));
    }

    #[test]
    fn skips_malformed_json_lines() {
        let good = ps_line(
            "3".repeat(64).as_str(),
            "ok",
            "running",
            "com.docker.compose.project.working_dir=/p",
            "",
        );
        let input = format!("not json\n{good}\n{{\"partial\":true}}");
        assert_eq!(collect_project_containers(&input, &["/p"]).len(), 1);
    }
}
