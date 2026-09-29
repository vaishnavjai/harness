# OWASP and SOC 2 gap assessment

Branch `harness-update`, commit `fffca9d`. Platform tested: Linux only.
Method: automated dependency scans plus a targeted code review of the desktop
main process, the server and the renderer. It is not a penetration test and not
a full code audit. Everything marked "not assessed" was not looked at.

## Result

Not compliant with either standard, and one finding is high severity.

| # | Finding | Severity |
|---|---|---|
| F1 | `openExternal` and `openPath` accept any scheme or path | **High, fixed** (F1b open) |
| F2 | Main window runs with `sandbox: false` | Medium (fix is feasible, see below) |
| F3 | Vulnerable npm dependencies (2 high, 4 moderate) | Medium, fixed |
| F4 | No Content-Security-Policy on the app window | Medium |
| F5 | Host token compared with `===`, not constant time | Low |
| F6 | JSON bodies have no size limit; no general rate limiting | Low |
| F7 | Default CORS is `*`; the Docker image also binds `0.0.0.0` | Low |
| F8 | API responses lack `nosniff` and similar headers | Low |
| F9 | Most IPC handlers do not check who sent the message | Info |

## OWASP Top 10 (2021)

| Risk | Status | Evidence |
|---|---|---|
| A01 Broken access control | Partial | Per-launch tokens, loopback binding, engine-secret routes, symlink and path checks all hold. Gaps: F9, F1b, and the agent runs as the user with no OS sandbox (checklist item 3). |
| A02 Cryptographic failures | Partial | Provider keys use the OS keychain or AES-256-GCM. MCP OAuth tokens are plaintext (checklist gap B). Windows Postgres is password-only. |
| A03 Injection | Partial | Spawns use argument vectors; markdown output is sanitised with DOMPurify (`markdown-primitive.ts`). Prompt injection is untested. |
| A04 Insecure design | Fail | No threat model. |
| A05 Security misconfiguration | Fail | F2, F4, F7, F8. |
| A06 Vulnerable components | Partial | Python: `pip-audit` on the 191 hashed packages found nothing. npm: F3. No SBOM. |
| A07 Authentication failures | Partial | Client tokens are verified through a token service and stored hashed. F5, F6. |
| A08 Integrity failures | Fail | Builds are unsigned, with no provenance. Dependencies are pinned and hashed. |
| A09 Logging and monitoring | Partial | Hash-chained local audit log. Not anchored off-machine; the engine's session-shell path is not recorded; no alerting. |
| A10 SSRF | Not assessed | MCP server URLs are user-supplied and the server proxies to the engine. Not reviewed. |

## Findings

**F1 (High, fixed). `shell.openExternal` and `shell.openPath` with unvalidated input.**
- Found: `open-external.mjs` had no scheme check; the IPC handler `harness:shell:openExternal`, the window-open handler and the Windows `rundll32 url.dll,FileProtocolHandler` fallback all took any string; `__openPath` and `file://` popups passed any path to `shell.openPath`. On Windows that runs protocol handlers and executables. Any renderer path that passes a URL reached it, including OAuth URLs a remote MCP server supplies.
- Fixed in `apps/desktop/electron/external-open-policy.mjs`:
  - `openExternal` accepts only `https:`, `http:` and `mailto:`, refuses credentials, control characters and oversized input, and opens the URL as the parser normalises it (this covers the `rundll32` fallback too).
  - Local paths open only if they are folders or files that would not run code. Executable, script, installer, shortcut and app-bundle types (and symlinks to them, and Windows names with trailing dots or spaces) are shown in their folder instead. Applies to `__openPath`, `file://` popups and workspace file links.
- Tests: `external-open-policy.test.mjs` (13) plus new cases in `open-external.test.mjs`.
- Still open, related (F1b): `__openWithApp` on Linux spawns the app path the renderer sends. It is chosen from a discovered list, so exploiting it needs a compromised renderer, but the path is not validated. Restrict it to the discovered apps or refuse paths inside a workspace.

