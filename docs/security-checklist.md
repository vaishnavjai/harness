# Security checklist: prototype to 8/10

Base: `fix/windows-memory` (`32f2897`). Tick a box only with evidence: a test, a
command output or a linked report.

- [ ] **1. Keys unreachable from the agent's shell**
  - [ ] Stop passing `HARNESS_SERVER_TOKEN` and `OPENCODE_SERVER_PASSWORD` into shells the agent runs.
  - [ ] Never return provider keys from the server's `/opencode/config` and `/opencode/provider` routes or the engine's `/config` and `/provider` routes. Redact them, or broker model calls so a key never leaves the server.
  - [ ] Move MCP OAuth tokens (`mcp-auth.json`) into the OS keychain or the AES-256-GCM vault.
  - [ ] Test: from a real agent shell, no reachable route or file yields a provider key or token.

- ~~[x] **2. Windows memory works**~~ Done on `fix/windows-memory`.

- [ ] **3. Sandbox the agent's file, process and network access at the OS level**
  - [ ] Files: writes limited to the workspace and the app's own data folders.
  - [ ] Network: deny by default, allow only the user's configured model endpoint and loopback.
  - [ ] Processes: the agent's children cannot signal, trace or read the app's processes.
  - [ ] Linux (Landlock, seccomp or bubblewrap), macOS (Seatbelt), Windows (restricted token plus job object or AppContainer).
  - [ ] Escape tests per platform: read `~/.ssh`, open an outside socket, kill the app.

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

## Also tracked (found during validation)

- [ ] Windows database isolation is weaker (127.0.0.1 with a password only; Linux and macOS use a private socket). Look for a named pipe or a restricted ACL.
- [ ] Add a Content-Security-Policy to the app window.
- [ ] Audit the engine's session-shell path (currently not recorded).
- [ ] The architecture-mismatch check fetches from github.com unprompted. Make it opt-in or remove it.
- [ ] The standalone `harness-server` binary depends on the user's own `DO_NOT_TRACK` outside Docker. Set it in code.
- [ ] Symlink loops in workspace paths should return 400, not a raw error.
