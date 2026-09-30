//! Turning "run this command with this shell" into the one command-line string `CreateProcessW` takes.
//!
//! The engine calls its shell as `<shell> -c <command>`, whatever the shell is. The real shell may not
//! understand `-c` (PowerShell wants `-Command`, cmd wants `/c`), so this module maps it. Quoting is where
//! Windows command lines go wrong, and a mistake here is command injection, so the rules are pure functions
//! with tests that parse the result back the way the C runtime does.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    /// bash, sh, zsh and dash, as shipped with Git for Windows or MSYS2: `-c <command>`.
    Posix,
    /// Windows PowerShell and PowerShell 7: `-Command <command>`.
    PowerShell,
    /// cmd.exe: `/d /s /c "<command>"`, with the command passed verbatim.
    Cmd,
}

impl ShellKind {
    /// Whether the shell starts inside an AppContainer. MSYS2 shells (Git bash) do not: their runtime creates
    /// `\BaseNamedObjects\msys-2.0S5-*` at startup and an AppContainer is denied that (0xC0000022), so they
    /// die before running a single command. Measured on a real Windows machine, not assumed.
    pub fn runs_in_appcontainer(self) -> bool {
        !matches!(self, Self::Posix)
    }

    pub fn from_path(path: &str) -> Option<Self> {
        let name = path.rsplit(['\\', '/']).next()?.to_ascii_lowercase();
        match name.strip_suffix(".exe").unwrap_or(&name) {
            "bash" | "sh" | "zsh" | "dash" => Some(Self::Posix),
            "powershell" | "pwsh" => Some(Self::PowerShell),
            "cmd" => Some(Self::Cmd),
            _ => None,
        }
    }
}

