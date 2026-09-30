//! The sandbox policy: what a shell command may touch.
//!
//! The policy is plain data the server writes before it starts the engine. This module only reads and
//! validates it, and it does so with string rules rather than `std::path`, so the same checks run (and are
//! tested) on any host. A policy that is malformed, or that would grant more than a sandbox should, is
//! refused; the caller must then not run the command at all.

use serde::{Deserialize, Serialize};

pub const POLICY_VERSION: u32 = 1;
const DEFAULT_PROFILE: &str = "Harness.AgentShell";
const DEFAULT_MAX_PROCESSES: u32 = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Network {
    /// No network at all, including loopback: the Harness server and the memory engine are unreachable.
    None,
    /// Outbound connections (the `internetClient` capability). Loopback to other apps stays blocked.
    Internet,
    /// Outbound plus listening sockets, so a dev server the agent starts can be reached from its own shell.
    InternetServer,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    /// Most processes alive at once in the sandbox's job. Stops a fork bomb.
    pub max_processes: Option<u32>,
    /// Most memory the whole job may commit, in MiB.
    pub memory_mb: Option<u64>,
    /// Let background processes outlive the command. Off by default: when the shell exits, everything it
    /// started is killed with it.
    #[serde(default)]
    pub keep_background: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub version: u32,
    /// AppContainer profile name. One profile serves every workspace.
    pub profile: Option<String>,
    /// The shell that actually runs the command, for example `C:\Program Files\Git\bin\bash.exe`.
    pub shell: String,
    /// Folders the command may read and write.
    pub read_write: Vec<String>,
    /// Folders the command may read and run programs from.
    #[serde(default)]
    pub read_only: Vec<String>,
    /// Folders no grant may reach, whatever else is listed (Harness's own data, the audit log, the key vault).
    #[serde(default)]
    pub protect: Vec<String>,
    /// Scratch space: granted read-write and exported as TEMP and TMP.
    pub temp_dir: String,
    pub network: Network,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PolicyError {
    Parse(String),
    Version(u32),
    Profile(String),
    Path {
        field: &'static str,
        path: String,
        why: String,
    },
    Conflict {
        path: String,
        protected: String,
    },
    Shell(String),
    Limit(&'static str),
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(e) => write!(f, "policy is not valid JSON for this version: {e}"),
            Self::Version(v) => write!(f, "policy version {v} is not supported (expected {POLICY_VERSION})"),
            Self::Profile(p) => write!(f, "profile name {p:?} is not allowed (use letters, digits, '.', '_' or '-', up to 64)"),
            Self::Path { field, path, why } => write!(f, "{field}: {path:?} {why}"),
            Self::Conflict { path, protected } => write!(f, "{path:?} would give access to protected folder {protected:?}"),
            Self::Shell(s) => write!(f, "shell {s:?} is not a supported absolute shell path (bash, sh, zsh, powershell, pwsh or cmd)"),
            Self::Limit(why) => write!(f, "limits: {why}"),
        }
    }
}

impl std::error::Error for PolicyError {}

/// A policy that passed every check, with paths in canonical form.
#[derive(Debug, Clone)]
pub struct ValidPolicy {
    pub profile: String,
    pub shell: String,
    pub read_write: Vec<String>,
    pub read_only: Vec<String>,
    pub temp_dir: String,
    pub network: Network,
    pub max_processes: u32,
    pub memory_mb: Option<u64>,
    pub keep_background: bool,
}

/// Folders a grant must never be, contain, or lie inside: the operating system and shared program folders.
pub fn system_dirs(system_drive: &str) -> Vec<String> {
    [
        "Windows",
        "Program Files",
        "Program Files (x86)",
        "ProgramData",
    ]
    .iter()
    .map(|name| format!("{system_drive}\\{name}"))
    .collect()
}

/// Folders a grant must never be, or contain (but may lie inside): `C:\Users`, the user's profile and AppData.
/// A workspace inside the profile is normal; the profile itself would reach `.ssh` and every browser store.
pub fn ancestor_roots(system_drive: &str, sensitive: &[String]) -> Vec<String> {
    let mut roots = vec![format!("{system_drive}\\Users")];
    roots.extend(sensitive.iter().filter_map(|p| canonical(p)));
    roots
}

