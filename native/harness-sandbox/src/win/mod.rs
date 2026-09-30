//! The Windows sandbox: an AppContainer plus a Job Object.
//!
//! An AppContainer token is denied everything it has not been explicitly granted. That gives, for free:
//! no read or write outside the folders in the policy, no network unless a capability is added, no access to
//! other processes of the same user (so the Harness app cannot be signalled or read), and no loopback to
//! other apps (so the Harness server and the memory engine are unreachable). The Job Object adds the parts
//! an AppContainer does not: everything the command started dies with it, a cap on how many processes and
//! how much memory it may use, and no touching the desktop or clipboard.
//!
//! Every step either succeeds or aborts the command. There is no fallback to running unsandboxed.

mod acl;
mod appcontainer;
mod process;

use std::fmt;

use crate::policy::{canonical, within, ValidPolicy};
use crate::shell::{command_line, ShellKind};

#[derive(Debug)]
pub struct Error {
    pub step: &'static str,
    pub detail: String,
}

impl Error {
    pub(crate) fn new(step: &'static str, detail: impl fmt::Display) -> Self {
        Self {
            step,
            detail: detail.to_string(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.step, self.detail)
    }
}

impl std::error::Error for Error {}

pub(crate) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Whether an AppContainer can be created here. Used by the app to decide if the sandbox is available.
pub fn probe(profile: &str) -> Result<(), Error> {
    appcontainer::profile_sid(profile).map(|_| ())
}

/// Take back the grants the policy made. The profile itself stays: it holds no rights of its own.
pub fn revoke(policy: &ValidPolicy) -> Result<(), Error> {
    let sid = appcontainer::profile_sid(&policy.profile)?;
    for path in policy.read_write.iter().chain(&policy.read_only) {
        if std::path::Path::new(path).exists() {
            acl::revoke(path, &sid)?;
        }
    }
    Ok(())
}

/// Run `command` (or an interactive shell) in the sandbox and return its exit status.
pub fn run(policy: &ValidPolicy, command: Option<&str>) -> Result<u32, Error> {
    let kind = ShellKind::from_path(&policy.shell)
        .ok_or_else(|| Error::new("shell", "not a supported shell"))?;
    if !std::path::Path::new(&policy.shell).is_file() {
        return Err(Error::new(
            "shell",
            format!("{} does not exist", policy.shell),
        ));
    }
    // The real folder, so a junction cannot make an outside directory look like it is inside the workspace.
    let cwd = std::env::current_dir()
        .and_then(std::fs::canonicalize)
        .map_err(|e| Error::new("working directory", e))?;
    let cwd = canonical(&cwd.to_string_lossy()).ok_or_else(|| {
        Error::new(
            "working directory",
            format!("{} is not a plain drive path", cwd.display()),
        )
    })?;
    // A directory the container cannot enter makes CreateProcess fail with a message that names nothing, so say it here.
    let usable = policy
        .read_write
        .iter()
        .chain(&policy.read_only)
        .any(|root| within(root, &cwd));
    if !usable {
        return Err(Error::new(
            "working directory",
            format!("{cwd} is outside every folder the sandbox may use"),
        ));
    }

    let sid = appcontainer::profile_sid(&policy.profile)?;
    for path in &policy.read_write {
        if !std::path::Path::new(path).is_dir() {
            return Err(Error::new("folder", format!("{path} does not exist")));
        }
        acl::grant(path, &sid, acl::Access::ReadWrite)?;
    }
    for path in &policy.read_only {
        // A toolchain folder that is not installed on this machine is skipped, not fatal.
        if std::path::Path::new(path).exists() {
            acl::grant(path, &sid, acl::Access::ReadOnly)?;
        }
    }

    let capabilities = appcontainer::capabilities(policy.network)?;
    let job = process::Job::new(policy)?;
    let line = command_line(&policy.shell, kind, command);
    process::run(&process::Launch {
        policy,
        sid: &sid,
        capabilities: &capabilities,
        job: &job,
        command_line: &line,
        cwd: &cwd,
    })
}