/// Quote one argument so that `CommandLineToArgvW` and the C runtime read back exactly `arg`.
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty()
        && !arg
            .chars()
            .any(|c| matches!(c, ' ' | '\t' | '\n' | '\x0b' | '"'))
    {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                // Backslashes before a quote are doubled, and the quote itself is escaped.
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    // Backslashes before the closing quote are doubled so they do not escape it.
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// The full command line: the shell (always quoted, since it lives under `Program Files`) plus its arguments.
/// `command` is `None` for an interactive shell.
pub fn command_line(shell: &str, kind: ShellKind, command: Option<&str>) -> String {
    let exe = format!("\"{shell}\"");
    match (kind, command) {
        (ShellKind::Posix, Some(c)) => format!("{exe} -c {}", quote_arg(c)),
        (ShellKind::Posix, None) => format!("{exe} -i"),
        (ShellKind::PowerShell, Some(c)) => format!(
            "{exe} -NoLogo -NoProfile -NonInteractive -Command {}",
            quote_arg(c)
        ),
        (ShellKind::PowerShell, None) => format!("{exe} -NoLogo"),
        // cmd's `/s` strips the outer pair of quotes and runs what is inside verbatim, which is how the
        // command reaches it unchanged. Quoting it as an ordinary argument would double every quote.
        (ShellKind::Cmd, Some(c)) => format!("{exe} /d /s /c \"{c}\""),
        (ShellKind::Cmd, None) => format!("{exe} /d"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The documented `CommandLineToArgvW` / MSVCRT rules, written independently of `quote_arg`.
    fn parse(line: &str) -> Vec<String> {
        let chars: Vec<char> = line.chars().collect();
        let (mut args, mut i) = (Vec::new(), 0);
        while i < chars.len() {
            while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
                i += 1;
            }
            if i >= chars.len() {
                break;
            }
            let (mut arg, mut in_quotes) = (String::new(), false);
            while i < chars.len() {
                let mut backslashes = 0;
                while i < chars.len() && chars[i] == '\\' {
                    backslashes += 1;
                    i += 1;
                }
                if i < chars.len() && chars[i] == '"' {
                    arg.extend(std::iter::repeat_n('\\', backslashes / 2));
                    if backslashes % 2 == 1 {
                        arg.push('"');
                    } else {
                        in_quotes = !in_quotes;
                    }
                    i += 1;
                    continue;
                }
                arg.extend(std::iter::repeat_n('\\', backslashes));
                if i >= chars.len() || (!in_quotes && (chars[i] == ' ' || chars[i] == '\t')) {
                    break;
                }
                arg.push(chars[i]);
                i += 1;
            }
            args.push(arg);
        }
        args
    }

    #[test]
    fn quoting_round_trips_awkward_arguments() {
        let cases = [
            "",
            "plain",
            "with space",
            "tab\tinside",
            "say \"hi\"",
            "trailing backslash\\",
            "C:\\Program Files\\x\\",
            "quote at end\"",
            "\\\"",
            "\\\\\"",
            "\\\\\\\"",
            "a\\b c\\\\",
            "echo 'quoted \"arg\" $HOME' && exit 3",
            "line\nbreak",
            "ends with two\\\\",
            "\"",
            "\"\"",
            "\\",
            "\\\\",
            "curl -s \"https://example.com?a=1&b=2\" | jq '.x'",
            "unicode ünïcode 你好",
        ];
        for case in cases {
            let line = format!("prog {} tail", quote_arg(case));
            assert_eq!(
                parse(&line),
                vec!["prog".to_string(), case.to_string(), "tail".to_string()],
                "case {case:?} via {line:?}"
            );
        }
    }

    #[test]
    fn plain_arguments_are_left_alone() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg("-c"), "-c");
        assert_eq!(quote_arg(""), "\"\"");
    }

    #[test]
    fn detects_the_shell_kind_from_the_file_name() {
        assert_eq!(
            ShellKind::from_path("C:\\Program Files\\Git\\bin\\bash.exe"),
            Some(ShellKind::Posix)
        );
        assert_eq!(
            ShellKind::from_path("C:\\Windows\\System32\\CMD.EXE"),
            Some(ShellKind::Cmd)
        );
        assert_eq!(
            ShellKind::from_path("C:\\x\\pwsh.exe"),
            Some(ShellKind::PowerShell)
        );
        assert_eq!(
            ShellKind::from_path("C:\\x\\powershell.exe"),
            Some(ShellKind::PowerShell)
        );
        assert_eq!(ShellKind::from_path("C:\\x\\python.exe"), None);
        assert_eq!(ShellKind::from_path("C:\\x\\bash-evil.exe"), None);
    }

    #[test]
    fn posix_command_reaches_the_shell_as_one_argument() {
        let line = command_line(
            "C:\\Program Files\\Git\\bin\\bash.exe",
            ShellKind::Posix,
            Some("echo 'a \"b\"' && exit 3"),
        );
        assert_eq!(
            parse(&line),
            vec![
                "C:\\Program Files\\Git\\bin\\bash.exe",
                "-c",
                "echo 'a \"b\"' && exit 3"
            ]
        );
    }

    #[test]
    fn powershell_command_reaches_the_shell_as_one_argument() {
        let line = command_line(
            "C:\\x\\pwsh.exe",
            ShellKind::PowerShell,
            Some("Write-Output \"a b\"; exit 2"),
        );
        assert_eq!(
            parse(&line),
            vec![
                "C:\\x\\pwsh.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Write-Output \"a b\"; exit 2"
            ]
        );
    }

    #[test]
    fn cmd_command_is_passed_verbatim_inside_one_pair_of_quotes() {
        let line = command_line(
            "C:\\Windows\\System32\\cmd.exe",
            ShellKind::Cmd,
            Some("echo \"a b\" & exit 3"),
        );
        assert_eq!(
            line,
            "\"C:\\Windows\\System32\\cmd.exe\" /d /s /c \"echo \"a b\" & exit 3\""
        );
    }

    #[test]
    fn an_interactive_shell_gets_no_command() {
        assert_eq!(
            command_line("C:\\x\\bash.exe", ShellKind::Posix, None),
            "\"C:\\x\\bash.exe\" -i"
        );
        assert_eq!(
            command_line("C:\\Windows\\System32\\cmd.exe", ShellKind::Cmd, None),
            "\"C:\\Windows\\System32\\cmd.exe\" /d"
        );
    }
}
