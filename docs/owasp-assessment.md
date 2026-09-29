# OWASP and SOC 2 gap assessment

Branch `harness-update`, commit `fffca9d`. Platform tested: Linux only.
Method: automated dependency scans plus a targeted code review of the desktop
main process, the server and the renderer. It is not a penetration test and not
a full code audit. Everything marked "not assessed" was not looked at.

## Result

Not compliant with either standard, and one finding is high severity.

| # | Finding | Severity |
|---|---|---|
| F1 | `openExternal` and `openPath` accept any scheme or path (and F1b, `__openWithApp`) | **High, fixed** |
| F2 | Main window runs with `sandbox: false` | Medium, fixed |
| F3 | Vulnerable npm dependencies (2 high, 4 moderate) | Medium, fixed |
| F4 | No Content-Security-Policy on the app window | Medium, fixed (connections and images still open) |
| F5 | Host token compared with `===`, not constant time | Low |
| F6 | JSON bodies have no size limit; no general rate limiting | Low |
| F7 | Default CORS is `*`; the Docker image also binds `0.0.0.0` | Low |
| F8 | API responses lack `nosniff` and similar headers | Low |
| F9 | Most IPC handlers do not check who sent the message | Info, fixed |

## OWASP Top 10 (2021)

| Risk | Status | Evidence |
|---|---|---|
| A01 Broken access control | Partial | Per-launch tokens, loopback binding, engine-secret routes, symlink and path checks all hold. Gap: the agent runs as the user with no OS sandbox (checklist item 3). |
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
- F1b (fixed): `__openWithApp` spawned whatever app path the renderer sent. It now re-derives the list of applications Harness discovers (`open-with-apps.mjs`) and refuses any path not on it. Residual: on Linux the list includes `~/.local/share/applications`, which the agent can write to.

**F2 (Medium, fixed).** The main window ran with `sandbox: false`, because `preload.mjs` is an ES module and a sandboxed preload cannot load one (it fails with "Cannot use import statement outside a module").
- Fix: `apps/desktop/scripts/build-preload.mjs` bundles the preload and what it imports into one CommonJS file, `electron/preload.cjs`, and fails the build if the bundle requires anything but `electron`. It runs in the desktop build, the dev script and `pnpm electron`. `main-window-security.mjs` gives the main window that preload with `sandbox: true`. A packaged app refuses to start without it; only an unbuilt development checkout falls back, with a warning.
- Verified on Linux with the packaged app, as an unprivileged user and without `--no-sandbox`: the renderer process shows `Seccomp: 2`, the bridge exposes all 15 members, `require` and `process` are absent from the page, and the app renders its session view.
- Not verified: Windows and macOS, and the PDF viewer and drag and drop under the sandbox.

**F3 (Medium, fixed).** `pnpm audit --prod` reported `fast-uri` 3.1.6 (2 high: authority injection and host confusion), `undici` 6.28.0 and 7.29.0 (moderate: WebSocket denial of service) and `ip-address` 10.3.1 (moderate: address classification). Upgraded to `fast-uri` 3.1.8, `undici` 6.28.1 and 7.29.1, `ip-address` 10.7.2 through the workspace overrides and the two direct `undici` pins. `pnpm audit` now reports 0 vulnerabilities across production and dev dependencies, in the root and the `evals` workspace. Server (270), desktop (195) and app (369) core tests and typechecks pass. Reachability was never analysed, so the impact of the old versions is unknown.

**F4 (Medium, fixed for scripts).** The app window had no CSP. `content-security-policy.mjs` now attaches one to the app's own document from the main process (Electron's header hook fires for `file://`), so no frontend file changed.
- Scripts: `'self'`, `'wasm-unsafe-eval'` and the SHA-256 of each inline script, computed from the shipped `index.html`. No `'unsafe-inline'`, no `'unsafe-eval'`. Plugins, workers, frames, base URI and form targets are locked to the app. A live dev server is exempt, and a packaged build fails if the policy cannot be built.
- Verified on Linux with the packaged app: the app boots and renders with zero CSP violations and zero console errors; a script injected into the page is blocked.
- Deliberately left open: `connect-src` (any http, https, ws or wss address) and `img-src` (any https address). The renderer talks to user-configured model endpoints, and chat shows remote images, so closing them blind could break the UI. Remote images are also a data-leak channel for prompt injection. Tighten both after watching real traffic.
- To test on another machine without blocking anything, start the app with `HARNESS_CSP_MODE=report-only` and read the console.

**F5 (Low).** `server.ts:2249` and `:2257` compare the host token with `===`. Use `timingSafeEqual`. Loopback only, so low.

**F6 (Low).** `readJsonBody` (`server.ts:4551`) reads unbounded bodies, and only the agent-diagnostics route is rate limited. Another local process can exhaust memory.

**F7 (Low).** `config.ts:314` defaults CORS to `*`. The Docker image runs `--host 0.0.0.0 --cors '*'` by design. Tokens still gate access, but the default should be the app's own origin.

**F8 (Low).** Only the MCP-app routes set `nosniff`, `Referrer-Policy` and a CSP.

**F9 (Info, fixed for privileged channels).** The 13 `harness:` IPC handlers did not check their sender. They are now registered through `ipc-trust.mjs`, so only the main window's main frame can call them; anything else is rejected, or receives a harmless default for the synchronous channels. A test fails if a new `harness:` channel is registered without the wrapper. The browser panel's own channels use a separate preload and are unchanged.

## Verification loop, round 2 (HEAD `b689f6e`)

The independent security validator broke three of the fixes above. All three are fixed, with tests.

