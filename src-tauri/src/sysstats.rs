//! Machine vitals for the Orchestrator panel's System tab.
//!
//! Agents are expensive neighbours: a handful of them compiling at once is the
//! difference between a responsive machine and a stalled one, and the first sign
//! is swap, not CPU. So this reports the same handful of numbers a terminal
//! status line does -- CPU, memory, swap, disk, load, uptime -- and leaves the
//! judgement to the person reading them.
//!
//! `sysinfo` measures CPU as a delta between two refreshes, so the `System` is
//! kept alive between calls; a fresh one every poll would report nonsense.

use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{Disks, System};

/// One sample of the machine's vitals. Bytes stay bytes: the UI decides whether
/// this machine's memory reads better as GB or as a percentage.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// Whole-machine CPU use, 0-100.
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    /// Swap in use. On a healthy desktop this is ~0; growth here is the warning.
    pub swap_used: u64,
    pub swap_total: u64,
    /// The disk the app itself lives on, not every mount.
    pub disk_used: u64,
    pub disk_total: u64,
    /// 1-minute load average. Always 0 on Windows, which has no such concept —
    /// the UI hides it rather than drawing a permanent zero.
    pub load1: f64,
    pub uptime_secs: u64,
    /// Physical cores, so a load average means something to whoever reads it.
    pub cores: usize,
}

/// Kept between calls purely so CPU percentages have something to diff against.
static SYS: Mutex<Option<System>> = Mutex::new(None);

/// Sample the machine now.
#[tauri::command]
pub fn system_stats() -> SystemStats {
    let mut guard = match SYS.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(), // a poisoned lock costs a stale sample, not the panel
    };
    let sys = guard.get_or_insert_with(System::new);
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    // The disk holding the current directory — the one that fills up with
    // worktrees and build output, which is the one worth watching.
    let (disk_used, disk_total) = current_disk();

    SystemStats {
        cpu: sys.global_cpu_usage(),
        mem_used: sys.used_memory(),
        mem_total: sys.total_memory(),
        swap_used: sys.used_swap(),
        swap_total: sys.total_swap(),
        disk_used,
        disk_total,
        load1: System::load_average().one,
        uptime_secs: System::uptime(),
        cores: System::physical_core_count().unwrap_or(0),
    }
}

/// Used/total bytes of the disk the working directory sits on. Picks the mount
/// with the longest matching prefix, so `C:\` never wins over a deeper mount.
fn current_disk() -> (u64, u64) {
    let cwd = match std::env::current_dir() {
        Ok(c) => c,
        Err(_) => return (0, 0),
    };
    let disks = Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64, u64)> = None;
    for d in disks.list() {
        let mount = d.mount_point();
        if !cwd.starts_with(mount) {
            continue;
        }
        let depth = mount.components().count();
        let total = d.total_space();
        let used = total.saturating_sub(d.available_space());
        if best.map(|(b, _, _)| depth > b).unwrap_or(true) {
            best = Some((depth, used, total));
        }
    }
    best.map(|(_, u, t)| (u, t)).unwrap_or((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sample_is_internally_consistent() {
        let s = system_stats();
        assert!(s.mem_total > 0, "a machine has memory");
        assert!(s.mem_used <= s.mem_total);
        assert!(s.swap_used <= s.swap_total);
        assert!(s.disk_used <= s.disk_total);
        assert!((0.0..=100.0).contains(&s.cpu), "cpu was {}", s.cpu);
    }

    #[test]
    fn the_working_disk_is_found() {
        let (used, total) = current_disk();
        assert!(total > 0, "the current directory is on some disk");
        assert!(used <= total);
    }

    #[test]
    fn repeated_samples_keep_working() {
        // The System is reused between calls; a second sample must still be sane
        // (this is what a fresh System per call would get wrong).
        let _ = system_stats();
        let s = system_stats();
        assert!(s.mem_total > 0);
        assert!((0.0..=100.0).contains(&s.cpu));
    }
}
