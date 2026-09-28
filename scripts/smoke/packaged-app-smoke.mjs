#!/usr/bin/env node
// Launches the app `npm run package` built, as an unprivileged user on a
// virtual display, with memory turned on, and checks what a user would rely on:
//
//   - the app starts and records `app.started` in the audit log,
//   - the Hindsight memory engine comes up and listens on 127.0.0.1 only,
//   - every listening socket the app opens is loopback, and none is DevTools,
//   - no connection leaves the machine while it runs (proxy variables removed),
//   - on SIGTERM the app quits and leaves no process behind,
//   - the audit log's hash chain verifies.
//
//   node scripts/smoke/packaged-app-smoke.mjs      # Linux, needs Xvfb; run as root
//   node scripts/smoke/packaged-app-smoke.mjs --log-hosts
//     routes the app through a local proxy that refuses every request and
//     reports the hostnames asked for, to explain a failed egress check
//
// Prints a JSON report and exits non-zero on any failure.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findUnpackedApp } from "../package.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NOBODY = 65_534;
const APP_START_TIMEOUT_MS = 90_000;
const MEMORY_READY_TIMEOUT_MS = 300_000;
const QUIT_TIMEOUT_MS = 45_000;

/** Parse /proc/net/tcp{,6} into sockets with their owning inode. */
export function parseProcNetTcp(text, family) {
  const sockets = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const [localHex, localPort] = fields[1].split(":");
    const [remoteHex, remotePort] = fields[2].split(":");
    sockets.push({
      local: { address: hexToAddress(localHex, family), port: Number.parseInt(localPort, 16) },
      remote: { address: hexToAddress(remoteHex, family), port: Number.parseInt(remotePort, 16) },
      state: fields[3],
      inode: fields[9],
    });
  }
  return sockets;
}

/** /proc stores IPv4 as one little-endian word, IPv6 as four. */
export function hexToAddress(hex, family) {
  if (family === 4) {
    const bytes = hex.match(/../g).map((byte) => Number.parseInt(byte, 16)).reverse();
    return bytes.join(".");
  }
  const words = hex.match(/.{8}/g).map((word) => word.match(/../g).reverse().join(""));
  const groups = words.join("").match(/.{4}/g).map((group) => group.replace(/^0+(?=.)/, ""));
  const text = groups.join(":").toLowerCase();
  if (text.startsWith("0:0:0:0:0:ffff:")) {
    const tail = words[3];
    return [0, 2, 4, 6].map((index) => Number.parseInt(tail.slice(index, index + 2), 16)).join(".");
  }
  return text.replace(/(^|:)0(:0)+(:|$)/, "::");
}

export function isLoopbackAddress(address) {
  return address === "::1" || address.startsWith("127.");
}

const TCP_STATE = { LISTEN: "0A", ESTABLISHED: "01", SYN_SENT: "02" };

function processesOwnedBy(uid) {
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const owner = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
      if (owner !== uid) continue;
      const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      found.push({ pid: Number(entry), args });
    } catch {
      // Exited while we looked.
    }
  }
  return found;
}

function socketInodesOf(pids) {
  const inodes = new Map();
  for (const pid of pids) {
    let fds = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match) inodes.set(match[1], pid);
      } catch {
        // Closed while we looked.
      }
    }
  }
  return inodes;
}

