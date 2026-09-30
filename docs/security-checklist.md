# Security checklist: prototype to 8/10

Base: `fix/windows-memory` (`32f2897`). Tick a box only with evidence: a test, a
command output or a linked report.

- [ ] **1. Keys unreachable from the agent's shell** (mostly done; two gaps below)
  - [x] Shells and terminals the agent starts no longer receive `HARNESS_SERVER_TOKEN`, `HARNESS_HOST_TOKEN`, `OPENCODE_SERVER_PASSWORD` and the other Harness credentials (`harness-shell-env` plugin, `shell.env` hook).
  - [x] Harness's proxy of the engine's `/config`, `/config/providers`, `/provider` and `/global/config` redacts provider keys by field name and by exact value, and withholds output it cannot check.
  - [x] Real-engine test (`engine-secret-isolation.real-engine.e2e.test.ts`): from an agent shell no credential is present, unauthenticated routes return 401, and no Harness route returns the key. Fails without either half of the fix.
  - [ ] **Gap A, needs item 3:** a process running as the same OS user can still read the engine's own environment (`/proc/<pid>/environ` on Linux) and so its password, and the engine's own `/config` still returns keys to whoever holds that password. Closing it means the agent's processes must not be able to inspect the engine (the OS sandbox), or the engine must stop holding keys in its config.
  - [ ] **Gap B, needs engine support:** MCP OAuth tokens live in the engine's `mcp-auth.json` (written 0600 by the engine, read directly by it). Moving them into the keychain or vault needs the engine to read tokens from somewhere else. Encrypting the file while the engine is stopped would still leave plaintext while it runs.

- ~~[x] **2. Windows memory works**~~ Done on `fix/windows-memory`.

- [ ] **3. Sandbox the agent's file, process and network access at the OS level**
  - [ ] Files: writes limited to the workspace and the app's own data folders.
  - [ ] Network: deny by default, allow only the user's configured model endpoint and loopback.
  - [ ] Processes: the agent's children cannot signal, trace or read the app's processes.
  - [ ] Linux (Landlock, seccomp or bubblewrap), macOS (Seatbelt), Windows (restricted token plus job object or AppContainer).
  - [ ] Escape tests per platform: read `~/.ssh`, open an outside socket, kill the app.
  - Status: a Windows AppContainer helper is built, opt-in, and escape-tested on a real Windows runner (files, network, loopback, killing other processes, background processes); Linux and macOS have no backend. It is not the default because ordinary tools (git above all) do not yet work inside it. See `docs/agent-sandbox.md`.

- [ ] **4. Signed builds and provenance**
  - [ ] Code-sign the Windows build and sign and notarize the macOS build.
  - [ ] Sign auto-updates, and verify the signature before applying.
  - [ ] Publish an SBOM (CycloneDX) and checksums with every release.
  - [ ] CI build provenance (SLSA attestation); a second build reproduces the same hashes.

- [ ] **5. Threat model, pentest, prompt-injection eval**
  - [ ] Threat model: assets, trust boundaries, attackers, abuse cases. Checked into the repo.
  - [ ] Prompt-injection eval: hostile text arriving through files, web pages and MCP tool output. Measure key exfiltration, writes outside the workspace and unexpected egress.
  - [ ] External penetration test of the packaged app; publish a summary and fix every high finding.

- [ ] **6. Audit log anchored or signed off-machine**
  - [ ] Key the chain with a per-install secret held in the keychain.
  - [ ] Periodically anchor the head hash somewhere the user controls or configures (opt-in, so the no-unconfigured-hosts rule holds).
  - [ ] A `verify` command that checks the chain and the anchors.
  - [ ] Tamper test: rewrite the whole log locally and show verification fails.

## From the OWASP assessment (`docs/owasp-assessment.md`)

- [x] **F1 (High):** `openExternal` allows only https, http and mailto; local paths that would run code are shown in their folder, never opened (`external-open-policy.mjs`).
- [x] F1b: `__openWithApp` only launches applications Harness discovered itself.
- [x] F2: main window sandboxed with a bundled CommonJS preload. Checked on Linux under the real Chromium sandbox. Still to check on Windows and macOS: PDF viewer, drag and drop, the desktop journeys.
- [x] F3: upgraded `fast-uri`, `undici` and `ip-address`; `pnpm audit` is clean in the root and `evals`.
- [x] F4: CSP on the app window (scripts locked to the app). Follow-up: tighten `connect-src` and `img-src` after watching real traffic; remote images are a prompt-injection leak channel.
- [x] F9: privileged IPC channels answer only the main window (`ipc-trust.mjs`).
- [ ] F5: constant-time host-token comparison.
- [ ] F6: JSON body size limit and general rate limiting.
- [ ] F7: default CORS to the app's origin, not `*`.

## Also tracked (found during validation)

- [ ] Empty the Harness credentials for every engine child (MCP servers, language servers), not only shells and terminals.
- [ ] Route the remaining `harness:` IPC channels (updater, browser logins, recovery, migration) through the trusted-sender wrapper.
- [ ] Serve the app from a custom protocol instead of `file://`, so CSP `'self'` no longer matches every local file.
- [ ] Replace the code-type denylist with an allowlist of safe document types; restrict `mailto:` query strings.
- [ ] Scrub event-stream responses from the engine proxy as well as JSON.

- [ ] Windows database isolation is weaker (127.0.0.1 with a password only; Linux and macOS use a private socket). Look for a named pipe or a restricted ACL.
- [ ] Audit the engine's session-shell path (currently not recorded).
- [ ] The architecture-mismatch check fetches from github.com unprompted. Make it opt-in or remove it.
- [ ] The standalone `harness-server` binary depends on the user's own `DO_NOT_TRACK` outside Docker. Set it in code.
- [ ] Symlink loops in workspace paths should return 400, not a raw error.
