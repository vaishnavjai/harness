# Agent sandbox

Status: **Windows, opt-in, not yet on by default.** Linux and macOS have no backend yet, and asking for the
sandbox there is an error, not a silent no-op.

The sandbox confines the commands an agent runs (its shell tool, and anything those commands start) so that a
prompt-injected or misbehaving agent cannot read your files outside the workspace, send them anywhere, or reach
Harness itself. It is checklist item 3 in `docs/security-checklist.md`.

## What it does

The engine runs every shell command as `$SHELL -c <command>`. With the sandbox on, `SHELL` is
`harness-sandbox.exe` (`native/harness-sandbox`), which:

1. reads a policy file the server keeps current (workspaces, authorized folders, tool folders, what to protect);
2. checks it (see "What the helper refuses") and resolves every path through junctions and short names;
3. creates a Windows **AppContainer** profile and grants it the workspace folders, nothing else;
4. starts the real shell (PowerShell or cmd) inside that container, in a **Job Object** that kills everything the
   command started when it exits and caps how many processes and how much memory it may use.

Any failure stops the command with exit status 126. There is no unsandboxed fallback.

## Turning it on

| Variable | Meaning |
|---|---|
| `HARNESS_AGENT_SANDBOX=1` | Turn the sandbox on. A typo (`ture`) is an error, not "off". |
| `HARNESS_AGENT_SANDBOX_HELPER` | Absolute path to `harness-sandbox.exe`. Required when on. |
| `HARNESS_AGENT_SANDBOX_NETWORK` | `none` (default), `internet`, or `internet-server` (also lets the agent listen). |
| `HARNESS_AGENT_SANDBOX_SHELL` | Override the shell. Must be `powershell.exe`, `pwsh.exe` or `cmd.exe`. |
| `HARNESS_AGENT_SANDBOX_PROTECT` | Extra folders no grant may reach, `;`-separated. The desktop should set its data folder. |

If the sandbox is on and the helper is missing, the platform is unsupported, or no shell is found, the engine does
not start.

## What is enforced (measured on a real Windows runner)

Each row is a test in `native/harness-sandbox/tests/windows_escape.rs`, and each has an unsandboxed control that shows
the action is possible without the sandbox, so a pass cannot be a test that never had a chance to fail.

| Property | Result |
|---|---|
| Read a file outside the granted folders | denied |
| List the user's profile folder | denied |
| Write outside the granted folders | denied |
| Read through a junction placed in the workspace | denied |
| A workspace that is a junction to the profile | refused, nothing runs |
| No network (`none`) | internet and loopback both blocked |
| `internet` | outbound works; loopback to other apps still blocked, so the Harness server and memory engine are unreachable |
| Kill another process of the same user | denied |
| Background processes outlive the command | killed with it (unless `keepBackground`) |
| Policy problems | exit 126, command not run |

## What it costs (measured)

An AppContainer is default-deny, which is why it is strong, and also why ordinary developer tools break. These come
from real runs on a Windows runner (CI job "Escape tests (Windows)": tests marked `compat_`, and the diagnostics step).

| Tool or action | Inside the container |
|---|---|
| PowerShell 5.1 and 7, cmd, `curl`, tools in `System32` | run |
| Git bash and every MSYS2 shell | **cannot start.** Their runtime creates `\BaseNamedObjects\msys-2.0S5-*`, denied with `0xC0000022`. The policy refuses them, and the sandbox uses PowerShell or cmd instead of the Git bash the engine prefers. |
| The NUL device (`> NUL`, `type NUL`, `/dev/null`) | **denied** ("Access is denied"). Git opens `/dev/null` read-write on every start, so `git` dies at once. Python's `subprocess.DEVNULL` and Node's `stdio: "ignore"` need it too. |
| The NUL device after `harness-sandbox --setup` | **works.** One elevated run grants only this container's SID read and write on NUL. After it, `git --version` runs in cmd and PowerShell 7 and `> NUL` works. |
| `git init` / `git status` in the workspace | **still fails** (`unable to get current working directory: Permission denied`). Git resolves its working directory with `GetLongPathName`, which lists every parent folder, and the container can list only the workspace. |
| PowerShell's working location | falls back to `C:\`, for the same reason, so a relative `Set-Content x.txt` targets `C:\x.txt` and is denied. |
| PowerShell 5.1 running an external program with `&` | `Cannot find drive. A drive with the name 'Microsoft.PowerShell.Core\FileSystem' does not exist`. |
| A tool under Program Files | runs only if its folder grants `ALL APPLICATION PACKAGES` read. The runner's `node.exe` did not, and was denied. |

Getting git and PowerShell to work fully would mean granting the container list access on every ancestor of each
workspace. That leaks folder names along the path, and the top ancestors (`C:\`, `C:\Users`) are owned by
administrators, so it needs the elevated setup as well. That is the point at which this approach stops being a small
add-on: see "Where this leaves the Windows sandbox".

## Where this leaves the Windows sandbox

What is proven: filesystem, network, loopback and process isolation, with controls (table above). What is not
usable yet: a coding agent's normal toolchain, above all `git`.

Options, in the order I would consider them:

1. **Keep the AppContainer as an opt-in strict mode** (what is built). Good for running untrusted scripts or tests
   with no network and no file access. Not the default agent shell.
2. **A dedicated low-privilege sandbox user with firewall rules** (how OpenAI's Codex does it on Windows). A normal
   user token has none of the AppContainer quirks (NUL, MSYS2, parent listing), your own files are private to your
   account, and a per-user firewall rule blocks the network. It needs an elevated one-time setup that creates the
   account and rules, password handling, and care over file ownership in the workspace. More work, far better
   compatibility.
3. **Do Linux first** (bubblewrap or Landlock plus seccomp). Far fewer compatibility problems, and it protects the
   platform the CI and most servers run on.
4. **A VM** (WSL2 or Hyper-V), as Claude Cowork does. Strongest and heaviest.

## What the helper refuses

Drive roots, the Windows and Program Files folders, `C:\Users`, the user's profile and AppData themselves (a workspace
*inside* them is fine), anything inside `.ssh`, `.aws`, `.gnupg`, `.azure`, `.kube`, `.docker` or `.config\gh`, anything
overlapping a protected folder (Harness's own data, the audit log, the key vault), UNC and device paths, and unknown
policy fields. Paths are judged after junctions and short names are followed.

## Not covered

- Linux and macOS: no backend. Asking for the sandbox there fails.
- A workspace-write sandbox lets the agent change files in the workspace, including `.git/hooks`, which run later
  outside the sandbox. This is inherent to letting it write the workspace at all.
- Processes the engine starts that are not shell commands (MCP servers, language servers) are not sandboxed.
- The terminal pane's interactive shell goes through the same helper; console attachment inside the container is not
  yet verified.
- Job memory and process limits are set but not yet exercised by a test.
- The elevated `--setup` step exists and is tested only on a CI runner (which is an administrator); the desktop does not
  run it yet.
- The helper is not signed, so its provenance rests on the CI build (checklist item 4).
