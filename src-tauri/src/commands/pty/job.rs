//! Windows Job Object that kills every process in it when its handle closes.
//!
//! `spawn_pty` runs commands as `cmd /C <command>`, a chain of processes
//! (cmd → npm → cmd → node …). `taskkill /T` finds descendants by parent PID,
//! so a process whose parent has already exited is invisible to it — and it
//! still holds the stdout/stderr pipe handles it inherited. Job membership is
//! inherited regardless of parentage, so closing the job reaches it.

use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Owns a job handle; dropping it terminates every process still in the job.
pub(super) struct KillOnCloseJob(HANDLE);

// The handle is a kernel object reference, usable from any thread.
unsafe impl Send for KillOnCloseJob {}

impl KillOnCloseJob {
    /// Create a kill-on-close job and put `child` (and so all its future
    /// descendants) in it. A process that explicitly asks to break away
    /// (`CREATE_BREAKAWAY_FROM_JOB`, e.g. a deliberate background daemon) is
    /// allowed to.
    ///
    /// There is a short window between spawn and assignment in which the child
    /// could start a process outside the job; `cmd.exe` takes far longer than
    /// that to launch anything.
    pub(super) fn assign(child: &std::process::Child) -> std::io::Result<Self> {
        // SAFETY: plain Win32 calls on handles we own (the job) or borrow for
        // the duration of the call (the child's process handle); the info
        // struct is a POD zero-initialised as the API documents.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Self(handle);

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            if SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }

            if AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        // SAFETY: we own the handle and close it exactly once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
