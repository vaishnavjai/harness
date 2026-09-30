//! Escape tests for the Windows sandbox. They run the real helper, on a real Windows machine, against real
//! files, sockets and processes. Every "the sandbox stops X" test has a control that shows X works without the
//! sandbox, so a passing test cannot be a test that never had a chance to fail.
//!
//! Run with `cargo test --release -- --test-threads=1`. They create a profile named for the tests and grant it
//! access to folders under the temp directory only.
#![cfg(windows)]

use std::net::TcpListener;
use std::os::windows::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;

static COUNTER: AtomicU32 = AtomicU32::new(0);
const PROFILE: &str = "Harness.AgentShell.Test";

fn windows_dir() -> PathBuf {
    PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
}

fn cmd_exe() -> String {
    windows_dir()
        .join("System32")
        .join("cmd.exe")
        .to_string_lossy()
        .into_owned()
}

/// Folders for one test: a workspace and scratch space the sandbox may use, and a folder it must not touch.
struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    outside: PathBuf,
    policy: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        // `canonicalize` gives the long, real path (temp_dir() can be an 8.3 short name on a runner).
        let base = std::fs::canonicalize(std::env::temp_dir()).expect("temp dir");
        let base = PathBuf::from(base.to_string_lossy().trim_start_matches(r"\\?\"));
        let root = base.join(format!("hs-sandbox-{}-{n}", std::process::id()));
        let fixture = Fixture {
            workspace: root.join("workspace"),
            outside: root.join("outside"),
            policy: root.join("policy.json"),
            root,
        };
        for dir in [&fixture.workspace, &fixture.outside] {
            std::fs::create_dir_all(dir).unwrap();
        }
        fixture
    }

    fn write_policy(&self, shell: &str, network: &str, extra: serde_json::Value) {
        let mut policy = json!({
            "version": 1,
            "profile": PROFILE,
            "shell": shell,
            "readWrite": [self.workspace],
            "network": network,
        });
        if let (Some(map), Some(extra)) = (policy.as_object_mut(), extra.as_object()) {
            map.extend(extra.clone());
        }
        std::fs::write(&self.policy, policy.to_string()).unwrap();
    }

    /// Runs `command` through the helper the way the engine does: `harness-sandbox -c <command>`, in the workspace.
    fn run(&self, command: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_harness-sandbox"))
            .args(["-c", command])
            .env("HARNESS_SANDBOX_POLICY", &self.policy)
            .current_dir(&self.workspace)
            .stdin(Stdio::null())
            .output()
            .expect("the helper starts")
    }

    /// Same command with the sandbox's shell but no sandbox: the control that shows the action is possible.
    fn control(&self, command: &str) -> Output {
        // `/s` makes cmd strip one outer pair of quotes and run the rest as written. Passing the command through
        // `.args()` would let Rust re-escape its quotes, and cmd does not read them that way.
        Command::new(cmd_exe())
            .raw_arg(format!("/d /s /c \"{command}\""))
            .current_dir(&self.workspace)
            .stdin(Stdio::null())
            .output()
            .expect("cmd starts")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Command::new(env!("CARGO_BIN_EXE_harness-sandbox"))
            .arg("--revoke")
            .env("HARNESS_SANDBOX_POLICY", &self.policy)
            .output();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn describe(output: &Output) -> String {
    format!(
        "exit {:?}\n--- stdout\n{}\n--- stderr\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn cmd_fixture() -> Fixture {
    let fixture = Fixture::new();
    fixture.write_policy(&cmd_exe(), "none", json!({}));
    fixture
}

#[test]
fn runs_a_command_and_passes_back_output_and_exit_status() {
    let f = cmd_fixture();
    let out = f.run("echo hello from the sandbox & exit 7");
    assert!(
        text(&out).contains("hello from the sandbox"),
        "{}",
        describe(&out)
    );
    assert_eq!(out.status.code(), Some(7), "{}", describe(&out));
}

#[test]
fn works_in_the_workspace_and_scratch_space_and_nowhere_else() {
    let f = cmd_fixture();
    std::fs::write(f.workspace.join("existing.txt"), "already here").unwrap();
    assert!(
        text(&f.run("type existing.txt")).contains("already here"),
        "reads a file that was there before the first grant"
    );
    f.run("echo made-inside > made.txt");
    assert_eq!(
        std::fs::read_to_string(f.workspace.join("made.txt"))
            .unwrap_or_default()
            .trim(),
        "made-inside",
        "writes inside the workspace"
    );
    let scratch = f.run("echo scratch > \"%TEMP%\\s.txt\" & type \"%TEMP%\\s.txt\"");
    assert!(
        text(&scratch).contains("scratch"),
        "TEMP is a writable scratch folder\n{}",
        describe(&scratch)
    );

    // Control: the same write outside works without the sandbox, so a failure below is the sandbox's doing.
    let target = f.outside.join("planted.txt");
    f.control(&format!("echo control > \"{}\"", target.display()));
    assert!(target.exists(), "control write outside must succeed");
    std::fs::remove_file(&target).unwrap();
    let denied = f.run(&format!("echo escaped > \"{}\"", target.display()));
    assert!(
        !target.exists(),
        "the sandbox wrote outside its folders\n{}",
        describe(&denied)
    );
}

#[test]
fn cannot_read_a_secret_outside_its_folders() {
    let f = cmd_fixture();
    let secret = f.outside.join("id_rsa");
    std::fs::write(&secret, "TOP-SECRET-KEY-MATERIAL").unwrap();
    assert!(
        text(&f.control(&format!("type \"{}\"", secret.display()))).contains("TOP-SECRET"),
        "control read must succeed"
    );
    let out = f.run(&format!("type \"{}\"", secret.display()));
    assert!(
        !text(&out).contains("TOP-SECRET"),
        "the sandbox read a file outside its folders\n{}",
        describe(&out)
    );
    assert_ne!(out.status.code(), Some(0), "{}", describe(&out));
}

#[test]
fn cannot_list_the_users_home_folder() {
    let f = cmd_fixture();
    let home = std::env::var("USERPROFILE").unwrap();
    let out = f.run(&format!("dir \"{home}\""));
    assert_ne!(
        out.status.code(),
        Some(0),
        "the sandbox listed the profile\n{}",
        describe(&out)
    );
}

#[test]
fn a_junction_inside_the_workspace_does_not_grant_its_target() {
    let f = cmd_fixture();
    let secret = f.outside.join("behind-junction.txt");
    std::fs::write(&secret, "JUNCTION-SECRET").unwrap();
    // Made before the first grant, so the grant's inheritance is applied over a tree that already holds the link.
    let made = f.control(&format!(
        "mklink /J \"{}\" \"{}\"",
        f.workspace.join("link").display(),
        f.outside.display()
    ));
    assert!(
        f.workspace.join("link").exists(),
        "control: junction created\n{}",
        describe(&made)
    );
    assert!(
        text(&f.control("type link\\behind-junction.txt")).contains("JUNCTION-SECRET"),
        "control: readable through the junction unsandboxed"
    );
    let out = f.run("type link\\behind-junction.txt");
    assert!(
        !text(&out).contains("JUNCTION-SECRET"),
        "read through a junction reached outside the workspace\n{}",
        describe(&out)
    );
}

fn listener() -> TcpListener {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    l.set_nonblocking(true).unwrap();
    l
}

fn saw_connection(l: &TcpListener, wait: Duration) -> bool {
    let end = Instant::now() + wait;
    while Instant::now() < end {
        if l.accept().is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn curl() -> String {
    windows_dir()
        .join("System32")
        .join("curl.exe")
        .to_string_lossy()
        .into_owned()
}

#[test]
fn no_network_blocks_loopback_so_the_harness_server_is_unreachable() {
    let f = cmd_fixture();
    let l = listener();
    let port = l.local_addr().unwrap().port();
    let url = format!("http://127.0.0.1:{port}/");
    // Control: an unsandboxed client reaches the listener.
    let _ = Command::new(curl()).args(["-s", "-m", "5", &url]).output();
    assert!(
        saw_connection(&l, Duration::from_secs(5)),
        "control: the listener must see an unsandboxed connection"
    );
    let out = f.run(&format!("\"{}\" -s -m 6 {url}", curl()));
    assert!(
        !saw_connection(&l, Duration::from_secs(3)),
        "a sandboxed process reached a loopback listener\n{}",
        describe(&out)
    );
}

#[test]
fn no_network_blocks_the_internet() {
    let f = cmd_fixture();
    let control = Command::new(curl())
        .args([
            "-s",
            "-m",
            "10",
            "-o",
            "NUL",
            "-w",
            "%{http_code}",
            "https://example.com",
        ])
        .output()
        .unwrap();
    if String::from_utf8_lossy(&control.stdout).trim() != "200" {
        eprintln!("SKIP: this machine has no internet, so blocking it cannot be shown");
        return;
    }
    let out = f.run(&format!(
        "\"{}\" -s -m 10 -o NUL -w %{{http_code}} https://example.com",
        curl()
    ));
    assert_ne!(
        text(&out).trim(),
        "200",
        "the sandbox reached the internet with network=none\n{}",
        describe(&out)
    );
}

#[test]
fn internet_mode_reaches_the_internet_but_still_not_loopback() {
    let f = Fixture::new();
    f.write_policy(&cmd_exe(), "internet", json!({}));
    let control = Command::new(curl())
        .args([
            "-s",
            "-m",
            "10",
            "-o",
            "NUL",
            "-w",
            "%{http_code}",
            "https://example.com",
        ])
        .output()
        .unwrap();
    if String::from_utf8_lossy(&control.stdout).trim() != "200" {
        eprintln!("SKIP: this machine has no internet");
        return;
    }
    let out = f.run(&format!(
        "\"{}\" -s -m 10 -o NUL -w %{{http_code}} https://example.com",
        curl()
    ));
    assert_eq!(
        text(&out).trim(),
        "200",
        "network=internet must allow outbound connections\n{}",
        describe(&out)
    );
    let l = listener();
    let url = format!("http://127.0.0.1:{}/", l.local_addr().unwrap().port());
    let out = f.run(&format!("\"{}\" -s -m 6 {url}", curl()));
    assert!(
        !saw_connection(&l, Duration::from_secs(3)),
        "internet mode must not open loopback to other apps\n{}",
        describe(&out)
    );
}

fn sleeper(seconds: u32) -> Child {
    Command::new(windows_dir().join("System32").join("ping.exe"))
        .args(["-n", &seconds.to_string(), "127.0.0.1"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap()
}

fn taskkill() -> String {
    windows_dir()
        .join("System32")
        .join("taskkill.exe")
        .to_string_lossy()
        .into_owned()
}

#[test]
fn cannot_kill_another_process_of_the_same_user() {
    let f = cmd_fixture();
    // Control: unsandboxed, taskkill ends the process.
    let mut victim = sleeper(120);
    Command::new(taskkill())
        .args(["/F", "/PID", &victim.id().to_string()])
        .output()
        .unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        victim.try_wait().unwrap().is_some(),
        "control: taskkill must end the process"
    );

    let mut victim = sleeper(120);
    let out = f.run(&format!("\"{}\" /F /PID {}", taskkill(), victim.id()));
    std::thread::sleep(Duration::from_millis(500));
    let alive = victim.try_wait().unwrap().is_none();
    let _ = victim.kill();
    assert!(
        alive,
        "the sandbox ended a process outside it\n{}",
        describe(&out)
    );
}

/// A background worker that appends to `heartbeat.txt` in a tight loop until a file named `stop` appears. Watching that
/// file grow is how the tests tell whether it is alive: it needs no process listing (which a sandboxed process may not
/// appear in for another process), no NUL device and no network, none of which a container can be assumed to have.
fn write_heartbeat_script(f: &Fixture) {
    let script =
        "@echo off\r\n:a\r\nif exist stop exit /b\r\necho tick>>heartbeat.txt\r\ngoto a\r\n";
    std::fs::write(f.workspace.join("beat.cmd"), script).unwrap();
}

fn heartbeat_bytes(f: &Fixture) -> u64 {
    std::fs::metadata(f.workspace.join("heartbeat.txt"))
        .map(|m| m.len())
        .unwrap_or(0)
}

/// Runs `command` through the helper with a stdin pipe held open for `hold`, so a foreground `findstr` keeps the
/// command alive that long, then lets it finish. Output goes to files rather than pipes: a background process that
/// survives (keepBackground) would otherwise hold a pipe open and block the wait.
fn run_holding_stdin(f: &Fixture, command: &str, hold: Duration) -> std::process::ExitStatus {
    let out = std::fs::File::create(f.root.join("out.txt")).unwrap();
    let err = std::fs::File::create(f.root.join("err.txt")).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_harness-sandbox"))
        .args(["-c", command])
        .env("HARNESS_SANDBOX_POLICY", &f.policy)
        .current_dir(&f.workspace)
        .stdin(Stdio::piped())
        .stdout(out)
        .stderr(err)
        .spawn()
        .unwrap();
    std::thread::sleep(hold);
    drop(child.stdin.take());
    child.wait().unwrap()
}

/// Starts the worker in the background, keeps the command alive for a few seconds, and reports the heartbeat size
/// just after the helper exited and again a few seconds later.
fn background_heartbeat(f: &Fixture) -> (u64, u64) {
    write_heartbeat_script(f);
    let status = run_holding_stdin(
        f,
        "start /b \"\" cmd /d /c beat.cmd & findstr x",
        Duration::from_secs(3),
    );
    let stderr = std::fs::read_to_string(f.root.join("err.txt")).unwrap_or_default();
    assert!(
        status.code().is_some(),
        "the helper did not exit normally: {status:?} {stderr}"
    );
    std::thread::sleep(Duration::from_secs(1));
    let first = heartbeat_bytes(f);
    std::thread::sleep(Duration::from_secs(3));
    let later = heartbeat_bytes(f);
    std::fs::write(f.workspace.join("stop"), "").unwrap();
    std::thread::sleep(Duration::from_secs(1));
    (first, later)
}

#[test]
fn background_processes_die_with_the_command() {
    let f = cmd_fixture();
    let (first, later) = background_heartbeat(&f);
    // Without this the test could pass because the worker never ran at all, which is what an earlier version did.
    assert!(
        first > 0,
        "the background worker never ran, so this test proves nothing: {}",
        std::fs::read_to_string(f.root.join("err.txt")).unwrap_or_default()
    );
    assert_eq!(
        later, first,
        "a background process kept running after the command returned ({first} -> {later} bytes)"
    );
}

#[test]
fn keep_background_lets_them_live_on() {
    // The control for the test above: with keepBackground the same worker keeps going, so "it stopped" means something.
    let f = Fixture::new();
    f.write_policy(
        &cmd_exe(),
        "none",
        json!({ "limits": { "keepBackground": true } }),
    );
    let (first, later) = background_heartbeat(&f);
    assert!(
        first > 0,
        "the background worker never ran: {}",
        std::fs::read_to_string(f.root.join("err.txt")).unwrap_or_default()
    );
    assert!(
        later > first,
        "with keepBackground the background process must keep running ({first} -> {later} bytes)"
    );
}

#[test]
fn the_command_sees_a_private_temp_folder_and_no_sandbox_settings() {
    let f = cmd_fixture();
    let out = f.run("set HARNESS_SANDBOX & echo TEMP=%TEMP% & echo SHELL=%SHELL%");
    let shown = text(&out);
    assert!(!shown.contains("HARNESS_SANDBOX_POLICY"), "{shown}");
    assert!(shown.contains("HARNESS_SANDBOXED=appcontainer"), "{shown}");
    // Windows itself points TEMP at the container's private folder, which the container owns.
    let lowered = shown.to_lowercase();
    assert!(
        lowered.contains(&format!("packages\\{}\\ac\\temp", PROFILE.to_lowercase())),
        "{shown}"
    );
    assert!(
        lowered.contains("shell=c:\\windows\\system32\\cmd.exe"),
        "SHELL must name the real shell\n{shown}"
    );
}

#[test]
fn a_bad_policy_runs_nothing() {
    let f = Fixture::new();
    let marker = f.workspace.join("ran.txt");
    let attempt = |policy: serde_json::Value| {
        std::fs::write(&f.policy, policy.to_string()).unwrap();
        let out = f.run("echo x > ran.txt");
        assert_eq!(out.status.code(), Some(126), "{}", describe(&out));
        assert!(!marker.exists(), "the command ran despite a refused policy");
    };
    // The whole profile is far too broad to grant.
    attempt(
        json!({ "version": 1, "profile": PROFILE, "shell": cmd_exe(), "readWrite": [std::env::var("USERPROFILE").unwrap()], "network": "none" }),
    );
    // An unknown field is a typo that must not be ignored.
    attempt(
        json!({ "version": 1, "profile": PROFILE, "shell": cmd_exe(), "readWrite": [f.workspace], "network": "none", "netwrok": "internet" }),
    );
    // A shell that is not a shell.
    attempt(
        json!({ "version": 1, "profile": PROFILE, "shell": windows_dir().join("System32").join("notepad.exe"), "readWrite": [f.workspace], "network": "none" }),
    );
    // No policy at all.
    let out = Command::new(env!("CARGO_BIN_EXE_harness-sandbox"))
        .args(["-c", "echo x > ran.txt"])
        .env_remove("HARNESS_SANDBOX_POLICY")
        .current_dir(&f.workspace)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(126), "{}", describe(&out));
    assert!(!marker.exists());
}

#[test]
fn a_workspace_that_is_a_junction_to_the_profile_is_refused() {
    let f = Fixture::new();
    let junction = f.root.join("looks-harmless");
    let made = f.control(&format!(
        "mklink /J \"{}\" \"{}\"",
        junction.display(),
        std::env::var("USERPROFILE").unwrap()
    ));
    assert!(
        junction.exists(),
        "control: junction created\n{}",
        describe(&made)
    );
    std::fs::write(&f.policy, json!({ "version": 1, "profile": PROFILE, "shell": cmd_exe(), "readWrite": [junction], "network": "none" }).to_string()).unwrap();
    let out = f.run("echo x > ran.txt");
    assert_eq!(
        out.status.code(),
        Some(126),
        "a junction to the profile was granted\n{}",
        describe(&out)
    );
}

#[test]
fn the_probe_reports_availability() {
    let out = Command::new(env!("CARGO_BIN_EXE_harness-sandbox"))
        .arg("--probe")
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("\"ok\":true"),
        "{}",
        describe(&out)
    );
}

// ---- Compatibility: do the tools an agent uses run inside the container? -------------------------------------
// These say nothing about safety; they show whether the sandbox is usable. A missing tool skips the test.

fn tool(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    p.exists().then(|| p.to_path_buf())
}

#[test]
fn git_bash_is_refused_with_a_reason_the_person_can_act_on() {
    let Some(bash) = tool(r"C:\Program Files\Git\bin\bash.exe") else {
        return eprintln!("SKIP: Git for Windows is not installed");
    };
    let f = Fixture::new();
    f.write_policy(&bash.to_string_lossy(), "none", json!({}));
    let out = f.run("echo should-not-run");
    assert_eq!(out.status.code(), Some(126), "{}", describe(&out));
    assert!(!text(&out).contains("should-not-run"), "{}", describe(&out));
    assert!(
        text(&out).contains("MSYS2"),
        "the refusal must say why\n{}",
        describe(&out)
    );
}

#[test]
fn compat_powershell_as_the_shell() {
    let ps = windows_dir()
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let f = Fixture::new();
    f.write_policy(&ps.to_string_lossy(), "none", json!({}));
    let out = f.run("Write-Output \"ps-ok $($PSVersionTable.PSVersion.Major)\"; exit 4");
    assert!(text(&out).contains("ps-ok"), "{}", describe(&out));
    assert_eq!(out.status.code(), Some(4), "{}", describe(&out));
}

/// The folder a program really lives in (junctions followed), as a grant the policy would accept, or None when it
/// is already readable to every container (Windows and Program Files).
fn grant_for(exe: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(exe).ok()?;
    let dir = PathBuf::from(real.parent()?.to_string_lossy().trim_start_matches(r"\\?\"));
    let lowered = dir.to_string_lossy().to_lowercase();
    let readable_anyway = ["c:\\windows", "c:\\program files"]
        .iter()
        .any(|root| lowered.starts_with(root));
    (!readable_anyway).then_some(dir)
}

fn where_is(name: &str) -> Option<PathBuf> {
    let out = Command::new(windows_dir().join("System32").join("where.exe"))
        .arg(name)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|line| PathBuf::from(line.trim()))
        .filter(|p| p.exists())
}

#[test]
#[ignore = "known gap: git needs the NUL device (see --setup) and list access on every parent of its working directory"]
fn compat_git_runs_inside_the_container() {
    let Some(git) = where_is("git.exe") else {
        return eprintln!("SKIP: git is not installed");
    };
    let f = Fixture::new();
    let extra: Vec<PathBuf> = grant_for(&git).into_iter().collect();
    f.write_policy(&cmd_exe(), "none", json!({ "readOnly": extra }));
    let out = f.run(&format!(
        "\"{}\" --version & \"{}\" init -q & \"{}\" status --short & echo done",
        git.display(),
        git.display(),
        git.display()
    ));
    assert!(text(&out).contains("git version"), "{}", describe(&out));
    assert!(
        f.workspace.join(".git").exists(),
        "git init must work in the workspace\n{}",
        describe(&out)
    );
}

#[test]
#[ignore = "runner-specific: node.exe here lacks ALL APPLICATION PACKAGES read, which a container needs; a normal install has it"]
fn compat_node_runs_inside_the_container() {
    // On a runner `C:\Program Files\nodejs` is a junction into a folder no container can read, so this also checks
    // that granting a tool's real folder (junctions followed) is enough.
    let Some(node) = where_is("node.exe") else {
        return eprintln!("SKIP: node is not installed");
    };
    let f = Fixture::new();
    let extra: Vec<PathBuf> = grant_for(&node).into_iter().collect();
    f.write_policy(&cmd_exe(), "none", json!({ "readOnly": extra }));
    let out = f.run(&format!("\"{}\" -e \"require('fs').writeFileSync('n.txt', process.version); console.log('node-ok', process.version)\"", node.display()));
    assert!(text(&out).contains("node-ok"), "{}", describe(&out));
    assert!(f.workspace.join("n.txt").exists(), "{}", describe(&out));
}

#[test]
fn compat_a_tool_outside_program_files_needs_a_read_grant() {
    // A tool installed under the profile is invisible to the container until the policy grants its folder.
    let f = cmd_fixture();
    let tools = f.root.join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    std::fs::copy(
        windows_dir().join("System32").join("whoami.exe"),
        tools.join("mytool.exe"),
    )
    .unwrap();
    let denied = f.run(&format!("\"{}\"", tools.join("mytool.exe").display()));
    assert_ne!(
        denied.status.code(),
        Some(0),
        "an ungranted folder must not be runnable\n{}",
        describe(&denied)
    );
    f.write_policy(&cmd_exe(), "none", json!({ "readOnly": [tools] }));
    let allowed = f.run(&format!("\"{}\"", tools.join("mytool.exe").display()));
    assert_eq!(
        allowed.status.code(),
        Some(0),
        "a readOnly grant must make the tool runnable\n{}",
        describe(&allowed)
    );
}

fn helper(f: &Fixture, flag: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_harness-sandbox"))
        .arg(flag)
        .env("HARNESS_SANDBOX_POLICY", &f.policy)
        .output()
        .unwrap()
}

fn powershell_5() -> String {
    windows_dir()
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
        .to_string_lossy()
        .into_owned()
}

fn powershell_7() -> Option<String> {
    tool(r"C:\Program Files\PowerShell\7\pwsh.exe").map(|p| p.to_string_lossy().into_owned())
}

/// Prints what the container can and cannot do, for reading in a CI log. It asserts nothing: it exists to explain
/// a compatibility failure, so it only runs with `--ignored`. The runner is an administrator, which lets it also try
/// the one-time `--setup` step and show what changes.
#[test]
#[ignore = "diagnostic output: run with --ignored --nocapture"]
fn diagnose_the_container() {
    let f = cmd_fixture();
    let show = |title: &str, output: Output| println!("\n===== {title}\n{}", describe(&output));
    let git = where_is("git.exe");
    let extra: Vec<PathBuf> = git.iter().filter_map(|g| grant_for(g)).collect();
    let policy_for = |shell: &str| f.write_policy(shell, "none", json!({ "readOnly": extra }));

    let nul_modes = "foreach ($a in 'Read','Write','ReadWrite') { try { $s = [IO.File]::Open('\\\\.\\NUL','Open',$a,'ReadWrite'); $s.Close(); \"$a OK\" } catch { \"$a FAIL: $($_.Exception.Message)\" } }";
    let ps_basics = |git: &Option<PathBuf>| {
        let git_line = git
            .as_ref()
            .map(|g| format!("& '{}' --version; ", g.display()))
            .unwrap_or_default();
        format!("Get-Location; Set-Content -Path x.txt -Value hi; Get-Content x.txt; (Get-PSDrive -PSProvider FileSystem).Name -join ','; {git_line}Get-ChildItem -Name | Select-Object -First 3")
    };

    let stage = |label: &str| {
        println!("\n\n################ {label}");
        policy_for(&cmd_exe());
        show(
            "cmd: write NUL",
            f.run("echo x> NUL & echo rc=%errorlevel%"),
        );
        show("cmd: read NUL", f.run("type NUL & echo rc=%errorlevel%"));
        policy_for(&powershell_5());
        show("PowerShell 5.1: NUL open modes", f.run(nul_modes));
        show("PowerShell 5.1: basics", f.run(&ps_basics(&git)));
        if let Some(pwsh) = powershell_7() {
            policy_for(&pwsh);
            show("PowerShell 7: NUL open modes", f.run(nul_modes));
            show("PowerShell 7: basics", f.run(&ps_basics(&git)));
        }
        policy_for(&cmd_exe());
        if let Some(git) = &git {
            show(
                "cmd: git --version",
                f.run(&format!("\"{}\" --version", git.display())),
            );
            show(
                "cmd: git init + status in the workspace",
                f.run(&format!(
                    "\"{}\" init -q & \"{}\" status --short & echo done",
                    git.display(),
                    git.display()
                )),
            );
        }
        show(
            "cmd: curl --version",
            f.run(&format!("\"{}\" --version", curl())),
        );
    };

    show("the container's SID", helper(&f, "--probe"));
    show(
        "NUL's permissions (icacls, unsandboxed)",
        f.control("icacls \\\\.\\NUL"),
    );
    show(
        "Program Files\\nodejs permissions (icacls, unsandboxed)",
        f.control(
            "icacls \"C:\\Program Files\\nodejs\\node.exe\" & icacls \"C:\\Program Files\\nodejs\"",
        ),
    );
    stage("BEFORE setup");
    show(
        "harness-sandbox --setup (grants the container the NUL device)",
        helper(&f, "--setup"),
    );
    show(
        "NUL's permissions after setup",
        f.control("icacls \\\\.\\NUL"),
    );
    stage("AFTER setup");
    show(
        "cmd: a file redirect to NUL inside a for loop",
        f.run("for /l %i in (1,1,3) do @echo hi> NUL"),
    );
}