function socketsOf(pids) {
  const inodes = socketInodesOf(pids);
  const all = [
    ...parseProcNetTcp(readFileSync("/proc/net/tcp", "utf8"), 4),
    ...(existsSync("/proc/net/tcp6") ? parseProcNetTcp(readFileSync("/proc/net/tcp6", "utf8"), 6) : []),
  ];
  return all.filter((socket) => inodes.has(socket.inode)).map((socket) => ({ ...socket, pid: inodes.get(socket.inode) }));
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
    });
  });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}.`);
    await sleep(500);
  }
}

function chownTree(path, uid) {
  chownSync(path, uid, uid);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) chownTree(join(path, entry.name), uid);
    else chownSync(join(path, entry.name), uid, uid);
  }
}

async function main() {
  if (process.platform !== "linux") throw new Error("The packaged-app smoke runs on Linux.");
  if (process.getuid?.() !== 0) throw new Error("Run as root: the app itself is started as an unprivileged user.");
  if (spawnSync("Xvfb", ["-help"], { stdio: "ignore" }).error) throw new Error("Xvfb is required.");
  const app = findUnpackedApp(join(repoRoot, "apps", "desktop", "dist-electron"));
  if (!app) throw new Error("No packaged app found. Run `npm run package` first.");
  const executable = join(app.root, "harness");

  const report = { app: app.root, checks: [], passed: false };
  const check = (name, ok, detail = {}) => {
    report.checks.push({ name, ok, ...detail });
    if (!ok) throw new Error(`${name} failed: ${JSON.stringify(detail)}`);
  };

  const root = mkdtempSync(join(tmpdir(), "harness-smoke-"));
  const home = join(root, "home");
  const configHome = join(home, ".config");
  mkdirSync(join(configHome, "harness"), { recursive: true });
  const memoryPort = await freePort();
  writeFileSync(join(configHome, "harness", "memory.json"), JSON.stringify({ enabled: true, port: memoryPort }));
  chownTree(root, NOBODY);

  // --log-hosts: a proxy that refuses everything but records what was asked.
  const requestedHosts = new Set();
  let hostLogger = null;
  if (process.argv.includes("--log-hosts")) {
    hostLogger = createServer((request, response) => {
      request.socket.on("error", () => undefined);
      requestedHosts.add(`http ${request.headers.host ?? request.url}`);
      response.writeHead(403).end();
    });
    hostLogger.on("connect", (request, socket) => {
      socket.on("error", () => undefined);
      requestedHosts.add(request.url);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise((resolveListen) => hostLogger.listen(0, "127.0.0.1", resolveListen));
  }

  const display = 90 + Math.floor(Math.random() * 100);
  const xvfb = spawn("Xvfb", [`:${display}`, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"], { stdio: "ignore" });
  await sleep(1_000);

  const env = {
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    PATH: "/usr/local/bin:/usr/bin:/bin",
    DISPLAY: `:${display}`,
    LANG: "C.UTF-8",
    // A basic keyring would make Electron refuse to store secrets; the smoke
    // only needs the app to start, so use the mock keychain Harness ships for tests.
    HARNESS_ELECTRON_USE_MOCK_KEYCHAIN: "1",
  };
  if (hostLogger) {
    const address = hostLogger.address();
    const proxy = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" });
  }
  const appProcess = spawn(executable, ["--no-sandbox", "--disable-gpu"], { env, uid: NOBODY, gid: NOBODY, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  appProcess.stdout.on("data", (chunk) => { output = (output + chunk).slice(-20_000); });
  appProcess.stderr.on("data", (chunk) => { output = (output + chunk).slice(-20_000); });
  let exited = null;
  appProcess.once("exit", (code, signal) => { exited = { code, signal }; });

  /** remote address -> the process that opened it */
  const remoteConnections = new Map();
  const sampler = setInterval(() => {
    const owned = processesOwnedBy(NOBODY);
    const argsByPid = new Map(owned.map((process) => [process.pid, process.args]));
    for (const socket of socketsOf(owned.map((process) => process.pid))) {
      if (socket.state === TCP_STATE.LISTEN) continue;
      if (!isLoopbackAddress(socket.remote.address) && socket.remote.address !== "0.0.0.0" && socket.remote.address !== "::") {
        const remote = `${socket.remote.address}:${socket.remote.port}`;
        if (!remoteConnections.has(remote)) remoteConnections.set(remote, (argsByPid.get(socket.pid) ?? "").slice(0, 200));
      }
    }
  }, 250);

  const auditPath = join(configHome, "harness", "audit.log");
  try {
    await waitFor("the app to start and write app.started to the audit log", APP_START_TIMEOUT_MS, () => {
      if (exited) throw new Error(`The app exited early (${JSON.stringify(exited)}):\n${output}`);
      return existsSync(auditPath) && readFileSync(auditPath, "utf8").includes('"app.started"');
    });
    check("app starts and records app.started", true);

    const memoryReady = await waitFor("the memory engine to answer on loopback", MEMORY_READY_TIMEOUT_MS, async () => {
      if (exited) throw new Error(`The app exited (${JSON.stringify(exited)}):\n${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${memoryPort}/health`, { signal: AbortSignal.timeout(1_000) });
        return response.status < 500 ? response.status : null;
      } catch {
        return null;
      }
    });
    check("memory engine is up", true, { port: memoryPort, healthStatus: memoryReady });

    const running = processesOwnedBy(NOBODY);
    const listeners = socketsOf(running.map((process) => process.pid)).filter((socket) => socket.state === TCP_STATE.LISTEN);
    const memoryListeners = listeners.filter((socket) => socket.local.port === memoryPort);
    check("memory engine listens on 127.0.0.1 only", memoryListeners.length > 0 && memoryListeners.every((socket) => isLoopbackAddress(socket.local.address)), {
      listeners: memoryListeners.map((socket) => `${socket.local.address}:${socket.local.port}`),
    });
    const exposed = listeners.filter((socket) => !isLoopbackAddress(socket.local.address));
    check("every listening socket is loopback", exposed.length === 0, {
      listeners: listeners.map((socket) => `${socket.local.address}:${socket.local.port}`),
    });
    // No listener may speak the DevTools protocol: it would hand any local
    // process full control of the app window.
    const devtools = [];
    for (const socket of listeners) {
      try {
        const response = await fetch(`http://127.0.0.1:${socket.local.port}/json/version`, { signal: AbortSignal.timeout(1_000) });
        const body = await response.text();
        if (body.includes("webSocketDebuggerUrl")) devtools.push(socket.local.port);
      } catch {
        // Not HTTP, or not answering: not DevTools.
      }
    }
    check("no DevTools protocol port is open", devtools.length === 0, { devtoolsPorts: devtools });
    check("expected processes are running", running.some((process) => process.args.includes("harness_hindsight_launcher.py"))
      && running.some((process) => /\/sidecars\/opencode(?:-[\w-]+)?(?:\s|$)/.test(process.args)), {
      processes: running.map((process) => process.args.slice(0, 160)),
    });

    process.kill(appProcess.pid, "SIGTERM");
    await waitFor("the app to quit after SIGTERM", QUIT_TIMEOUT_MS, () => exited !== null);
    const survivors = await waitFor("every child process to exit", 15_000, () => {
      const left = processesOwnedBy(NOBODY);
      return left.length === 0 ? [] : null;
    }).catch(() => processesOwnedBy(NOBODY));
    check("no process survives quit", survivors.length === 0, { survivors: survivors.map((process) => process.args.slice(0, 160)) });

    check("no connection left the machine", remoteConnections.size === 0, {
      remote: [...remoteConnections].map(([remote, owner]) => ({ remote, owner })),
    });

    const { verifyAuditLog } = await import(pathToFileURL(join(repoRoot, "packages", "audit", "dist", "index.js")).href);
    const verification = await verifyAuditLog(auditPath);
    check("audit log chain verifies", verification.ok === true, verification);
    report.passed = true;
  } finally {
    clearInterval(sampler);
    if (hostLogger) {
      report.requestedHosts = [...requestedHosts].sort();
      hostLogger.close();
    }
    if (!exited) appProcess.kill("SIGKILL");
    for (const leftover of processesOwnedBy(NOBODY)) {
      try { process.kill(leftover.pid, "SIGKILL"); } catch { /* gone */ }
    }
    xvfb.kill("SIGTERM");
    if (!report.passed) report.output = output.slice(-4_000);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (process.argv.includes("--keep")) process.stdout.write(`Kept ${root}\n`);
    else rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nPackaged-app smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
