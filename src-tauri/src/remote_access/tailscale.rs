//! Publishing the remote server through Tailscale Funnel.
//!
//! Funnel gives this Mac a stable public HTTPS address on the user's *own*
//! tailnet (`https://<machine>.<tailnet>.ts.net`). Traffic goes from the
//! chat service straight to Tailscale's edge and on to this machine; it never
//! passes through anything Ship Studio runs, and the address belongs to the
//! user's Tailscale account, not to us.
//!
//! The server is mounted at [`MOUNT_PATH`] rather than the root, so turning
//! remote access on or off never touches anything else the user serves.
//!
//! Everything reported here is read back from the `tailscale` CLI. A Funnel
//! is "on" only when `tailscale funnel status --json` shows our mount
//! proxying to our port with funnel allowed — never because a command we
//! ran exited zero.

use crate::errors::CommandError;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub const MOUNT_PATH: &str = "/shipstudio";

/// Where the CLI lives. The Mac App Store / standalone app ships it inside
/// the bundle; Homebrew and the open-source build put it on PATH.
fn candidate_binaries() -> Vec<std::path::PathBuf> {
    let mut out = vec![
        std::path::PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
        std::path::PathBuf::from("/opt/homebrew/bin/tailscale"),
        std::path::PathBuf::from("/usr/local/bin/tailscale"),
    ];
    if let Ok(found) = which::which("tailscale") {
        out.insert(0, found);
    }
    out
}

pub fn find_binary() -> Option<std::path::PathBuf> {
    candidate_binaries().into_iter().find(|p| p.is_file())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum TailscaleState {
    /// No CLI found anywhere we look.
    NotInstalled,
    /// Installed, but the daemon isn't running or isn't logged in.
    NeedsLogin,
    /// Logged in. `dns_name` is this machine's tailnet name.
    Connected { dns_name: String },
    /// The CLI answered with something we could not read.
    Unknown { detail: String },
}

/// A command for the CLI at `bin`. The standalone Tailscale.app binary is
/// both the GUI and the CLI, and decides which from the environment: from a
/// terminal it's the CLI, but spawned by a GUI app (Ship Studio installed, not
/// `tauri dev`) it tries to start a second GUI, prints "The Tailscale GUI
/// failed to start" and exits zero. `TAILSCALE_BE_CLI` forces the CLI.
fn cli_command(bin: std::path::PathBuf) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.env("TAILSCALE_BE_CLI", "1");
    cmd
}

async fn run_cli(args: &[&str], timeout_secs: u64) -> Result<std::process::Output, CommandError> {
    let bin = find_binary().ok_or_else(|| CommandError::expected("Tailscale isn't installed."))?;
    let mut cmd = cli_command(bin);
    cmd.args(args);
    crate::external_command::run_with_timeout(cmd, "tailscale", timeout_secs).await
}

/// Read `BackendState` and `Self.DNSName` out of `tailscale status --json`.
pub fn parse_status(json: &Value) -> TailscaleState {
    let backend = json
        .get("BackendState")
        .and_then(Value::as_str)
        .unwrap_or("");
    if backend != "Running" {
        return TailscaleState::NeedsLogin;
    }
    match json
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|n| n.trim_end_matches('.'))
    {
        Some(name) if !name.is_empty() => TailscaleState::Connected {
            dns_name: name.to_string(),
        },
        _ => TailscaleState::Unknown {
            detail: "Tailscale is running but didn't report this machine's name.".to_string(),
        },
    }
}

pub async fn status() -> TailscaleState {
    if find_binary().is_none() {
        return TailscaleState::NotInstalled;
    }
    let output = match run_cli(&["status", "--json"], 8).await {
        Ok(o) => o,
        Err(e) => {
            return TailscaleState::Unknown {
                detail: e.to_string(),
            }
        }
    };
    // `status` exits non-zero when logged out but still prints JSON.
    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(json) => parse_status(&json),
        Err(_) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
            if stderr.contains("not running")
                || stderr.contains("logged out")
                || stderr.contains("failed to connect")
            {
                TailscaleState::NeedsLogin
            } else {
                // Never an empty reason: some failures only print to stdout.
                let said = if stderr.trim().is_empty() {
                    String::from_utf8_lossy(&output.stdout).trim().to_string()
                } else {
                    stderr.trim().to_string()
                };
                TailscaleState::Unknown {
                    detail: if said.is_empty() {
                        "Tailscale gave no answer.".to_string()
                    } else {
                        said
                    },
                }
            }
        }
    }
}

