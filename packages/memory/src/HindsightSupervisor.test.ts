import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HindsightMemoryClient } from "./hindsight-client.js";
import { HindsightSupervisor, type ProcessHookTarget } from "./HindsightSupervisor.js";
import { parseMemorySettings } from "./memory-settings.js";
import { isProcessAlive, waitForExit } from "./process-tree.js";

const fakeEngine = fileURLToPath(new URL("./test-fixtures/fake-hindsight-engine.mjs", import.meta.url));
const supervisorHost = fileURLToPath(new URL("./test-fixtures/supervisor-host.ts", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-memory-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface FakeOptions {
  mode?: "normal" | "crash-on-boot" | "slow-boot" | "crash-once-after-ready";
  port?: number;
  allowPortFallback?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
  hookTarget?: ProcessHookTarget;
  installExitHooks?: boolean;
  handleSignals?: boolean;
  launchEnv?: Record<string, string>;
}

async function fakeSupervisor(options: FakeOptions = {}) {
  const dataDir = await tempDir();
  const pidFile = join(dataDir, "pids.json");
  const envFile = join(dataDir, "env.json");
  const supervisor = new HindsightSupervisor({
    launch: {
      command: process.execPath,
      args: [fakeEngine],
      env: {
        FAKE_ENGINE_PID_FILE: pidFile,
        FAKE_ENGINE_ENV_FILE: envFile,
        FAKE_ENGINE_MODE: options.mode ?? "normal",
        FAKE_ENGINE_CRASH_MARKER: join(dataDir, "crashed"),
        ...options.launchEnv,
      },
    },
    dataDir,
    settings: parseMemorySettings({ enabled: true, port: options.port ?? 18_990 }),
    allowPortFallback: options.allowPortFallback ?? true,
    baseEnv: options.baseEnv ?? process.env,
    readyTimeoutMs: 15_000,
    stopTimeoutMs: 5_000,
    installExitHooks: options.installExitHooks ?? false,
    ...(options.handleSignals === undefined ? {} : { handleSignals: options.handleSignals }),
    hookTarget: options.hookTarget,
  });
  cleanups.push(() => supervisor.stop());
  const pids = async () => JSON.parse(await readFile(pidFile, "utf8")) as { engine: number; grandchild: number };
  const childEnv = async () => JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
  return { supervisor, dataDir, pids, childEnv };
}

async function occupy(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return server;
}

class FakeHookTarget extends EventEmitter implements ProcessHookTarget {
  readonly pid = 424242;
  readonly killed: NodeJS.Signals[] = [];
  kill(_pid: number, signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }
}

describe("HindsightSupervisor", () => {
  test("binds the engine to 127.0.0.1 and resolves only once it is healthy", async () => {
    const { supervisor, childEnv } = await fakeSupervisor({ mode: "slow-boot" });
    const endpoint = await supervisor.start();
    expect(endpoint.baseUrl).toBe(`http://127.0.0.1:${endpoint.port}`);
    expect(supervisor.status().state).toBe("ready");
    const env = await childEnv();
    expect(env.HINDSIGHT_API_HOST).toBe("127.0.0.1");
    expect(env.HINDSIGHT_API_PORT).toBe(String(endpoint.port));
    expect(await new HindsightMemoryClient(endpoint).listBanks()).toEqual([]);
  });

  test("guards the API with a per-launch bearer token", async () => {
    const { supervisor } = await fakeSupervisor();
    const endpoint = await supervisor.start();
    expect(endpoint.token.length).toBeGreaterThanOrEqual(40);
    const response = await fetch(`${endpoint.baseUrl}/v1/default/banks`);
    expect(response.status).toBe(401);
    const wrong = new HindsightMemoryClient({ baseUrl: endpoint.baseUrl, token: "not-the-token" });
    await expect(wrong.listBanks()).rejects.toThrow("401");
  });

  test("keeps every telemetry opt-out even when the launch command asks otherwise", async () => {
    const { supervisor, childEnv } = await fakeSupervisor({
      launchEnv: { ENABLE_TELEMETRY: "true", DO_NOT_TRACK: "0", HINDSIGHT_API_OTEL_TRACES_ENABLED: "true" },
    });
    await supervisor.start();
    const env = await childEnv();
    expect(env.ENABLE_TELEMETRY).toBe("false");
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(env.HINDSIGHT_API_OTEL_TRACES_ENABLED).toBe("false");
  });

  test("builds the child environment from an allowlist, never the ambient environment", async () => {
    const { supervisor, childEnv, dataDir } = await fakeSupervisor({
      baseEnv: {
        PATH: process.env.PATH,
        AWS_SECRET_ACCESS_KEY: "ambient-secret",
        OPENAI_API_KEY: "ambient-openai-key",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
        HINDSIGHT_API_HOST: "0.0.0.0",
        HINDSIGHT_API_DATABASE_URL: "postgresql://remote.example.com/db",
      },
    });
    await supervisor.start();
    const env = await childEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.OTEL_SDK_DISABLED).toBe("true");
    expect(env.ENABLE_TELEMETRY).toBe("false");
    expect(env.HINDSIGHT_API_OTEL_TRACES_ENABLED).toBe("false");
    expect(env.LITELLM_LOCAL_MODEL_COST_MAP).toBe("True");
    expect(env.HINDSIGHT_API_HOST).toBe("127.0.0.1");
    // Never pg0's well-known default login, and never a socket in /tmp.
    const password = (await readFile(join(dataDir, "database-password"), "utf8")).trim();
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.HINDSIGHT_API_DATABASE_URL).toBe(HindsightSupervisor.embeddedDatabaseUrl(password, join(dataDir, "run")));
    const databaseUrl = new URL(String(env.HINDSIGHT_API_DATABASE_URL).replace(/^pg0:/, "http:"));
    expect(databaseUrl.username).toBe("hindsight");
    expect(databaseUrl.password).not.toBe("hindsight");
    expect(databaseUrl.searchParams.get("unix_socket_directories")).toBe(join(dataDir, "run"));
    expect(databaseUrl.searchParams.get("unix_socket_permissions")).toBe("0700");
    expect(env.HARNESS_MEMORY_PG_DATA_DIR).toBe(join(dataDir, "postgres"));
    expect(env.HOME).toBe(join(dataDir, "home"));
    expect(env.HARNESS_MEMORY_EGRESS_ALLOW).toBe("");
    expect(env.HINDSIGHT_API_LLM_BASE_URL).toBe("http://127.0.0.1:11434/v1");
  });

  test("keeps one private database password per install, readable only by this user", async () => {
    const { supervisor, dataDir, childEnv } = await fakeSupervisor();
    await supervisor.start();
    const first = (await childEnv()).HINDSIGHT_API_DATABASE_URL;
    await supervisor.stop();
    await supervisor.start();
    expect((await childEnv()).HINDSIGHT_API_DATABASE_URL).toBe(first);
    if (process.platform !== "win32") {
      expect((await stat(join(dataDir, "database-password"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dataDir, "run"))).mode & 0o777).toBe(0o700);
      expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    }
    // Never echoed into logs.
    const password = (await readFile(join(dataDir, "database-password"), "utf8")).trim();
    expect(JSON.stringify(supervisor.status())).not.toContain(password);
  });

  test("stop() terminates the engine's whole process tree", async () => {
    const { supervisor, pids } = await fakeSupervisor();
    await supervisor.start();
    const { engine, grandchild } = await pids();
    expect(isProcessAlive(engine)).toBe(true);
    expect(isProcessAlive(grandchild)).toBe(true);
    await supervisor.stop();
    expect(await waitForExit(engine, 5_000)).toBe(true);
    expect(await waitForExit(grandchild, 5_000)).toBe(true);
    expect(supervisor.status().state).toBe("stopped");
  });

  test("falls back to a free loopback port when the configured one is taken", async () => {
    await occupy(18_991);
    const { supervisor } = await fakeSupervisor({ port: 18_991 });
    const endpoint = await supervisor.start();
    expect(endpoint.port).not.toBe(18_991);
    expect(endpoint.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("refuses a taken port when fallback is disabled", async () => {
    await occupy(18_992);
    const { supervisor } = await fakeSupervisor({ port: 18_992, allowPortFallback: false });
    await expect(supervisor.start()).rejects.toThrow("already in use");
    expect(supervisor.status().state).toBe("failed");
  });

  test("reports the engine's own error output when it dies during boot", async () => {
    const { supervisor } = await fakeSupervisor({ mode: "crash-on-boot" });
    await expect(supervisor.start()).rejects.toThrow("could not initialise the database");
    expect(supervisor.status().state).toBe("failed");
    expect(supervisor.status().lastError).toContain("code 7");
  });

  test("exit hooks signal the engine tree and keep default signal semantics", async () => {
    const target = new FakeHookTarget();
    const { supervisor, pids } = await fakeSupervisor({ installExitHooks: true, hookTarget: target });
    await supervisor.start();
    expect(target.listenerCount("SIGINT")).toBe(1);
    expect(target.listenerCount("SIGTERM")).toBe(1);
    expect(target.listenerCount("beforeExit")).toBe(1);
    expect(target.listenerCount("exit")).toBe(1);
    const { engine, grandchild } = await pids();
    target.emit("SIGINT", "SIGINT");
    expect(await waitForExit(engine, 5_000)).toBe(true);
    expect(await waitForExit(grandchild, 5_000)).toBe(true);
    // It was the only SIGINT listener, so it re-raised to preserve Node's exit.
    expect(target.killed).toEqual(["SIGINT"]);
    expect(target.listenerCount("SIGINT")).toBe(0);
  });

  test("a host that owns its signals keeps them: only the exit backstop is installed", async () => {
    const target = new FakeHookTarget();
    const { supervisor, pids } = await fakeSupervisor({ installExitHooks: true, handleSignals: false, hookTarget: target });
    await supervisor.start();
    // Electron quits gracefully on SIGTERM only while Node has no listener.
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
    expect(target.listenerCount("beforeExit")).toBe(1);
    expect(target.listenerCount("exit")).toBe(1);
    const { engine } = await pids();
    target.emit("exit", 0);
    expect(await waitForExit(engine, 5_000)).toBe(true);
    expect(target.killed).toEqual([]);
  });

  test("the process 'exit' hook stops the engine synchronously", async () => {
    const target = new FakeHookTarget();
    const { supervisor, pids } = await fakeSupervisor({ installExitHooks: true, hookTarget: target });
    await supervisor.start();
    const { engine } = await pids();
    target.emit("exit", 0);
    expect(await waitForExit(engine, 5_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(supervisor.status().state).toBe("stopped");
    expect(target.listenerCount("exit")).toBe(0);
  });

  test("restarts an engine that crashes after becoming ready", async () => {
    const { supervisor, pids } = await fakeSupervisor({ mode: "crash-once-after-ready" });
    await supervisor.start();
    const first = (await pids()).engine;
    expect(await waitForExit(first, 5_000)).toBe(true);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(supervisor.status().state === "ready" && supervisor.status().pid !== first)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(supervisor.status().state).toBe("ready");
    expect(supervisor.status().restarts).toBe(1);
    expect((await pids()).engine).not.toBe(first);
  }, 20_000);

  test("the engine does not outlive a supervisor that is SIGKILLed", async () => {
    if (process.platform === "win32") return;
    const dataDir = await tempDir();
    const pidFile = join(dataDir, "pids.json");
    const host = spawn(process.execPath, [supervisorHost, dataDir, pidFile], { stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(() => {
      if (host.exitCode === null) host.kill("SIGKILL");
    });
    await new Promise<void>((resolve, reject) => {
      host.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes('"ready":true')) resolve();
      });
      host.once("exit", (code) => reject(new Error(`host exited early with ${code}`)));
    });
    const { engine, grandchild } = JSON.parse(await readFile(pidFile, "utf8")) as { engine: number; grandchild: number };
    host.kill("SIGKILL");
    expect(await waitForExit(engine, 10_000)).toBe(true);
    expect(await waitForExit(grandchild, 10_000)).toBe(true);
  }, 30_000);
});