/// Where credentials live inside a profile. A grant that lands inside one is refused even if the rest is fine.
const SECRET_DIRS: [&str; 8] = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".azure",
    ".kube",
    ".docker",
    ".config\\gh",
    "appdata\\roaming\\microsoft\\credentials",
];

/// Why a path could not be resolved to the folder it really names.
#[derive(Debug, PartialEq, Eq)]
pub enum Resolve {
    /// The path does not exist (yet). It is kept as written; the caller decides whether that is acceptable.
    Missing,
    /// The path exists but leads somewhere a grant must not go, such as a network share.
    Refused(String),
}

impl Policy {
    /// The same policy with every path replaced by the folder it really is: junctions, symbolic links and 8.3
    /// short names followed. Validation must run on this form, or a workspace that is a junction to the user's
    /// profile would pass every string check and then be granted as the profile.
    pub fn resolved(
        &self,
        resolve: &dyn Fn(&str) -> Result<String, Resolve>,
    ) -> Result<Policy, PolicyError> {
        let one = |field: &'static str, raw: &String| -> Result<String, PolicyError> {
            match resolve(raw) {
                Ok(real) => Ok(real),
                Err(Resolve::Missing) => Ok(raw.clone()),
                Err(Resolve::Refused(why)) => Err(PolicyError::Path {
                    field,
                    path: raw.clone(),
                    why,
                }),
            }
        };
        let many = |field: &'static str, list: &Vec<String>| {
            list.iter()
                .map(|p| one(field, p))
                .collect::<Result<Vec<_>, _>>()
        };
        let mut out = self.clone();
        out.read_write = many("readWrite", &self.read_write)?;
        out.read_only = many("readOnly", &self.read_only)?;
        out.protect = many("protect", &self.protect)?;
        out.temp_dir = one("tempDir", &self.temp_dir)?;
        Ok(out)
    }

    pub fn parse(json: &str) -> Result<Self, PolicyError> {
        serde_json::from_str(json).map_err(|e| PolicyError::Parse(e.to_string()))
    }

    /// `sensitive` lists the user's profile and AppData folders; `system_drive` is like `C:`.
    pub fn validate(
        &self,
        system_drive: &str,
        sensitive: &[String],
    ) -> Result<ValidPolicy, PolicyError> {
        if self.version != POLICY_VERSION {
            return Err(PolicyError::Version(self.version));
        }
        let profile = self
            .profile
            .clone()
            .unwrap_or_else(|| DEFAULT_PROFILE.to_string());
        if profile.is_empty()
            || profile.len() > 64
            || !profile
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(PolicyError::Profile(profile));
        }
        let system = system_dirs(system_drive);
        let ancestors = ancestor_roots(system_drive, sensitive);
        let protect: Vec<String> = self
            .protect
            .iter()
            .map(|p| require("protect", p))
            .collect::<Result<_, _>>()?;

        let grants = |field: &'static str, list: &[String]| -> Result<Vec<String>, PolicyError> {
            let mut out: Vec<String> = Vec::new();
            for raw in list {
                let path = require(field, raw)?;
                check_grant(field, &path, &system, &ancestors, &protect)?;
                if !out.iter().any(|seen| key(seen) == key(&path)) {
                    out.push(path);
                }
            }
            Ok(out)
        };
        let read_write = grants("readWrite", &self.read_write)?;
        let read_only = grants("readOnly", &self.read_only)?;
        let temp = require("tempDir", &self.temp_dir)?;
        check_grant("tempDir", &temp, &system, &ancestors, &protect)?;
        if read_write.is_empty() {
            return Err(PolicyError::Path {
                field: "readWrite",
                path: String::new(),
                why: "must list at least the workspace".to_string(),
            });
        }

        let shell =
            require("shell", &self.shell).map_err(|_| PolicyError::Shell(self.shell.clone()))?;
        if !shell.to_ascii_lowercase().ends_with(".exe")
            || crate::shell::ShellKind::from_path(&shell).is_none()
        {
            return Err(PolicyError::Shell(self.shell.clone()));
        }

        let max_processes = self.limits.max_processes.unwrap_or(DEFAULT_MAX_PROCESSES);
        if !(1..=100_000).contains(&max_processes) {
            return Err(PolicyError::Limit(
                "maxProcesses must be between 1 and 100000",
            ));
        }
        if let Some(mb) = self.limits.memory_mb {
            if !(64..=1_048_576).contains(&mb) {
                return Err(PolicyError::Limit(
                    "memoryMb must be between 64 and 1048576",
                ));
            }
        }
        Ok(ValidPolicy {
            profile,
            shell,
            read_write,
            read_only,
            temp_dir: temp,
            network: self.network,
            max_processes,
            memory_mb: self.limits.memory_mb,
            keep_background: self.limits.keep_background,
        })
    }
}