**F2 (Medium, checked, not yet fixed).** `main.mjs:2718` sets `sandbox: false` for the main window (context isolation is on, Node integration is off). Check result:
- The preload only uses Electron's renderer APIs (`contextBridge`, `ipcRenderer`, `webFrame`, `webUtils`), `process.platform`, `process.env`, `process.versions` and `process.isMainFrame`, plus one relative import. It needs no Node modules.
- The blocker is its format. `preload.mjs` is an ES module, and a sandboxed preload cannot load one. With `sandbox: true` it fails with "Cannot use import statement outside a module" and the whole `__HARNESS_ELECTRON__` bridge is missing.
- Bundling it to one CommonJS file works. Measured on Electron 43 as an unprivileged user with the real Chromium sandbox helper: the bundled preload under `sandbox: true` reports `process.sandboxed === true` and exposes the same 15 bridge members as today's unsandboxed preload. The three synchronous IPC calls at load work in both modes.
- Fix: bundle `preload.mjs` (with `browser-shortcut-focus.mjs`) to CommonJS in the desktop build, point `preloadPath` at it, set `sandbox: true`. The browser panel already runs sandboxed with a CommonJS preload (`browser-content-preload.cjs`).
- Not tested: the full app under the sandbox (PDF viewer with `plugins: true`, drag and drop through `webUtils`, the eval journeys) and macOS or Windows. Run the desktop journeys before shipping it.

**F3 (Medium, fixed).** `pnpm audit --prod` reported `fast-uri` 3.1.6 (2 high: authority injection and host confusion), `undici` 6.28.0 and 7.29.0 (moderate: WebSocket denial of service) and `ip-address` 10.3.1 (moderate: address classification). Upgraded to `fast-uri` 3.1.8, `undici` 6.28.1 and 7.29.1, `ip-address` 10.7.2 through the workspace overrides and the two direct `undici` pins. `pnpm audit` now reports 0 vulnerabilities across production and dev dependencies, in the root and the `evals` workspace. Server (270), desktop (195) and app (369) core tests and typechecks pass. Reachability was never analysed, so the impact of the old versions is unknown.

**F4 (Medium).** `apps/app/index.html` has no CSP. Markdown is sanitised, but a CSP would limit the damage of any miss.

**F5 (Low).** `server.ts:2249` and `:2257` compare the host token with `===`. Use `timingSafeEqual`. Loopback only, so low.

**F6 (Low).** `readJsonBody` (`server.ts:4551`) reads unbounded bodies, and only the agent-diagnostics route is rate limited. Another local process can exhaust memory.

**F7 (Low).** `config.ts:314` defaults CORS to `*`. The Docker image runs `--host 0.0.0.0 --cors '*'` by design. Tokens still gate access, but the default should be the app's own origin.

**F8 (Low).** Only the MCP-app routes set `nosniff`, `Referrer-Policy` and a CSP.

**F9 (Info).** 13 `ipcMain.handle` handlers; only the Computer Use handler checks the sender frame (`main.mjs:2047`). Navigation is restricted, so risk is low today.

## OWASP Top 10 for LLM apps

| Risk | Status |
|---|---|
| LLM01 Prompt injection | Untested. No eval exists (checklist item 5). |
| LLM02 Sensitive information disclosure | Partial. Keys are isolated from agent shells and redacted from proxied reads; same-user gap A remains. |
| LLM05 Improper output handling | Partial. Markdown is sanitised and external opens are allowlisted (F1). |
| LLM06 Excessive agency | Open. The agent has the user's shell and file access; approval prompts exist, no OS sandbox. |
| LLM03 Supply chain | Open. Plugins and MCP servers are unsigned and user-installed. |

## SOC 2

SOC 2 attests a company's controls over months, performed by a CPA firm; code cannot be SOC 2 compliant. Controls this codebase could support, and where it stands:
- Logical access (CC6): tokens and keychain in place; F1, F5, F9 open.
- Monitoring (CC7): audit log exists; no alerting, no off-machine anchoring.
- Change management (CC8): not met. Changes went straight to `dev`, without required CI or independent human review.
- Risk assessment (CC3), incident response, vendor management: none exist.

## Not assessed

SSRF, the `harness:desktop` IPC command set, the auto-update path, the MCP OAuth flow end to end, Windows and macOS behaviour, and static analysis (CodeQL or Semgrep).

## Reproduce

```
pnpm audit --prod
uvx pip-audit --no-deps --disable-pip -r vendor/hindsight/requirements.lock.txt
```
