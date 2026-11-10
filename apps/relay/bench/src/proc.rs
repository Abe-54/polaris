//! Reads a process's CPU time and memory without spawning anything.

/// One reading of a process: CPU time used so far and memory held now.
#[derive(Clone, Copy, Debug, Default)]
pub struct Usage {
    /// User plus system CPU time, in nanoseconds.
    pub cpu_ns: u64,
    pub rss_bytes: u64,
    /// macOS physical footprint (what Activity Monitor shows); RSS elsewhere.
    pub footprint_bytes: u64,
}

#[cfg(target_os = "macos")]
pub fn usage(pid: i32) -> Option<Usage> {
    use std::mem::MaybeUninit;

    let mut info = MaybeUninit::<libc::rusage_info_v2>::zeroed();
    // SAFETY: `info` is a zeroed rusage_info_v2, the layout RUSAGE_INFO_V2 fills.
    let status = unsafe {
        libc::proc_pid_rusage(
            pid,
            libc::RUSAGE_INFO_V2,
            info.as_mut_ptr().cast::<libc::rusage_info_t>(),
        )
    };

    if status != 0 {
        return None;
    }

    // SAFETY: proc_pid_rusage returned 0, so it filled the struct.
    let info = unsafe { info.assume_init() };
    let (numer, denom) = timebase();
    let ticks = u128::from(info.ri_user_time) + u128::from(info.ri_system_time);

    Some(Usage {
        cpu_ns: (ticks * u128::from(numer) / u128::from(denom)) as u64,
        rss_bytes: info.ri_resident_size,
        footprint_bytes: info.ri_phys_footprint,
    })
}

/// Mach time units to nanoseconds: 125/3 on Apple silicon, 1/1 on Intel.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn timebase() -> (u32, u32) {
    let mut info = libc::mach_timebase_info { numer: 0, denom: 0 };
    // SAFETY: mach_timebase_info only writes the two fields of `info`.
    let status = unsafe { libc::mach_timebase_info(&mut info) };

    if status != 0 || info.denom == 0 {
        return (1, 1);
    }

    (info.numer, info.denom)
}

#[cfg(target_os = "linux")]
pub fn usage(pid: i32) -> Option<Usage> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name may hold spaces; the fields after it start past the last ')'.
    let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    // SAFETY: sysconf takes no pointers.
    let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
    // SAFETY: sysconf takes no pointers.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(1) as u64;
    let statm = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
    let resident: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;

    Some(Usage {
        cpu_ns: (utime + stime) * 1_000_000_000 / ticks_per_second,
        rss_bytes: resident * page,
        footprint_bytes: resident * page,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn usage(_pid: i32) -> Option<Usage> {
    None
}

/// The system's one-minute load average: how many threads wanted a core, this process aside.
pub fn load_average() -> f64 {
    let mut loads = [0f64; 3];
    // SAFETY: getloadavg writes at most the three doubles it is given.
    let read = unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) };

    if read < 1 { 0.0 } else { loads[0] }
}
