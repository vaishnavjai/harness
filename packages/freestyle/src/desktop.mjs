import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

// Controller-owned: a virtual display, a VNC server bound to loopback, and the
// noVNC web client, all behind the preview gateway's own access check. The
// Harness desktop app itself comes from the reviewed commit in /workspace.
const DESKTOP_DISPLAY = ":99";
const NOVNC_PORT = 6080;
const VNC_PORT = 5900;
const CDP_PORT = 9825;
const LOGS = "/opt/harness-preview/desktop";

function service(stack, command, args, name) {
  const log = openSync(`${LOGS}/${name}.log`, "a", 0o600);
  const child = spawn(command, args, { stdio: ["ignore", log, log], detached: true, env: { ...process.env, DISPLAY: DESKTOP_DISPLAY } });
  closeSync(log);
  child.unref();
  stack.defer(() => { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ } });
  return child;
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* not ready yet */ }
    await delay(500);
  }
  throw new Error(`Desktop ${label} did not become ready`);
}

export async function prepareDesktopProfile() {
  const { prepareBlankSlateProfile } = await import("/workspace/apps/desktop/electron/blank-slate-profile.mjs");
  return prepareBlankSlateProfile({ argv: ["--blank-slate"], env: {}, temporaryDirectory: LOGS });
}

export function desktopProfileEnvironment(profile, environment = process.env) {
  return {
    PATH: environment.PATH, LANG: "en_US.UTF-8",
    BROWSER: "/usr/local/bin/harness-preview-browser",
    pnpm_config_verify_deps_before_run: "false", GOMEMLIMIT: "512MiB",
    COREPACK_HOME: "/opt/harness-preview/corepack", COREPACK_ENABLE_NETWORK: "0",
    ...profile.environment,
    DAYTONA_SECRETS_ENV: "/dev/null",
    HARNESS_ELECTRON_SKIP_NATIVE_REBUILD: "1",
  };
}

export async function startDesktop(stack, { prepareProfile = prepareDesktopProfile } = {}) {
  mkdirSync(LOGS, { recursive: true, mode: 0o700 });
  mkdirSync("/tmp/.X11-unix", { recursive: true, mode: 0o1777 });
  service(stack, "Xvfb", [DESKTOP_DISPLAY, "-screen", "0", "1440x900x24", "-nolisten", "tcp"], "xvfb");
  await waitFor(() => existsSync(`/tmp/.X11-unix/X${DESKTOP_DISPLAY.slice(1)}`), "display");
  service(stack, "startxfce4", [], "xfce");
  service(stack, "x11vnc", ["-display", DESKTOP_DISPLAY, "-localhost", "-rfbport", String(VNC_PORT), "-forever", "-shared", "-nopw", "-quiet"], "x11vnc");
  service(stack, "websockify", ["--web", "/usr/share/novnc", `127.0.0.1:${NOVNC_PORT}`, `127.0.0.1:${VNC_PORT}`], "novnc");
  await waitFor(async () => (await fetch(`http://127.0.0.1:${NOVNC_PORT}/vnc.html`, { signal: AbortSignal.timeout(2_000) })).ok, "viewer");
  const status = (value) => writeFileSync(`${LOGS}/status`, value, { mode: 0o600 });
  status("starting");
  const profile = await prepareProfile();
  writeFileSync(`${LOGS}/profile.json`, JSON.stringify(profile), { mode: 0o600 });
  const env = {
    ...desktopProfileEnvironment(profile), DISPLAY: DESKTOP_DISPLAY, BROWSER: "/usr/local/bin/harness-preview-browser", HARNESS_WORKSPACE_DIR: "/workspace", PORT: "5186",
    HARNESS_ELECTRON_REMOTE_DEBUG_PORT: String(CDP_PORT), HARNESS_ELECTRON_USE_MOCK_KEYCHAIN: "1",
    HARNESS_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1",
    // The snapshot builder already fetched the sidecars and helpers.
    HARNESS_ELECTRON_SKIP_SHARED_PREPARE: "1",
    HARNESS_ELECTRON_SKIP_WORKSPACE_BUILD: "1",
  };
  const launcher = existsSync("/workspace/.devcontainer/start-daytona-electron.sh")
    ? "bash /workspace/.devcontainer/start-daytona-electron.sh" : "pnpm --filter @harness/desktop dev:electron";
  const log = openSync(`${LOGS}/electron.log`, "a", 0o600);
  const app = spawn("bash", ["-c", `while true; do ${launcher}; sleep 5; done`], { cwd: "/workspace", env, stdio: ["ignore", log, log], detached: true });
  closeSync(log);
  app.unref();
  stack.defer(() => { try { process.kill(-app.pid, "SIGTERM"); } catch { /* already exited */ } });
  const ready = (async () => {
    const deadline = Date.now() + 180_000;
    while (true) {
      if (Date.now() >= deadline) throw new Error("Desktop window did not become ready");
      try {
        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2_000) })).json();
        if (Array.isArray(targets) && targets.some((target) => target.type === "page")) break;
      } catch { /* still booting */ }
      await delay(3_000);
    }
    status("ready-signed-out");
    return true;
  })();
  return { url: `http://127.0.0.1:${NOVNC_PORT}`, ready };
}