- **Key redaction bypass (blocking, twice).** The proxy matched the raw path, but the engine decodes it: `GET /opencode/%63onfig`, `//config`, `/%70rovider` and `/config/%70roviders` returned the plaintext key, also to a read-only viewer token. A first fix that decoded and canonicalised the path was bypassed again by case (`/CONFIG`, `/pRoViDeR`) and `;` parameters (`/config;a=b`), because the engine routes case-insensitively and ignores `;...`. Listing routes only lists spellings to miss, so the design changed: every proxied JSON response is now scrubbed by the exact stored key values, whatever the path (the values are cached until the vault file changes; a response is buffered only when there are keys to look for; event streams and `ndjson` are left alone). Routes known to carry credentials are additionally scrubbed by field name, now case-insensitively and with `;` parameters stripped. The real-engine test requests 17 spellings and still passes with the path matcher disabled, which shows the value scrub carries the protection. Round 3 found that keys the vault does not hold were still exposed: a key the engine reads from the environment (`ANTHROPIC_API_KEY`) or from its own legacy `auth.json` (`PUT /auth/groq`) came back in the top-level `key` field of `/provider` and `/config/providers`. The scrub now also covers the values of credential-named variables in the server environment and in Harness's env store, the field-name list gained `key`, `token`, `authorization` and `credentials`, property names that are themselves a key are rewritten, JSON-escaped forms of a key are matched, and an unreadable vault falls back to the last values read. Bodyless statuses (204, 205, 304) pass through untouched. The real-engine test now sets an env key and a legacy `auth.json` key and asserts neither appears. The round-4 review passed this and left three notes, all since addressed: provider key variables that do not say `API_KEY` (`ABLIT_KEY`, `CLARIFAI_PAT`, `AICORE_SERVICE_KEY`) are now collected by a trailing `_KEY` or `_PAT`; variables that name a place (`*_FILE`, `*_DIR`, `*_PATH`, `*_URL`) and path- or URL-valued ones are skipped so ordinary output is not blanked; and an unreadable vault no longer stops the environment's keys being scrubbed on ordinary routes (credential routes still fail closed with a 502). Residual: event streams are not scrubbed, a key known only to the engine (its own `auth.json`) is scrubbed by field name on the credential routes but not by value elsewhere, and MCP `Authorization` header values in `/config` are not provider keys and are not redacted.
- **Reveal fallback (blocking).** `__revealItemInDir` opened the parent of a missing file without the F1 check, so `payload.sh/missing` opened the script. It now goes through `checkOpenablePath` and requires a real folder.
- **Leading-dot names on Windows (blocking).** `.bat`, `.exe`, `.lnk` and similar have an empty extension to `path.extname`, so they passed. A leading-dot name now carries that extension. More types added (`rdp`, `jnlp`, `pyz`, `wsc`, `xbap`, `vsto`, `website` and others).
- **Also fixed:** network paths (`\\\\host\\share`) are refused before any resolution on Windows in every open path; the browser panel's "open externally" now goes through the same URL check; `file://host/share` links are refused (they would start an SMB request on Windows); the UI-control discovery file holding a token is written 0600.
- **Launcher (backend validator).** `signal.raise_signal` from the watcher thread does not wake a main thread parked in a long wait, so graceful shutdown could wait for the 20 second hard-exit timer and leave Postgres behind. On POSIX the launcher now signals the process (`os.kill`), with a regression test that fails on the old launcher. Its own orphan-guard test had the same flaw and failed on Linux; fixed.

Still open, recorded rather than fixed:
- Only shells and terminals get the credentials emptied. Other engine children (local MCP servers, language servers, formatters) still inherit `OPENCODE_SERVER_PASSWORD` and `HARNESS_SERVER_TOKEN`.
- About 90 other `harness:` IPC channels (updater, browser logins, recovery, migration) still use raw `ipcMain`, some with their own sender checks. No path from a non-main frame was found.
- On `file://`, CSP `'self'` matches every `file:` URL in Chromium; a custom protocol for the app would close that.
- The code-type check is a denylist. An allowlist of safe document types would be stronger. `mailto:` links pass any query string.
- On Windows the launcher's orphan guard quietly turns off if stdin is not a pipe.

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
- Logical access (CC6): tokens and keychain in place, IPC and external opens locked down; F5 open.
- Monitoring (CC7): audit log exists; no alerting, no off-machine anchoring.
- Change management (CC8): not met. Changes went straight to `dev`, without required CI or independent human review.
- Risk assessment (CC3), incident response, vendor management: none exist.

## Not assessed

SSRF, the `harness:desktop` IPC command set, the auto-update path, the MCP OAuth flow end to end, Windows and macOS behaviour, and static analysis (CodeQL or Semgrep).

## Known gaps left open

- The bundled Python runtime carries `pip 24.3.1` and `setuptools 80.9.0` from the standalone Python build, not from the lockfile. `pip-audit` lists advisories for both (fixed in pip 26.2 and setuptools 83.0.0). Nothing at runtime imports them; the fix is to drop them in the runtime policy or bump them, then rebuild.
- `pnpm --filter @harness/desktop test` (the full script; `test:core` is unaffected) has one failing test that predates this work: `server-dependency-mirror` expects `@ai-sdk/provider` in `apps/desktop/package.json`. It does not break the packaged app, because the gateway-quota plugin is bundled with that package inlined.

## Reproduce

```
pnpm audit --prod
uvx pip-audit --no-deps --disable-pip -r vendor/hindsight/requirements.lock.txt
# the runtime as shipped (site-packages of the bundle only, not the host's user site):
PYTHONNOUSERSITE=1 apps/desktop/dist-electron/linux-unpacked/resources/hindsight-runtime/python/bin/python -s -m pip list --format=freeze > runtime.txt
uvx pip-audit --no-deps --disable-pip -r runtime.txt
```