fn require(field: &'static str, raw: &str) -> Result<String, PolicyError> {
    canonical(raw).ok_or_else(|| PolicyError::Path {
        field,
        path: raw.to_string(),
        why: "must be an absolute drive path such as C:\\folder (no UNC or device paths, no '..', no stream or wildcard characters)".to_string(),
    })
}

fn check_grant(
    field: &'static str,
    path: &str,
    system: &[String],
    ancestors: &[String],
    protect: &[String],
) -> Result<(), PolicyError> {
    let refuse = |why: &str| PolicyError::Path {
        field,
        path: path.to_string(),
        why: why.to_string(),
    };
    if path.len() <= 3 {
        return Err(refuse("is a drive root, which is too broad to grant"));
    }
    if system
        .iter()
        .any(|dir| within(dir, path) || within(path, dir))
    {
        return Err(refuse(
            "is, contains or lies inside a system program folder",
        ));
    }
    if ancestors.iter().any(|root| within(path, root)) {
        return Err(refuse(
            "is or contains a user or profile folder, too broad to grant",
        ));
    }
    if let Some(bad) = protect
        .iter()
        .find(|protected| within(protected, path) || within(path, protected))
    {
        return Err(PolicyError::Conflict {
            path: path.to_string(),
            protected: bad.clone(),
        });
    }
    let lowered = key(path);
    if SECRET_DIRS.iter().any(|dir| segment_match(&lowered, dir)) {
        return Err(refuse("is inside a credentials folder"));
    }
    Ok(())
}

/// True when `dir` appears as whole path segments of `lowered` (so `.ssh` matches `\.ssh\keys` but not `\.sshfoo`).
fn segment_match(lowered: &str, dir: &str) -> bool {
    let needle = format!("\\{dir}");
    let mut from = 0;
    while let Some(at) = lowered[from..].find(&needle) {
        let end = from + at + needle.len();
        if end == lowered.len() || lowered.as_bytes()[end] == b'\\' {
            return true;
        }
        from += at + 1;
    }
    false
}

/// Lowercase form used for comparing paths, which Windows treats case-insensitively.
pub fn key(path: &str) -> String {
    path.to_lowercase()
}

/// True when `path` is `parent` or lies inside it.
pub fn within(parent: &str, path: &str) -> bool {
    let (parent, path) = (key(parent), key(path));
    path == parent
        || path
            .strip_prefix(&parent)
            .is_some_and(|rest| rest.starts_with('\\'))
}