/// Is our mount funnelled to `port` on `dns_name`, per `tailscale funnel
/// status --json`? The serve config shape is:
///
/// ```json
/// { "Web": { "host.ts.net:443": { "Handlers": { "/shipstudio": { "Proxy": "http://127.0.0.1:4321" } } } },
///   "AllowFunnel": { "host.ts.net:443": true } }
/// ```
pub fn funnel_routes_to(config: &Value, dns_name: &str, port: u16) -> bool {
    let host_port = format!("{dns_name}:443");
    let allowed = config
        .get("AllowFunnel")
        .and_then(|a| a.get(&host_port))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let proxy = config
        .get("Web")
        .and_then(|w| w.get(&host_port))
        .and_then(|h| h.pointer("/Handlers"))
        .and_then(|h| h.get(MOUNT_PATH))
        .and_then(|h| h.get("Proxy"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let proxy = proxy.trim_end_matches('/');
    allowed
        && (proxy == format!("http://127.0.0.1:{port}")
            || proxy == format!("http://localhost:{port}"))
}

pub async fn funnel_active(dns_name: &str, port: u16) -> bool {
    let Ok(output) = run_cli(&["funnel", "status", "--json"], 8).await else {
        return false;
    };
    serde_json::from_slice::<Value>(&output.stdout)
        .map(|config| funnel_routes_to(&config, dns_name, port))
        .unwrap_or(false)
}

/// What happened when we asked for a Funnel.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum FunnelOutcome {
    On,
    /// The tailnet hasn't allowed Funnel (or HTTPS certificates) yet. The CLI
    /// prints a login.tailscale.com link where the owner switches it on.
    NeedsApproval {
        url: String,
    },
    Failed {
        detail: String,
    },
}

/// Find the first `https://login.tailscale.com/...` link in CLI output.
pub fn approval_url(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|w| w.starts_with("https://login.tailscale.com/"))
        .map(|w| w.trim_end_matches(['.', ',', ')']).to_string())
}

/// Turn the Funnel on for our mount.
///
/// Not run through `run_with_timeout`: when Funnel needs approval the CLI
/// prints the approval link and then *waits* for it, so the useful output
/// arrives before the command ends — and a timeout that discards captured
/// output would throw away the one thing we need. This reads both streams as
/// they arrive and stops as soon as it sees the link, the process exits, or
/// the deadline passes; the child is killed on drop either way.
pub async fn enable_funnel(port: u16) -> FunnelOutcome {
    let target = format!("http://127.0.0.1:{port}");
    let set_path = format!("--set-path={MOUNT_PATH}");
    run_until_settled(&["funnel", "--bg", "--https=443", &set_path, &target]).await
}

/// Run a `serve`/`funnel` command that may stop to print an approval link
/// and wait (see [`enable_funnel`]).
async fn run_until_settled(args: &[&str]) -> FunnelOutcome {
    let Some(bin) = find_binary() else {
        return FunnelOutcome::Failed {
            detail: "Tailscale isn't installed.".to_string(),
        };
    };
    let mut cmd = cli_command(bin);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return FunnelOutcome::Failed {
                detail: format!("Could not run tailscale: {e}"),
            }
        }
    };
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut captured = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut out_buf = [0u8; 2048];
    let mut err_buf = [0u8; 2048];

    loop {
        if let Some(url) = approval_url(&captured) {
            return FunnelOutcome::NeedsApproval { url };
        }
        tokio::select! {
            n = async { match stdout.as_mut() { Some(s) => s.read(&mut out_buf).await, None => std::future::pending().await } } => {
                match n { Ok(0) | Err(_) => stdout = None, Ok(n) => captured.push_str(&String::from_utf8_lossy(&out_buf[..n])) }
            }
            n = async { match stderr.as_mut() { Some(s) => s.read(&mut err_buf).await, None => std::future::pending().await } } => {
                match n { Ok(0) | Err(_) => stderr = None, Ok(n) => captured.push_str(&String::from_utf8_lossy(&err_buf[..n])) }
            }
            status = child.wait(), if stdout.is_none() && stderr.is_none() => {
                if let Some(url) = approval_url(&captured) {
                    return FunnelOutcome::NeedsApproval { url };
                }
                return match status {
                    Ok(s) if s.success() => FunnelOutcome::On,
                    _ => FunnelOutcome::Failed { detail: captured.trim().to_string() },
                };
            }
            _ = tokio::time::sleep_until(deadline) => {
                return FunnelOutcome::Failed {
                    detail: if captured.trim().is_empty() {
                        "Tailscale didn't answer within 20 seconds.".to_string()
                    } else {
                        captured.trim().to_string()
                    },
                };
            }
        }
    }
}

