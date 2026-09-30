//! Creating the sandboxed process and the job that contains it.

use std::collections::BTreeMap;
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
};
use windows::Win32::Security::SECURITY_CAPABILITIES;
use windows::Win32::System::Console::{
    GetConsoleMode, GetStdHandle, CONSOLE_MODE, STD_ERROR_HANDLE, STD_INPUT_HANDLE,
    STD_OUTPUT_HANDLE,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicUIRestrictions,
    JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_BASIC_UI_RESTRICTIONS,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
};
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use super::appcontainer::{Capabilities, Sid};
use super::{wide, Error};
use crate::policy::ValidPolicy;

/// Closes a handle when dropped.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_invalid() && !self.0 .0.is_null() {
            // SAFETY: the handle is owned by this value and closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// The job every process of the command belongs to. Closing it (when this program exits) ends them all,
/// unless the policy lets background processes live on.
pub struct Job(Owned);

impl Job {
    pub fn new(policy: &ValidPolicy) -> Result<Self, Error> {
        // SAFETY: no name and default security; the handle is owned by `Job`.
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|e| Error::new("job object", e))?;
        let job = Job(Owned(handle));

        // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is a valid "no limits" value.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        let mut flags =
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if !policy.keep_background {
            flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        }
        limits.BasicLimitInformation.ActiveProcessLimit = policy.max_processes;
        if let Some(mb) = policy.memory_mb {
            flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.JobMemoryLimit = (mb as usize).saturating_mul(1024 * 1024);
        }
        limits.BasicLimitInformation.LimitFlags = flags;
        // SAFETY: the pointer and size describe `limits`, which outlives the call.
        unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|e| Error::new("job limits", e))?;

        let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_DESKTOP
                | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                | JOB_OBJECT_UILIMIT_EXITWINDOWS
                | JOB_OBJECT_UILIMIT_GLOBALATOMS
                | JOB_OBJECT_UILIMIT_HANDLES
                | JOB_OBJECT_UILIMIT_READCLIPBOARD
                | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                | JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
        };
        // SAFETY: the pointer and size describe `ui`, which outlives the call.
        unsafe {
            SetInformationJobObject(
                handle,
                JobObjectBasicUIRestrictions,
                (&ui as *const JOBOBJECT_BASIC_UI_RESTRICTIONS).cast(),
                size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
            )
        }
        .map_err(|e| Error::new("job ui limits", e))?;
        Ok(job)
    }
}

pub struct Launch<'a> {
    pub policy: &'a ValidPolicy,
    pub sid: &'a Sid,
    pub capabilities: &'a Capabilities,
    pub job: &'a Job,
    pub command_line: &'a str,
    pub cwd: &'a str,
}