/// A drive-absolute path with single backslashes, no trailing separator and no dot segments, or `None`
/// when the input is anything else (relative, UNC, a device path, a stream, a wildcard, or a `..` escape).
pub fn canonical(raw: &str) -> Option<String> {
    let mut text = raw.replace('/', "\\");
    if let Some(rest) = text.strip_prefix("\\\\?\\") {
        // Extended-length prefix on a drive path is fine; on UNC (`\\?\UNC\...`) or a device it is not.
        if rest.len() < 3 || !rest.as_bytes()[0].is_ascii_alphabetic() || rest.as_bytes()[1] != b':'
        {
            return None;
        }
        text = rest.to_string();
    }
    let bytes = text.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'\\' {
        return None;
    }
    if text
        .chars()
        .skip(2)
        .any(|c| c == ':' || matches!(c, '<' | '>' | '"' | '|' | '?' | '*') || c.is_control())
    {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in text[3..].split('\\') {
        match part {
            "" | "." => {}
            ".." => return None,
            // Trailing dots and spaces are dropped by Windows, so `foo.` names the same folder as `foo`.
            other if other.ends_with('.') || other.ends_with(' ') => return None,
            other => parts.push(other),
        }
    }
    let drive = text[..2].to_ascii_uppercase();
    Some(if parts.is_empty() {
        format!("{drive}\\")
    } else {
        format!("{drive}\\{}", parts.join("\\"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(json: &str) -> Policy {
        Policy::parse(json).expect("parses")
    }

    fn base() -> String {
        r#"{"version":1,"shell":"C:\\Program Files\\Git\\bin\\bash.exe","readWrite":["C:\\Users\\me\\proj"],"tempDir":"C:\\Users\\me\\AppData\\Local\\harness\\tmp","network":"none","protect":["C:\\Users\\me\\AppData\\Roaming\\harness"]}"#.to_string()
    }

    fn sensitive() -> Vec<String> {
        vec![
            "C:\\Users\\me".into(),
            "C:\\Users\\me\\AppData".into(),
            "C:\\Users\\me\\AppData\\Local".into(),
            "C:\\Users\\me\\AppData\\Roaming".into(),
        ]
    }

    fn check(json: &str) -> Result<ValidPolicy, PolicyError> {
        policy(json).validate("C:", &sensitive())
    }

    #[test]
    fn accepts_a_workspace_inside_the_profile() {
        let valid = check(&base()).expect("valid");
        assert_eq!(valid.read_write, vec!["C:\\Users\\me\\proj"]);
        assert_eq!(valid.profile, "Harness.AgentShell");
        assert_eq!(valid.max_processes, 512);
        assert!(!valid.keep_background);
    }

    #[test]
    fn canonical_normalises_and_refuses() {
        assert_eq!(
            canonical("c:/Users//me/./proj/").as_deref(),
            Some("C:\\Users\\me\\proj")
        );
        assert_eq!(canonical("\\\\?\\c:\\x").as_deref(), Some("C:\\x"));
        assert_eq!(canonical("c:\\").as_deref(), Some("C:\\"));
        for bad in [
            "relative\\dir",
            "\\\\server\\share\\x",
            "\\\\?\\UNC\\server\\share",
            "\\\\.\\PhysicalDrive0",
            "C:\\a\\..\\b",
            "C:\\a:stream",
            "C:\\a\\*",
            "C:\\a?",
            "C:\\a.\\b",
            "C:\\a \\b",
            "",
            "C:",
            "C:x",
        ] {
            assert_eq!(canonical(bad), None, "{bad}");
        }
    }

    #[test]
    fn within_compares_whole_segments_and_ignores_case() {
        assert!(within("C:\\Users\\me", "c:\\users\\ME\\proj"));
        assert!(within("C:\\Users\\me", "C:\\Users\\me"));
        assert!(!within("C:\\Users\\me", "C:\\Users\\meagain"));
        assert!(!within("C:\\Users\\me\\proj", "C:\\Users\\me"));
    }

    #[test]
    fn refuses_folders_that_are_too_broad() {
        for bad in [
            "C:\\",
            "C:\\Users",
            "C:\\Users\\me",
            "C:\\Users\\me\\AppData",
            "C:\\Users\\me\\AppData\\Local",
            "C:\\Windows",
            "C:\\Windows\\System32",
            "C:\\Program Files",
            "C:\\ProgramData",
        ] {
            let json = base().replace("C:\\\\Users\\\\me\\\\proj", &bad.replace('\\', "\\\\"));
            assert!(check(&json).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn refuses_a_grant_inside_a_credentials_folder_but_not_a_lookalike() {
        for bad in [
            "C:\\Users\\me\\.ssh",
            "C:\\Users\\me\\.ssh\\keys",
            "C:\\Users\\me\\.AWS",
            "C:\\Users\\me\\.config\\gh",
        ] {
            let json = base().replace("C:\\\\Users\\\\me\\\\proj", &bad.replace('\\', "\\\\"));
            assert!(check(&json).is_err(), "{bad} must be refused");
        }
        let json = base().replace("C:\\\\Users\\\\me\\\\proj", "C:\\\\Users\\\\me\\\\.sshfoo");
        assert!(
            check(&json).is_ok(),
            "a lookalike is not a credentials folder"
        );
    }

    #[test]
    fn refuses_a_grant_that_reaches_a_protected_folder() {
        // Inside it, equal to it, and above it.
        for bad in [
            "C:\\Users\\me\\AppData\\Roaming\\harness",
            "C:\\Users\\me\\AppData\\Roaming\\harness\\data",
            "C:\\Users\\me\\AppData\\Roaming",
        ] {
            let json = base().replace("C:\\\\Users\\\\me\\\\proj", &bad.replace('\\', "\\\\"));
            assert!(check(&json).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn refuses_unknown_fields_and_versions() {
        assert!(matches!(
            Policy::parse(&base().replace("\"network\"", "\"netwrok\"")),
            Err(PolicyError::Parse(_))
        ));
        assert!(matches!(
            Policy::parse(&base().replace("\"version\":1", "\"version\":1,\"extra\":true")),
            Err(PolicyError::Parse(_))
        ));
        assert_eq!(
            check(&base().replace("\"version\":1", "\"version\":2")).unwrap_err(),
            PolicyError::Version(2)
        );
    }

    #[test]
    fn refuses_a_shell_that_is_not_a_known_absolute_exe() {
        for shell in [
            "bash",
            "C:\\tools\\evil.exe",
            "C:\\Program Files\\Git\\bin\\bash",
            "\\\\server\\share\\bash.exe",
        ] {
            let json = base().replace(
                "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe",
                &shell.replace('\\', "\\\\"),
            );
            assert!(check(&json).is_err(), "{shell} must be refused");
        }
        for shell in [
            "C:\\Windows\\System32\\cmd.exe",
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        ] {
            let json = base().replace(
                "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe",
                &shell.replace('\\', "\\\\"),
            );
            assert!(check(&json).is_ok(), "{shell} must be accepted");
        }
    }

    #[test]
    fn needs_a_workspace_and_sane_limits_and_profile_name() {
        assert!(check(&base().replace("[\"C:\\\\Users\\\\me\\\\proj\"]", "[]")).is_err());
        assert!(check(&base().replace(
            "\"network\":\"none\"",
            "\"network\":\"none\",\"limits\":{\"maxProcesses\":0}"
        ))
        .is_err());
        assert!(check(&base().replace(
            "\"network\":\"none\"",
            "\"network\":\"none\",\"limits\":{\"memoryMb\":1}"
        ))
        .is_err());
        assert!(check(&base().replace(
            "\"network\":\"none\"",
            "\"network\":\"none\",\"profile\":\"a b\""
        ))
        .is_err());
        assert!(
            check(&base().replace("\"network\":\"none\"", "\"network\":\"internet-server\""))
                .is_ok()
        );
    }

    #[test]
    fn a_junction_to_the_profile_is_refused_once_resolved() {
        // Written as the workspace, `C:\\Users\\me\\proj` looks fine; it is really a junction to the whole profile.
        let junction = |raw: &str| -> Result<String, Resolve> {
            match raw {
                "C:\\Users\\me\\proj" => Ok("C:\\Users\\me".to_string()),
                "C:\\Users\\me\\share" => {
                    Err(Resolve::Refused("leads to a network share".to_string()))
                }
                _ => Err(Resolve::Missing),
            }
        };
        assert!(check(&base()).is_ok(), "the string form passes");
        let resolved = policy(&base()).resolved(&junction).expect("resolves");
        assert_eq!(resolved.read_write, vec!["C:\\Users\\me"]);
        assert!(
            resolved.validate("C:", &sensitive()).is_err(),
            "the resolved form must be refused"
        );
        let to_share = policy(&base().replace("proj", "share"));
        assert!(
            to_share.resolved(&junction).is_err(),
            "a path that leads off the machine is refused outright"
        );
    }

    #[test]
    fn a_short_name_alias_of_a_protected_folder_is_caught_by_resolving() {
        let expand =
            |raw: &str| -> Result<String, Resolve> { Ok(raw.replace("HARNES~1", "harness")) };
        let json = base().replace(
            r"C:\\Users\\me\\proj",
            r"C:\\Users\\me\\AppData\\Roaming\\HARNES~1\\data",
        );
        assert_ne!(json, base(), "the substitution must take effect");
        assert!(
            check(&json).is_ok(),
            "the alias is not recognised by string checks alone"
        );
        let resolved = policy(&json).resolved(&expand).unwrap();
        assert!(resolved.validate("C:", &sensitive()).is_err());
    }

    #[test]
    fn duplicates_collapse_regardless_of_case() {
        let json = base().replace(
            "[\"C:\\\\Users\\\\me\\\\proj\"]",
            "[\"C:\\\\Users\\\\me\\\\proj\",\"c:/users/ME/proj/\"]",
        );
        assert_eq!(check(&json).unwrap().read_write.len(), 1);
    }
}
