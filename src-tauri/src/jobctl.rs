//! Process containment: a Windows **Job Object**, or process groups elsewhere.
//!
//! Windows does not kill child processes when their parent dies. So if OctoShell
//! crashes, is force-killed, or is replaced by a dev hot-reload, every shell and
//! agent it spawned (`pwsh.exe`, the warm completion runspace, `claude`/`gemini`,
//! and anything *those* spawn) would be orphaned — slowly piling up in Task
//! Manager and eating RAM.
//!
//! The fix is a single Job Object created at startup with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Every process we spawn is assigned to
//! it. A process in a job passes membership to its own children automatically, so
//! assigning the top-level process covers its whole tree. When OctoShell exits —
//! gracefully or not — the OS closes our last handle to the job and terminates
//! everything still inside it.

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    // The job handle, kept open for the whole process lifetime (stored as `isize`
    // because a raw `HANDLE` pointer is neither `Send` nor `Sync`). It is never
    // closed: the OS closing it on exit is precisely what kills the children.
    static JOB: OnceLock<isize> = OnceLock::new();

    /// Create the kill-on-close job. Idempotent; call once at startup before any
    /// child is spawned. On failure the job stays 0 and [`add`] becomes a no-op.
    pub fn init() {
        JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            job as isize
        });
    }

    /// Assign a spawned process (by PID) to the job, so it — and its descendants —
    /// die with OctoShell. Best-effort: failures are silently ignored (the worst
    /// case is the pre-existing orphan behaviour for that one process).
    /// Nothing to do: the OS closing our last job handle on exit is what kills
    /// the children. (The Unix side needs an explicit sweep; see below.)
    pub fn shutdown() {}

    pub fn add(pid: u32) {
        let Some(&job) = JOB.get() else { return };
        if job == 0 || pid == 0 {
            return;
        }
        unsafe {
            // PROCESS_SET_QUOTA + PROCESS_TERMINATE are the rights
            // AssignProcessToJobObject requires.
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc.is_null() {
                return;
            }
            AssignProcessToJobObject(job as HANDLE, proc);
            CloseHandle(proc);
        }
    }
}

/// macOS / Linux: there is no kill-on-close Job Object, but there is something
/// close. Every child OctoShell spawns is made the leader of its own process
/// group (`platform::own_process_group`), and this registry remembers those
/// leaders. On a clean exit [`shutdown`] signals every registered group, ending
/// each helper together with whatever it spawned. Shells in a PTY need no help
/// even on a crash: closing the PTY master sends them SIGHUP.
#[cfg(not(windows))]
mod imp {
    use std::sync::Mutex;

    static CHILDREN: Mutex<Vec<u32>> = Mutex::new(Vec::new());

    pub fn init() {}

    /// Remember a spawned group leader so [`shutdown`] can end its tree.
    pub fn add(pid: u32) {
        if pid == 0 {
            return;
        }
        let mut c = CHILDREN.lock().unwrap();
        if !c.contains(&pid) {
            c.push(pid);
        }
    }

    /// End every registered process tree. Called once, on app exit.
    pub fn shutdown() {
        let pids: Vec<u32> = std::mem::take(&mut *CHILDREN.lock().unwrap());
        crate::platform::kill_trees(&pids);
    }
}

pub use imp::{add, init, shutdown};