/// The environment the command sees: ours, minus the sandbox's own settings, with the scratch folder as TEMP.
fn environment(policy: &ValidPolicy) -> Vec<u16> {
    let mut vars: BTreeMap<String, (std::ffi::OsString, std::ffi::OsString)> = BTreeMap::new();
    for (name, value) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_uppercase();
        if upper.starts_with("HARNESS_SANDBOX") {
            continue;
        }
        vars.insert(upper, (name, value));
    }
    for (name, value) in [
        ("TEMP", policy.temp_dir.as_str()),
        ("TMP", policy.temp_dir.as_str()),
        ("HARNESS_SANDBOXED", "appcontainer"),
    ] {
        vars.insert(name.to_string(), (name.into(), value.into()));
    }
    let mut block: Vec<u16> = Vec::new();
    for (name, value) in vars.values() {
        block.extend(name.encode_wide());
        block.push('=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

fn is_console(handle: HANDLE) -> bool {
    let mut mode = CONSOLE_MODE(0);
    // SAFETY: `handle` may be anything; GetConsoleMode only fails for a non-console.
    !handle.is_invalid()
        && !handle.0.is_null()
        && unsafe { GetConsoleMode(handle, &mut mode) }.is_ok()
}

pub fn run(launch: &Launch<'_>) -> Result<u32, Error> {
    // SAFETY: standard handle lookups have no preconditions.
    let (stdin, stdout, stderr) = unsafe {
        (
            GetStdHandle(STD_INPUT_HANDLE).unwrap_or(INVALID_HANDLE_VALUE),
            GetStdHandle(STD_OUTPUT_HANDLE).unwrap_or(INVALID_HANDLE_VALUE),
            GetStdHandle(STD_ERROR_HANDLE).unwrap_or(INVALID_HANDLE_VALUE),
        )
    };
    // Attached to a terminal (the Harness terminal pane): let the shell use the same console. Otherwise the
    // engine gave us pipes, and only those three handles are passed on.
    let interactive = is_console(stdin) && is_console(stdout) && is_console(stderr);
    let mut passed: Vec<HANDLE> = Vec::new();
    if !interactive {
        for handle in [stdin, stdout, stderr] {
            if !handle.is_invalid() && !handle.0.is_null() && !passed.contains(&handle) {
                // SAFETY: the handle is one of our own standard handles.
                unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }
                    .map_err(|e| Error::new("standard handles", e))?;
                passed.push(handle);
            }
        }
    }

    let mut container = SECURITY_CAPABILITIES {
        AppContainerSid: launch.sid.psid,
        Capabilities: if launch.capabilities.entries.is_empty() {
            std::ptr::null_mut()
        } else {
            launch.capabilities.entries.as_ptr().cast_mut()
        },
        CapabilityCount: launch.capabilities.entries.len() as u32,
        Reserved: 0,
    };

    let attribute_count = if interactive { 1 } else { 2 };
    let mut size = 0usize;
    // The first call only reports how much room the list needs, and is expected to fail for that reason.
    // SAFETY: a null list with a size out-pointer is the documented way to ask.
    let _ = unsafe { InitializeProcThreadAttributeList(None, attribute_count, None, &mut size) };
    // A u64 buffer so the list is 8-byte aligned.
    let mut storage = vec![0u64; size.div_ceil(8).max(1)];
    let list = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast::<c_void>());
    // SAFETY: `storage` is at least `size` bytes and aligned; it outlives the list and CreateProcessW.
    unsafe { InitializeProcThreadAttributeList(Some(list), attribute_count, None, &mut size) }
        .map_err(|e| Error::new("process attributes", e))?;
    let _list_guard = ListGuard(list);
    // SAFETY: `container` and the capability array it points at outlive CreateProcessW.
    unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            Some(
                (&mut container as *mut SECURITY_CAPABILITIES)
                    .cast::<c_void>()
                    .cast_const(),
            ),
            size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
    }
    .map_err(|e| Error::new("appcontainer attribute", e))?;
    if !interactive && !passed.is_empty() {
        // SAFETY: `passed` outlives CreateProcessW.
        unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(passed.as_ptr().cast::<c_void>()),
                passed.len() * size_of::<HANDLE>(),
                None,
                None,
            )
        }
        .map_err(|e| Error::new("handle list attribute", e))?;
    }

    // SAFETY: an all-zero STARTUPINFOEXW is a valid starting point; the fields that matter are set next.
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = list;
    if !interactive {
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin;
        startup.StartupInfo.hStdOutput = stdout;
        startup.StartupInfo.hStdError = stderr;
    }

    let application = wide(&launch.policy.shell);
    let mut command_line = wide(launch.command_line);
    let cwd = wide(launch.cwd);
    let environment = environment(launch.policy);
    let mut flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
    if !interactive {
        // The engine gave us pipes; without this a console shell would open a window of its own.
        flags |= CREATE_NO_WINDOW;
    }
    // SAFETY: an all-zero PROCESS_INFORMATION is the documented out-parameter initial value.
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    // SAFETY: every pointer refers to a live, NUL-terminated buffer that outlives the call.
    unsafe {
        CreateProcessW(
            PCWSTR(application.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            !interactive && !passed.is_empty(),
            flags,
            Some(environment.as_ptr().cast::<c_void>()),
            PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo,
            &mut info,
        )
    }
    .map_err(|e| Error::new("start sandboxed process", e))?;
    let (process, thread) = (Owned(info.hProcess), Owned(info.hThread));

    // The process exists but has not run a single instruction. Put it in the job first; if that fails, kill it.
    // SAFETY: both handles are live and owned here.
    if let Err(e) = unsafe { AssignProcessToJobObject(launch.job.0 .0, process.0) } {
        // SAFETY: `process` is live.
        unsafe {
            let _ = TerminateProcess(process.0, 1);
        }
        return Err(Error::new("assign process to job", e));
    }
    // SAFETY: `thread` is the suspended primary thread of the process just created.
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        // SAFETY: `process` is live.
        unsafe {
            let _ = TerminateProcess(process.0, 1);
        }
        return Err(Error::new(
            "resume process",
            windows::core::Error::from_win32(),
        ));
    }

    // SAFETY: `process` is a live process handle with SYNCHRONIZE access.
    unsafe { WaitForSingleObject(process.0, INFINITE) };
    let mut code = 0u32;
    // SAFETY: `process` is live and `code` is a valid out-pointer.
    unsafe { GetExitCodeProcess(process.0, &mut code) }
        .map_err(|e| Error::new("exit status", e))?;
    Ok(code)
}

struct ListGuard(LPPROC_THREAD_ATTRIBUTE_LIST);

impl Drop for ListGuard {
    fn drop(&mut self) {
        // SAFETY: the list was initialised by InitializeProcThreadAttributeList and is deleted once.
        unsafe { DeleteProcThreadAttributeList(self.0) };
    }
}