/// Remove our mount from the Funnel. Leaves anything else the user serves.
pub async fn disable_funnel() -> Result<(), CommandError> {
    let set_path = format!("--set-path={MOUNT_PATH}");
    let output = run_cli(&["funnel", "--https=443", &set_path, "off"], 10).await?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    // Already off is the outcome we wanted.
    if stderr.contains("not found") || stderr.contains("does not exist") {
        return Ok(());
    }
    Err(CommandError::expected(format!(
        "Tailscale couldn't turn the link off: {}",
        stderr.trim()
    )))
}

// ============================================================================
// Serve on the tailnet only (the mobile companion)
// ============================================================================
//
// The companion is published with `tailscale serve` on its own HTTPS port,
// tailnet only. It never touches the Funnel's port or mount, and only ever
// edits its own port's handler.

/// Is `https_port` on `dns_name` served to our loopback `port`, and *not*
/// funnelled? The serve config shape is:
///
/// ```json
/// { "TCP": { "47443": { "HTTPS": true } },
///   "Web": { "host.ts.net:47443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:4321" } } } } }
/// ```
pub fn serve_routes_to(config: &Value, dns_name: &str, https_port: u16, port: u16) -> bool {
    let host_port = format!("{dns_name}:{https_port}");
    let funnelled = config
        .get("AllowFunnel")
        .and_then(|a| a.get(&host_port))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let proxy = config
        .get("Web")
        .and_then(|w| w.get(&host_port))
        .and_then(|h| h.get("Handlers"))
        .and_then(|h| h.get("/"))
        .and_then(|h| h.get("Proxy"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('/');
    !funnelled
        && (proxy == format!("http://127.0.0.1:{port}")
            || proxy == format!("http://localhost:{port}"))
}

/// Read back whether our serve handler is in place.
pub async fn serve_active(dns_name: &str, https_port: u16, port: u16) -> bool {
    let Ok(output) = run_cli(&["serve", "status", "--json"], 8).await else {
        return false;
    };
    serde_json::from_slice::<Value>(&output.stdout)
        .map(|config| serve_routes_to(&config, dns_name, https_port, port))
        .unwrap_or(false)
}

/// Serve loopback `port` on the tailnet at `https://<machine>.ts.net:<https_port>`.
/// Verified by reading the config back, never by the exit code alone.
pub async fn enable_serve(https_port: u16, port: u16, dns_name: &str) -> FunnelOutcome {
    let https = format!("--https={https_port}");
    let target = format!("http://127.0.0.1:{port}");
    let outcome = run_until_settled(&["serve", "--bg", &https, &target]).await;
    if outcome == FunnelOutcome::On && !serve_active(dns_name, https_port, port).await {
        return FunnelOutcome::Failed {
            detail: "Tailscale accepted the command but isn't serving the port.".to_string(),
        };
    }
    outcome
}

/// Remove our port's handler. Anything else served is left alone.
pub async fn disable_serve(https_port: u16) -> Result<(), CommandError> {
    let https = format!("--https={https_port}");
    let output = run_cli(&["serve", &https, "off"], 10).await?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("not found")
        || stderr.contains("does not exist")
        || stderr.contains("not serving")
    {
        return Ok(());
    }
    Err(CommandError::expected(format!(
        "Tailscale couldn't stop serving the phone port: {}",
        stderr.trim()
    )))
}

// ============================================================================
// Is it reachable from the internet?
// ============================================================================
//
// "Funnel on" in the serve config is not the same as "reachable". The first
// time Funnel is enabled, Tailscale still has to publish the machine's name in
// public DNS, and until it does the link resolves nowhere outside the tailnet
// — while on this Mac MagicDNS resolves it fine, so a local request proves
// nothing. A user who pasted the link into Grok Bot during that window got
// "this address is only reachable inside your tailnet" while we said "Live".
//
// So: look the name up the way the internet does (DNS-over-HTTPS to a public
// resolver), then send one authenticated ping to that public address. Only an
// answer from our own server counts. The probe carries a per-run header so it
// is never mistaken for an assistant connecting.

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum Reachability {
    /// A request through the public internet reached this server.
    Reachable,
    /// Public DNS doesn't know the name yet — normal for a few minutes after
    /// Funnel is first turned on.
    NoPublicDns,
    /// The name resolves but the request didn't get through.
    Unreachable { detail: String },
}

const DOH_URL: &str = "https://cloudflare-dns.com/dns-query";

/// Pull the A records out of a DNS-over-HTTPS JSON answer.
pub fn parse_doh_answer(json: &Value) -> Vec<std::net::Ipv4Addr> {
    json.get("Answer")
        .and_then(Value::as_array)
        .map(|answers| {
            answers
                .iter()
                .filter(|a| a.get("type").and_then(Value::as_u64) == Some(1))
                .filter_map(|a| a.get("data").and_then(Value::as_str)?.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

async fn public_ipv4(dns_name: &str) -> Result<Vec<std::net::Ipv4Addr>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let json: Value = client
        .get(DOH_URL)
        .query(&[("name", dns_name), ("type", "A")])
        .header("accept", "application/dns-json")
        .send()
        .await
        .map_err(|e| format!("public DNS lookup failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("public DNS lookup failed: {e}"))?;
    Ok(parse_doh_answer(&json))
}

static REACHABILITY_CACHE: std::sync::LazyLock<
    std::sync::Mutex<Option<(String, std::time::Instant, Reachability)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// Probe the public path, at most every 30 s once reachable (10 s while not),
/// since the modal polls every 5 s.
pub async fn public_reachability(dns_name: &str, token: &str) -> Reachability {
    if let Ok(cache) = REACHABILITY_CACHE.lock() {
        if let Some((name, at, result)) = cache.as_ref() {
            let ttl = if *result == Reachability::Reachable {
                30
            } else {
                10
            };
            if name == dns_name && at.elapsed() < Duration::from_secs(ttl) {
                return result.clone();
            }
        }
    }
    let result = probe(dns_name, token).await;
    if let Ok(mut cache) = REACHABILITY_CACHE.lock() {
        *cache = Some((
            dns_name.to_string(),
            std::time::Instant::now(),
            result.clone(),
        ));
    }
    result
}

/// Forget the last probe — after the link is replaced or Funnel re-enabled.
pub fn forget_reachability() {
    if let Ok(mut cache) = REACHABILITY_CACHE.lock() {
        *cache = None;
    }
}

async fn probe(dns_name: &str, token: &str) -> Reachability {
    let ips = match public_ipv4(dns_name).await {
        Ok(ips) if ips.is_empty() => return Reachability::NoPublicDns,
        Ok(ips) => ips,
        Err(detail) => return Reachability::Unreachable { detail },
    };
    let addr = std::net::SocketAddr::from((ips[0], 443));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .resolve(dns_name, addr)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Reachability::Unreachable {
                detail: e.to_string(),
            }
        }
    };
    let url = format!("https://{dns_name}{MOUNT_PATH}/mcp/{token}");
    let response = client
        .post(url)
        .header(
            super::server::PROBE_HEADER,
            super::server::PROBE_ID.as_str(),
        )
        .json(&serde_json::json!({ "jsonrpc": "2.0", "id": 0, "method": "ping" }))
        .send()
        .await;
    match response {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) if v.get("result").is_some() => Reachability::Reachable,
            _ => Reachability::Unreachable {
                detail: "Something answered at this address, but not Ship Studio.".into(),
            },
        },
        Ok(r) => Reachability::Unreachable {
            detail: format!("The public address answered {}.", r.status()),
        },
        // `without_url`: reqwest's message otherwise includes the URL, which
        // contains the connector token — and this text is shown in the UI.
        Err(e) => Reachability::Unreachable {
            detail: format!("Couldn't reach the public address: {}", e.without_url()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_records_from_a_doh_answer() {
        let answer = json!({
            "Status": 0,
            "Answer": [
                { "name": "m.t.ts.net", "type": 5, "data": "alias.example." },
                { "name": "m.t.ts.net", "type": 1, "data": "203.0.113.7" }
            ]
        });
        assert_eq!(
            parse_doh_answer(&answer),
            vec!["203.0.113.7".parse::<std::net::Ipv4Addr>().unwrap()]
        );
        // NXDOMAIN: no Answer at all — the state a fresh Funnel is in.
        assert!(parse_doh_answer(&json!({ "Status": 3 })).is_empty());
    }
    use serde_json::json;

    #[test]
    fn running_with_a_name_is_connected() {
        let s = parse_status(&json!({
            "BackendState": "Running",
            "Self": { "DNSName": "studio-mac.tail1234.ts.net." }
        }));
        assert_eq!(
            s,
            TailscaleState::Connected {
                dns_name: "studio-mac.tail1234.ts.net".to_string()
            }
        );
    }

    #[test]
    fn anything_but_running_needs_login() {
        for state in ["NeedsLogin", "Stopped", "Starting", "NoState"] {
            assert_eq!(
                parse_status(&json!({ "BackendState": state })),
                TailscaleState::NeedsLogin
            );
        }
    }

    #[test]
    fn running_without_a_name_is_not_claimed_as_connected() {
        assert!(matches!(
            parse_status(&json!({ "BackendState": "Running", "Self": {} })),
            TailscaleState::Unknown { .. }
        ));
    }

    #[test]
    fn funnel_is_on_only_when_our_mount_routes_to_our_port() {
        let host = "m.t.ts.net";
        let config = json!({
            "Web": { "m.t.ts.net:443": { "Handlers": { "/shipstudio": { "Proxy": "http://127.0.0.1:4321" } } } },
            "AllowFunnel": { "m.t.ts.net:443": true }
        });
        assert!(funnel_routes_to(&config, host, 4321));
        assert!(!funnel_routes_to(&config, host, 9999), "wrong port");

        let served_not_funnelled = json!({
            "Web": { "m.t.ts.net:443": { "Handlers": { "/shipstudio": { "Proxy": "http://127.0.0.1:4321" } } } }
        });
        assert!(!funnel_routes_to(&served_not_funnelled, host, 4321));

        let someone_elses_root = json!({
            "Web": { "m.t.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:4321" } } } },
            "AllowFunnel": { "m.t.ts.net:443": true }
        });
        assert!(!funnel_routes_to(&someone_elses_root, host, 4321));
        assert!(!funnel_routes_to(&json!({}), host, 4321));
    }

    #[test]
    fn serve_is_on_only_for_our_port_and_never_funnelled() {
        let dns = "mac.tail1.ts.net";
        let config = json!({
            "TCP": { "47443": { "HTTPS": true }, "443": { "HTTPS": true } },
            "Web": {
                "mac.tail1.ts.net:47443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:5000" } } },
                "mac.tail1.ts.net:443": { "Handlers": { "/shipstudio": { "Proxy": "http://127.0.0.1:6000" } } }
            },
            "AllowFunnel": { "mac.tail1.ts.net:443": true }
        });
        assert!(serve_routes_to(&config, dns, 47443, 5000));
        assert!(!serve_routes_to(&config, dns, 47443, 5001), "another port");
        assert!(
            !serve_routes_to(&config, dns, 443, 6000),
            "the Funnel's mount isn't ours"
        );
        let mut funnelled = config.clone();
        funnelled["AllowFunnel"]["mac.tail1.ts.net:47443"] = json!(true);
        assert!(
            !serve_routes_to(&funnelled, dns, 47443, 5000),
            "a funnelled port is never reported as the tailnet-only route"
        );
        assert!(!serve_routes_to(&json!({}), dns, 47443, 5000));
    }

    #[test]
    fn serializes_the_shape_the_frontend_reads() {
        let s = TailscaleState::Connected {
            dns_name: "m.t.ts.net".into(),
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({ "state": "connected", "dnsName": "m.t.ts.net" })
        );
        assert_eq!(
            serde_json::to_value(TailscaleState::NotInstalled).unwrap(),
            json!({ "state": "notInstalled" })
        );
    }

    #[test]
    fn finds_the_approval_link() {
        let out = "Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=abc123\n\n";
        assert_eq!(
            approval_url(out).as_deref(),
            Some("https://login.tailscale.com/f/funnel?node=abc123")
        );
        assert_eq!(
            approval_url("Available on the internet: https://m.t.ts.net/shipstudio"),
            None
        );
    }
}
