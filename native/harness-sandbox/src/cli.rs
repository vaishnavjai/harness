//! What the helper was asked to do. The engine calls its shell as `<shell> -c <command>`, so that shape is
//! the one that matters; anything it does not recognise is refused rather than guessed at.

#[derive(Debug, PartialEq, Eq)]
pub enum Invocation {
    /// Run a command, or an interactive shell when there is none.
    Run {
        command: Option<String>,
    },
    /// Report whether the sandbox can be set up on this machine, as JSON on stdout.
    Probe,
    /// Take back the folder grants the policy made.
    Revoke,
    Version,
}

pub fn parse_args(args: &[String]) -> Result<Invocation, String> {
    match args {
        [] => Ok(Invocation::Run { command: None }),
        [flag] if flag == "--probe" => Ok(Invocation::Probe),
        [flag] if flag == "--revoke" => Ok(Invocation::Revoke),
        [flag] if flag == "--version" => Ok(Invocation::Version),
        // `-lc` is what some callers pass to ask for a login shell; the sandbox never loads profiles, so it is the same.
        [flag, command] if flag == "-c" || flag == "-lc" => Ok(Invocation::Run { command: Some(command.clone()) }),
        _ => Err(format!("unrecognised arguments {args:?}; expected -c <command>, --probe, --revoke or --version")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn understands_the_engines_call() {
        assert_eq!(
            parse_args(&args(&["-c", "echo hi"])),
            Ok(Invocation::Run {
                command: Some("echo hi".into())
            })
        );
        assert_eq!(
            parse_args(&args(&["-lc", "echo hi"])),
            Ok(Invocation::Run {
                command: Some("echo hi".into())
            })
        );
        assert_eq!(parse_args(&[]), Ok(Invocation::Run { command: None }));
    }

    #[test]
    fn a_command_that_looks_like_a_flag_is_still_a_command() {
        assert_eq!(
            parse_args(&args(&["-c", "--probe"])),
            Ok(Invocation::Run {
                command: Some("--probe".into())
            })
        );
    }

    #[test]
    fn maintenance_flags_take_no_command() {
        assert_eq!(parse_args(&args(&["--probe"])), Ok(Invocation::Probe));
        assert_eq!(parse_args(&args(&["--revoke"])), Ok(Invocation::Revoke));
        assert_eq!(parse_args(&args(&["--version"])), Ok(Invocation::Version));
    }

    #[test]
    fn refuses_what_it_does_not_recognise() {
        for bad in [
            &["-c"][..],
            &["-x", "y"],
            &["--probe", "extra"],
            &["-c", "a", "b"],
            &["echo", "hi"],
        ] {
            assert!(parse_args(&args(bad)).is_err(), "{bad:?}");
        }
    }
}
