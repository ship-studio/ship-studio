//! How many turns may run at once, from this machine's memory.
//!
//! A turn is a `claude` process plus whatever its tools start; about 700 MB
//! each was measured elsewhere for the same CLI. A fixed cap of 3 was wrong
//! at both ends: a 64 GB Mac sat idle with work queued, and an 8 GB one could
//! still be pushed into swap by three heavy turns. So there is one slot per
//! 2 GB of RAM, never fewer than 3 or more than 16, and on a small machine a
//! turn also waits while free memory is short, unless nothing else is
//! running (a lone turn always gets to run).
//!
//! `SHIPSTUDIO_AGENTS_MAX_TURNS` still overrides the slot count, for tests.

const GIB: u64 = 1024 * 1024 * 1024;
const PER_SLOT: u64 = 2 * GIB;
pub const MIN_SLOTS: usize = 3;
pub const MAX_SLOTS: usize = 16;
/// At or under this much RAM, free memory is checked before each spawn.
const SMALL_MACHINE: u64 = 12 * GIB;
/// Room a turn needs to start without pushing the machine into swap.
const NEEDED_FREE: u64 = GIB;

/// Slots for a machine with `total` bytes of RAM (`None`: unknown).
pub fn slots_for(total: Option<u64>) -> usize {
    match total {
        Some(total) => ((total / PER_SLOT) as usize).clamp(MIN_SLOTS, MAX_SLOTS),
        None => MIN_SLOTS,
    }
}

/// Whether another turn may start now. Only small machines are gated, and
/// never when nothing else is running: refusing the only turn would just
/// stall it, not free anything.
pub fn room_for_another(total: Option<u64>, available: Option<u64>, running: usize) -> bool {
    if running == 0 {
        return true;
    }
    match (total, available) {
        (Some(total), Some(available)) if total <= SMALL_MACHINE => available >= NEEDED_FREE,
        _ => true,
    }
}

pub fn max_turns() -> usize {
    std::env::var("SHIPSTUDIO_AGENTS_MAX_TURNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| slots_for(total_memory()))
}

/// Whether another turn may start, on this machine, with `running` going.
pub fn room_now(running: usize) -> bool {
    room_for_another(total_memory(), available_memory(), running)
}

#[cfg(target_os = "macos")]
fn sysctl_u64(name: &str) -> Option<u64> {
    let name = std::ffi::CString::new(name).ok()?;
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: `value` is a u64 buffer of `size` bytes; sysctlbyname writes at
    // most `size` bytes and updates `size` with what it wrote.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    match (rc, size) {
        (0, 8) => Some(value),
        // A 32-bit answer (kern.memorystatus_level is an int).
        (0, 4) => Some(value & 0xffff_ffff),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn meminfo(key: &str) -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = text.lines().find(|l| l.starts_with(key))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

pub fn total_memory() -> Option<u64> {
    #[cfg(target_os = "macos")]
    return sysctl_u64("hw.memsize");
    #[cfg(target_os = "linux")]
    return meminfo("MemTotal:");
    #[allow(unreachable_code)]
    None
}

/// Memory free for a new process. On macOS, the kernel's own "memory free
/// percentage" (what `memory_pressure` prints) of the total.
pub fn available_memory() -> Option<u64> {
    #[cfg(target_os = "macos")]
    return {
        let percent = sysctl_u64("kern.memorystatus_level")?;
        Some(total_memory()? / 100 * percent.min(100))
    };
    #[cfg(target_os = "linux")]
    return meminfo("MemAvailable:");
    #[allow(unreachable_code)]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_slot_per_two_gigabytes_between_three_and_sixteen() {
        assert_eq!(slots_for(Some(4 * GIB)), 3);
        assert_eq!(slots_for(Some(8 * GIB)), 4);
        assert_eq!(slots_for(Some(16 * GIB)), 8);
        assert_eq!(slots_for(Some(18 * GIB)), 9);
        assert_eq!(slots_for(Some(24 * GIB)), 12);
        assert_eq!(slots_for(Some(32 * GIB)), 16);
        assert_eq!(slots_for(Some(128 * GIB)), 16);
        // Unknown: what it always was.
        assert_eq!(slots_for(None), 3);
    }

    #[test]
    fn small_machines_wait_for_free_memory_but_never_stall_a_lone_turn() {
        let small = Some(8 * GIB);
        assert!(room_for_another(small, Some(3 * GIB), 2));
        assert!(!room_for_another(small, Some(GIB / 2), 1));
        assert!(
            room_for_another(small, Some(GIB / 2), 0),
            "the only turn always runs"
        );
        // Big machines aren't gated; unknown memory isn't either.
        assert!(room_for_another(Some(32 * GIB), Some(GIB / 2), 5));
        assert!(room_for_another(small, None, 3));
        assert!(room_for_another(None, Some(0), 3));
    }

    #[test]
    fn this_machine_reports_its_memory() {
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            let total = total_memory().expect("total memory");
            assert!(total >= 2 * GIB);
            let free = available_memory().expect("free memory");
            assert!(free <= total);
            let slots = max_turns();
            assert!(
                (MIN_SLOTS..=MAX_SLOTS).contains(&slots)
                    || std::env::var("SHIPSTUDIO_AGENTS_MAX_TURNS").is_ok()
            );
        }
    }
}
