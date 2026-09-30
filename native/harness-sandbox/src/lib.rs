//! Runs an agent's shell command inside an operating-system sandbox.
//!
//! `policy` and `shell` are plain logic and build everywhere. `win` needs the Windows API. On any other
//! platform the helper refuses to run a command (see `main.rs`), because a sandbox that silently does
//! nothing is worse than none.

pub mod cli;
pub mod policy;
pub mod shell;

#[cfg(windows)]
pub mod win;
