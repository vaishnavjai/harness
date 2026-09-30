use std::process::ExitCode;

use harness_sandbox::cli::{parse_args, Invocation};
#[cfg(windows)]
use harness_sandbox::policy::{canonical, Policy, Resolve, ValidPolicy};

/// Exit status when the sandbox could not be set up. The command was not run.
const SANDBOX_FAILED: u8 = 126;
const USAGE: u8 = 2;
#[cfg(windows)]
const POLICY_ENV: &str = "HARNESS_SANDBOX_POLICY";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let invocation = match parse_args(&args) {
        Ok(invocation) => invocation,
        Err(message) => return fail(USAGE, &message),
    };
    if invocation == Invocation::Version {
        println!("harness-sandbox {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    match run(invocation) {
        Ok(code) => ExitCode::from(code),
        Err(message) => fail(SANDBOX_FAILED, &message),
    }
}

fn fail(code: u8, message: &str) -> ExitCode {
    eprintln!("harness-sandbox: {message}");
    ExitCode::from(code)
}

/// The folder a path really is, with junctions, symbolic links and short names followed.
#[cfg(windows)]
fn real_path(raw: &str) -> Result<String, Resolve> {
    match std::fs::canonicalize(raw) {
        Ok(path) => canonical(&path.to_string_lossy()).ok_or_else(|| {
            Resolve::Refused(format!(
                "resolves to {}, which is not a local drive folder",
                path.display()
            ))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(Resolve::Missing),
        Err(e) => Err(Resolve::Refused(format!("cannot be resolved: {e}"))),
    }
}

#[cfg(windows)]
fn load_policy() -> Result<ValidPolicy, String> {
    let path = std::env::var(POLICY_ENV)
        .map_err(|_| format!("{POLICY_ENV} is not set, so there is no policy to enforce"))?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read the policy at {path}: {e}"))?;
    let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    let sensitive: Vec<String> = ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .map(|dir| real_path(&dir).unwrap_or(dir))
        .collect();
    let policy = Policy::parse(&text).map_err(|e| e.to_string())?;
    // The string checks come first, so an obviously bad policy is refused before anything touches the disk.
    policy
        .validate(&system_drive, &sensitive)
        .map_err(|e| e.to_string())?;
    // The scratch folder has to exist before it can be resolved.
    std::fs::create_dir_all(&policy.temp_dir)
        .map_err(|e| format!("cannot create the temp folder {}: {e}", policy.temp_dir))?;
    // Then everything is checked again as the folders it really names, so a junction cannot smuggle in a broad grant.
    policy
        .resolved(&real_path)
        .and_then(|real| real.validate(&system_drive, &sensitive))
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn run(invocation: Invocation) -> Result<u8, String> {
    use harness_sandbox::win;
    match invocation {
        Invocation::Probe => {
            let profile = load_policy()
                .map(|p| p.profile)
                .unwrap_or_else(|_| "Harness.AgentShell".to_string());
            win::probe(&profile).map_err(|e| e.to_string())?;
            println!("{{\"ok\":true,\"backend\":\"appcontainer\"}}");
            Ok(0)
        }
        Invocation::Revoke => {
            win::revoke(&load_policy()?).map_err(|e| e.to_string())?;
            Ok(0)
        }
        Invocation::Run { command } => {
            let policy = load_policy()?;
            let code = win::run(&policy, command.as_deref()).map_err(|e| e.to_string())?;
            // Exit statuses above 255 (NTSTATUS crashes such as 0xC0000005) are folded, never to 0.
            Ok(if code == 0 {
                0
            } else {
                (code & 0xFF).max(1) as u8
            })
        }
        Invocation::Version => Ok(0),
    }
}

#[cfg(not(windows))]
fn run(_invocation: Invocation) -> Result<u8, String> {
    // No sandbox exists here yet, so nothing may run: silently running unsandboxed would defeat the point.
    Err(format!(
        "no sandbox backend for {} yet; the command was not run",
        std::env::consts::OS
    ))
}
