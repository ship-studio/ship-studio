//! A turn's whole process tree: `claude` and everything it started.
//!
//! Killing only `claude` leaves what its Bash tool ran (`npm run dev`, a test
//! watcher, a long build) running as an orphan that holds its port and CPU.
//! So a turn's `claude` leads its own process group, and stopping a turn
//! signals that group *and* every descendant found by walking the tree first:
//! a child that called `setsid` (a backgrounded shell often does) has left the
//! group but is still a descendant until its parent dies, which is why the
//! walk comes before any signal.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Turns in flight: agent id → its `claude` pid (also its process group).
static LIVE: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// How long a tree gets to exit on SIGTERM before SIGKILL.
const GRACE: Duration = Duration::from_millis(1500);

/// Make a spawned `claude` the leader of a new process group.
pub fn own_group(cmd: &mut tokio::process::Command) {
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(not(unix))]
    let _ = cmd;
}

pub fn register(agent_id: &str, pid: u32) {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(agent_id.to_string(), pid);
}

pub fn unregister(agent_id: &str) {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(agent_id);
}

/// Every turn's tree, stopped. For the app's exit, which can't wait on tokio.
/// Returns how many turns were running.
pub fn kill_all_sync() -> usize {
    let pids: Vec<u32> = LIVE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain()
        .map(|(_, pid)| pid)
        .collect();
    let mut trees: Vec<u32> = Vec::new();
    for pid in &pids {
        trees.extend(tree(*pid));
    }
    signal_all(&pids, &trees);
    pids.len()
}

/// Stop one tree: SIGTERM, then SIGKILL whatever is left after a grace period.
/// Blocking (it waits); call it from `spawn_blocking`.
pub fn kill_tree_sync(root: u32) {
    let members = tree(root);
    signal_all(&[root], &members);
}

fn signal_all(groups: &[u32], members: &[u32]) {
    send(groups, members, Signal::Term);
    // A group leader is our own child: it stays a zombie until tokio reaps
    // it, so only the rest of the tree is watched.
    let watched: Vec<u32> = members
        .iter()
        .copied()
        .filter(|pid| !groups.contains(pid))
        .collect();
    let deadline = Instant::now() + GRACE;
    while Instant::now() < deadline && watched.iter().any(|pid| alive(*pid)) {
        std::thread::sleep(Duration::from_millis(50));
    }
    // Then SIGKILL for whatever is left, and always for the leaders: Claude
    // Code doesn't reliably exit on SIGTERM (observed: still running, its
    // children already gone), and a leader's liveness can't be read here.
    // By pid too, for a leader that never got its own group (a turn left
    // over from a build before groups).
    let left: Vec<u32> = watched.into_iter().filter(|pid| alive(*pid)).collect();
    send(groups, &left, Signal::Kill);
    for leader in groups {
        kill_one(*leader, Signal::Kill);
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
fn send(groups: &[u32], members: &[u32], signal: Signal) {
    let sig = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    for group in groups {
        // SAFETY: plain syscalls on pids we spawned (or their descendants);
        // a stale pid only yields ESRCH.
        unsafe { libc::killpg(*group as libc::pid_t, sig) };
    }
    for pid in members {
        unsafe { libc::kill(*pid as libc::pid_t, sig) };
    }
}

#[cfg(not(unix))]
fn send(_groups: &[u32], members: &[u32], _signal: Signal) {
    for pid in members {
        let mut cmd = crate::utils::create_command("taskkill");
        cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
        let _ = cmd.spawn().and_then(|mut c| c.wait());
    }
}

#[cfg(unix)]
fn kill_one(pid: u32, signal: Signal) {
    send(&[], &[pid], signal);
}

#[cfg(not(unix))]
fn kill_one(_pid: u32, _signal: Signal) {}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the pid exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn alive(_pid: u32) -> bool {
    false
}

/// `root` and all its descendants, from one `ps` snapshot.
pub fn tree(root: u32) -> Vec<u32> {
    let mut members = vec![root];
    let Some(table) = process_table() else {
        return members;
    };
    let mut seen: HashSet<u32> = members.iter().copied().collect();
    let mut i = 0;
    while i < members.len() {
        let parent = members[i];
        for (pid, ppid) in &table {
            if *ppid == parent && seen.insert(*pid) {
                members.push(*pid);
            }
        }
        i += 1;
    }
    members
}

/// (pid, ppid) for every process.
#[cfg(unix)]
fn process_table() -> Option<Vec<(u32, u32)>> {
    let mut ps = crate::utils::create_command("ps");
    ps.args(["-axo", "pid=,ppid="])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Sync on purpose: this runs at exit, where there is no runtime to await on.
    #[allow(clippy::disallowed_methods)]
    let out = ps.output().ok()?;
    Some(parse_table(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(not(unix))]
fn process_table() -> Option<Vec<(u32, u32)>> {
    None
}

fn parse_table(raw: &str) -> Vec<(u32, u32)> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
        })
        .collect()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn parses_ps_output() {
        assert_eq!(
            parse_table("  1     0\n 42  1\nbad line\n"),
            vec![(1, 0), (42, 1)]
        );
    }

    #[test]
    fn kills_a_backgrounded_grandchild_too() {
        // sh → (setsid-like) background sleep; the sleep must die with the tree.
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "sleep 300 & echo $!; wait"])
            .stdout(std::process::Stdio::piped());
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        let mut child = cmd.spawn().unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(child.stdout.take().unwrap()),
            &mut line,
        )
        .unwrap();
        let sleeper: u32 = line.trim().parse().unwrap();
        assert!(alive(sleeper));
        kill_tree_sync(child.id());
        let _ = child.wait();
        // Reaped by init/launchd shortly after it dies.
        let deadline = Instant::now() + Duration::from_secs(3);
        while alive(sleeper) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(sleeper), "the grandchild outlived Stop");
    }
}
