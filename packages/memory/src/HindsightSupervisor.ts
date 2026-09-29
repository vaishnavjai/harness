import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HindsightMemoryClient, type HindsightEndpointRef } from "./hindsight-client.js";
import { findFreeLoopbackPort, isLoopbackPortFree, LOOPBACK_HOST } from "./loopback-port.js";
import {
  buildModelEnvironment,
  memoryEgressHosts,
  type HarnessMemorySettings,
  type MemorySecrets,
} from "./memory-settings.js";
import { reapEmbeddedPostgres, signalProcessTree, type TreeSignal } from "./process-tree.js";

/**
 * Runs the vendored Hindsight engine as a supervised child of Harness.
 *
 * - Binds 127.0.0.1 only (the launcher refuses anything else) and guards the
 *   REST API with a random per-launch bearer token, so other local programs
 *   and web pages cannot read the memory store.
 * - The embedded Postgres uses a random per-install password (0600 file in
 *   the data directory) instead of pg0's well-known default. On macOS and
 *   Linux the launcher runs that server itself: no TCP listener, only a Unix
 *   socket in a 0700 folder in the data directory, and the password never on
 *   any command line (other accounts can read those). Another OS account has
 *   no way to reach the database, even with the password. On Windows pg0 still
 *   serves on 127.0.0.1, where only the password guards it.
 * - The child leads its own process group (POSIX), so stop() and the exit
 *   hooks signal every descendant; the embedded Postgres, which pg_ctl
 *   daemonizes out of that group, is reaped from its postmaster.pid.
 * - The child's stdin is a pipe only this process holds. If Harness dies in
 *   a way no hook can observe (SIGKILL, crash), the pipe closes and the
 *   launcher shuts the engine down itself: no orphans either way.
 * - The child environment is built from an allowlist, never the ambient
 *   environment, and pins all engine state under `dataDir`.
 * - Migrations run inside the engine before /health turns ready; start()
 *   resolves only then, so callers never send a turn to an unmigrated store.
 */

export interface HindsightLaunchCommand {
  /** Interpreter to run: the bundled Python or a development venv. */
  command: string;
  /** Arguments, normally just the launcher script path. */
  args: string[];
  /** Runtime-specific environment, e.g. PYTHONHOME for a relocatable Python. */
  env?: Record<string, string>;
}

export interface MemoryLogger {
  info(message: string): void;
  warn(message: string): void;
}

export type HindsightSupervisorState = "stopped" | "starting" | "ready" | "stopping" | "failed";

export interface HindsightEndpoint extends HindsightEndpointRef {
  port: number;
  pid: number;
}

export interface HindsightSupervisorStatus {
  state: HindsightSupervisorState;
  pid: number | null;
  baseUrl: string | null;
  port: number | null;
  startedAt: string | null;
  lastError: string | null;
  dataDir: string;
  restarts: number;
  recentLogs: string[];
}

/** The subset of `process` the exit hooks need; injectable for tests. */
export interface ProcessHookTarget {
  pid: number;
  on(event: "SIGINT" | "SIGTERM" | "beforeExit" | "exit", listener: (...args: unknown[]) => void): unknown;
  off(event: "SIGINT" | "SIGTERM" | "beforeExit" | "exit", listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: "SIGINT" | "SIGTERM"): number;
  kill(pid: number, signal: NodeJS.Signals): unknown;
}

export interface HindsightSupervisorOptions {
  launch: HindsightLaunchCommand;
  /** Root for all engine state, e.g. ~/.config/harness/data/hindsight. */
  dataDir: string;
  settings: HarnessMemorySettings;
  secrets?: MemorySecrets;
  /** Use a free ephemeral port when the configured one is taken. Default true. */
  allowPortFallback?: boolean;
  /** First boot initialises Postgres and runs migrations. Default 180s. */
  readyTimeoutMs?: number;
  /** Grace period for the engine to stop its database. Default 15s. */
  stopTimeoutMs?: number;
  /** Restarts after an unexpected exit while ready. Default 3. */
  maxRestarts?: number;
  logger?: MemoryLogger;
  /** Install SIGINT/SIGTERM/beforeExit/exit hooks on `hookTarget`. Default true. */
  installExitHooks?: boolean;
  /**
   * Also handle SIGINT/SIGTERM (stop the engine, then re-raise). Default true.
   * A host with its own shutdown sequence, such as Electron, sets false: a Node
   * signal listener replaces Electron's graceful quit, so the host stops the
   * supervisor itself and only the synchronous `exit` hook stays as a backstop.
   */
  handleSignals?: boolean;
  hookTarget?: ProcessHookTarget;
  /** Source for the allowlisted passthrough variables. Default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Ambient variables the interpreter legitimately needs. Nothing else passes. */
const PASSTHROUGH_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LOGNAME",
  "USERNAME",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
] as const;

/**
 * Opt-outs for every library in the engine that could otherwise phone home.
 * Applied after the launch command's env, so no caller can turn one back on.
 */
const NO_PHONE_HOME_ENV: Readonly<Record<string, string>> = {
  ENABLE_TELEMETRY: "false",
  DO_NOT_TRACK: "1",
  HINDSIGHT_API_OTEL_TRACES_ENABLED: "false",
  OTEL_SDK_DISABLED: "true",
  OTEL_TRACES_EXPORTER: "none",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_LOGS_EXPORTER: "none",
  HF_HUB_OFFLINE: "1",
  HF_HUB_DISABLE_TELEMETRY: "1",
  TRANSFORMERS_OFFLINE: "1",
  // litellm otherwise downloads its model price map from GitHub at import.
  LITELLM_LOCAL_MODEL_COST_MAP: "True",
  LITELLM_TELEMETRY: "False",
  ANONYMIZED_TELEMETRY: "False",
};

const RECENT_LOG_LINES = 200;
const EMBEDDED_DATABASE_INSTANCE = "harness-memory";
const EMBEDDED_DATABASE_USER = "hindsight";
const DATABASE_PASSWORD_FILE = "database-password";
const DATABASE_SOCKET_DIR = "run";

/**
 * Whether the engine and its stdio pipes keep the host's event loop alive.
 * A ready engine is a background service: holding the loop would mean Node
 * never emits `beforeExit`, so a host that simply finishes would keep the
 * engine running forever. Every stop holds the loop again until it is done.
 */
function holdEventLoop(child: ChildProcess, hold: boolean): void {
  if (hold) child.ref();
  else child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!hasLoopRef(stream)) continue;
    if (hold) stream.ref();
    else stream.unref();
  }
}

/** Node's stdio pipes are sockets; Bun's are plain streams with the same ref()/unref(). */
function hasLoopRef(stream: unknown): stream is { ref(): unknown; unref(): unknown } {
  return typeof stream === "object" && stream !== null
    && "ref" in stream && typeof stream.ref === "function"
    && "unref" in stream && typeof stream.unref === "function";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HindsightSupervisor {
  static readonly HOST = LOOPBACK_HOST;

  private readonly options: Required<
    Pick<HindsightSupervisorOptions, "allowPortFallback" | "readyTimeoutMs" | "stopTimeoutMs" | "maxRestarts" | "installExitHooks" | "handleSignals">
  > &
    HindsightSupervisorOptions;
  private readonly platform: NodeJS.Platform;
  private readonly hookTarget: ProcessHookTarget | null;
  private child: ChildProcess | null = null;
  private endpoint: HindsightEndpoint | null = null;
  private state: HindsightSupervisorState = "stopped";
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private restarts = 0;
  private starting: Promise<HindsightEndpoint> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly recentLogs: string[] = [];
  private readonly redactions = new Set<string>();
  private readonly listeners = new Set<(status: HindsightSupervisorStatus) => void>();
  private hooksInstalled = false;
  private readonly onSignal = (signal: unknown) => this.handleSignal(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
  private readonly onBeforeExit = () => {
    // The host has nothing left to do. shutdown() holds the loop open until
    // the engine is gone; the next beforeExit finds no hook and Node exits.
    void this.stop();
  };
  private readonly onExit = () => this.terminateNow("SIGTERM");

  constructor(options: HindsightSupervisorOptions) {
    this.options = {
      allowPortFallback: true,
      readyTimeoutMs: 180_000,
      stopTimeoutMs: 15_000,
      maxRestarts: 3,
      installExitHooks: true,
      handleSignals: true,
      ...options,
    };
    this.platform = options.platform ?? process.platform;
    this.hookTarget = this.options.installExitHooks ? (options.hookTarget ?? process) : null;
    for (const secret of [options.secrets?.llmApiKey, options.secrets?.embeddingsApiKey]) {
      if (secret && secret.length >= 6) this.redactions.add(secret);
    }
  }

  get dataDir(): string {
    return this.options.dataDir;
  }

  get pgDataDir(): string {
    return join(this.options.dataDir, "postgres");
  }

  status(): HindsightSupervisorStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      baseUrl: this.endpoint?.baseUrl ?? null,
      port: this.endpoint?.port ?? null,
      startedAt: this.startedAt,
      lastError: this.lastError,
      dataDir: this.options.dataDir,
      restarts: this.restarts,
      recentLogs: [...this.recentLogs],
    };
  }

  onStatusChange(listener: (status: HindsightSupervisorStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A REST client for the running engine; throws unless ready. */
  client(): HindsightMemoryClient {
    if (this.state !== "ready" || !this.endpoint) throw new Error("The memory engine is not running.");
    return new HindsightMemoryClient(this.endpoint);
  }

  /** Start the engine (idempotent) and resolve once it is migrated and healthy. */
  start(): Promise<HindsightEndpoint> {
    if (this.state === "ready" && this.endpoint) return Promise.resolve(this.endpoint);
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Stop the engine and everything it started. Never throws. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.shutdown().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private setState(state: HindsightSupervisorState, error?: string): void {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    const snapshot = this.status();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A faulty listener must not break supervision.
      }
    }
  }

  private redact(line: string): string {
    let result = line;
    for (const secret of this.redactions) result = result.split(secret).join("[redacted]");
    return result;
  }

  private record(stream: "stdout" | "stderr", chunk: Buffer): void {
    for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const line = this.redact(raw);
      this.recentLogs.push(line);
      if (this.recentLogs.length > RECENT_LOG_LINES) this.recentLogs.shift();
      if (stream === "stderr") this.options.logger?.warn(`[hindsight] ${line}`);
      else this.options.logger?.info(`[hindsight] ${line}`);
    }
  }

  private async choosePort(): Promise<number> {
    const preferred = this.options.settings.port;
    if (await isLoopbackPortFree(preferred)) return preferred;
    if (!this.options.allowPortFallback) {
      throw new Error(`127.0.0.1:${preferred} is already in use.`);
    }
    const fallback = await findFreeLoopbackPort();
    this.options.logger?.warn(`[hindsight] 127.0.0.1:${preferred} is in use; using ${fallback}`);
    return fallback;
  }

  /** Per-install database password, created once; only this OS user can read it. */
  private async databasePassword(): Promise<string> {
    const file = join(this.options.dataDir, DATABASE_PASSWORD_FILE);
    const read = async () => {
      const value = (await readFile(file, "utf8")).trim();
      if (!/^[A-Za-z0-9_-]{32,}$/.test(value)) throw new Error(`${file} does not hold a valid database password.`);
      return value;
    };
    try {
      return await read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const value = randomBytes(32).toString("base64url");
    try {
      await writeFile(file, `${value}\n`, { mode: 0o600, flag: "wx" });
      await chmod(file, 0o600).catch(() => undefined);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return read();
      throw error;
    }
  }

  /**
   * The pg0 URL: private credentials, and a Unix socket only this OS user can
   * reach. Windows serves on 127.0.0.1 instead and nothing connects over a
   * socket there, but Postgres would still refuse to start when the socket path
   * exceeds 107 bytes (a long profile path), so no socket is requested.
   */
  static embeddedDatabaseUrl(password: string, socketDir: string, platform: NodeJS.Platform = process.platform): string {
    const base = `pg0://${EMBEDDED_DATABASE_USER}:${password}@${EMBEDDED_DATABASE_INSTANCE}`;
    if (platform === "win32") return base;
    const settings = new URLSearchParams({ unix_socket_directories: socketDir, unix_socket_permissions: "0700" });
    return `${base}?${settings.toString()}`;
  }

  private buildEnvironment(port: number, token: string, databasePassword: string): NodeJS.ProcessEnv {
    const base = this.options.baseEnv ?? process.env;
    const env: NodeJS.ProcessEnv = {};
    for (const name of PASSTHROUGH_ENV) {
      const value = base[name];
      if (value !== undefined) env[name] = value;
    }
    const engineHome = join(this.options.dataDir, "home");
    Object.assign(env, this.options.launch.env ?? {}, NO_PHONE_HOME_ENV, {
      // Everything the engine writes under "~" (pg0's Postgres install,
      // caches) stays inside the Harness data directory.
      HOME: engineHome,
      USERPROFILE: engineHome,
      XDG_CACHE_HOME: join(engineHome, ".cache"),
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONSAFEPATH: "1",
      HINDSIGHT_API_HOST: LOOPBACK_HOST,
      HINDSIGHT_API_PORT: String(port),
      HINDSIGHT_API_LOG_LEVEL: "info",
      HINDSIGHT_API_DATABASE_URL: HindsightSupervisor.embeddedDatabaseUrl(databasePassword, join(this.options.dataDir, DATABASE_SOCKET_DIR), this.platform),
      HINDSIGHT_API_TENANT_EXTENSION: "hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension",
      HINDSIGHT_API_TENANT_API_KEY: token,
      HARNESS_MEMORY_PG_DATA_DIR: this.pgDataDir,
      HARNESS_MEMORY_EGRESS_ALLOW: memoryEgressHosts(this.options.settings).join(","),
      HARNESS_MEMORY_PARENT_WATCH: "stdin,ppid",
      ...buildModelEnvironment(this.options.settings, this.options.secrets ?? {}),
    });
    return env;
  }

  private async launch(): Promise<HindsightEndpoint> {
    if (this.stopping) await this.stopping;
    this.setState("starting");
    try {
      await mkdir(join(this.options.dataDir, "home"), { recursive: true, mode: 0o700 });
      if (this.platform !== "win32") await chmod(this.options.dataDir, 0o700);
      await mkdir(join(this.options.dataDir, DATABASE_SOCKET_DIR), { recursive: true, mode: 0o700 });
      await chmod(join(this.options.dataDir, DATABASE_SOCKET_DIR), 0o700).catch(() => undefined);
      const databasePassword = await this.databasePassword();
      this.redactions.add(databasePassword);
      // A previous run that died hard may have left its postmaster behind.
      if (await reapEmbeddedPostgres(this.pgDataDir, this.platform)) {
        this.options.logger?.warn("[hindsight] stopped a stale embedded Postgres from a previous run");
      }
      const port = await this.choosePort();
      const token = randomBytes(32).toString("base64url");
      this.redactions.add(token);
      const env = this.buildEnvironment(port, token, databasePassword);

      const child = spawn(this.options.launch.command, this.options.launch.args, {
        cwd: join(this.options.dataDir, "home"),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group on POSIX so the whole tree can be signalled.
        detached: this.platform !== "win32",
        windowsHide: true,
        shell: false,
      });
      this.child = child;
      child.stdout?.on("data", (chunk: Buffer) => this.record("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => this.record("stderr", chunk));
      // EPIPE when the engine exits first is expected; never crash the host.
      child.stdin?.on("error", () => undefined);
      this.installHooks();

      const pid = await new Promise<number>((resolve, reject) => {
        child.once("spawn", () => resolve(child.pid ?? 0));
        child.once("error", reject);
      });
      const endpoint: HindsightEndpoint = { baseUrl: `http://${LOOPBACK_HOST}:${port}`, token, port, pid };
      child.once("exit", (code, signal) => this.handleExit(child, code, signal));

      await this.waitUntilReady(child, endpoint);
      holdEventLoop(child, false);
      this.endpoint = endpoint;
      this.startedAt = new Date().toISOString();
      this.setState("ready", "");
      this.options.logger?.info(`[hindsight] ready at ${endpoint.baseUrl} (pid ${pid})`);
      return endpoint;
    } catch (error) {
      const message = describe(error);
      await this.shutdown();
      this.setState("failed", message);
      throw new Error(`The memory engine failed to start: ${message}`, { cause: error });
    }
  }

  private async waitUntilReady(child: ChildProcess, endpoint: HindsightEndpoint): Promise<void> {
    const client = new HindsightMemoryClient(endpoint, { timeoutMs: 10_000 });
    const deadline = Date.now() + this.options.readyTimeoutMs;
    let exited: string | null = null;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exited = `exited with ${signal ?? `code ${code}`}`;
    };
    child.once("exit", onExit);
    try {
      while (Date.now() < deadline) {
        if (exited) throw new Error(`the engine ${exited} before becoming ready${this.logTail()}`);
        // /health turns 200 only after migrations ran and the database answers.
        if (await client.health()) {
          await client.listBanks(); // proves the bearer token is enforced and accepted
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        `the engine did not become ready within ${Math.round(this.options.readyTimeoutMs / 1000)}s${this.logTail() || " (the engine printed no output)"}`,
      );
    } finally {
      child.off("exit", onExit);
    }
  }

  /** The engine's latest output, ready to append to an error; empty when it printed nothing. */
  private logTail(): string {
    const tail = this.recentLogs.slice(-8).join("\n");
    return tail ? `:\n${tail}` : "";
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.endpoint = null;
    if (this.state === "stopping" && !this.stopping) {
      // Stopped by an exit hook rather than stop(): finish the bookkeeping.
      this.removeHooks();
      this.setState("stopped");
      return;
    }
    if (this.state !== "ready") return; // start()/stop() own the other transitions
    const reason = `exited unexpectedly (${signal ?? `code ${code}`})`;
    this.options.logger?.warn(`[hindsight] ${reason}`);
    this.setState("failed", reason);
    if (this.restarts >= this.options.maxRestarts) return;
    this.restarts += 1;
    const delay = 1_000 * 2 ** (this.restarts - 1);
    setTimeout(() => {
      if (this.state === "failed" && !this.stopping) void this.start().catch(() => undefined);
    }, delay).unref();
  }

  private async shutdown(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      this.setState("stopping");
      holdEventLoop(child, true);
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      // Closing stdin alone makes the launcher stop gracefully; the group
      // SIGTERM is the POSIX fast path. Windows has no SIGTERM for console
      // children, so it relies on the pipe and then force-kills.
      child.stdin?.end();
      if (this.platform !== "win32") this.signalTree(child, "SIGTERM");
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.options.stopTimeoutMs).unref()),
      ]);
      if (!graceful) {
        this.options.logger?.warn("[hindsight] engine did not stop in time; killing its process tree");
        this.signalTree(child, "SIGKILL");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000).unref())]);
      }
    }
    this.child = null;
    this.endpoint = null;
    try {
      await reapEmbeddedPostgres(this.pgDataDir, this.platform);
    } catch (error) {
      this.options.logger?.warn(`[hindsight] could not verify the embedded Postgres stopped: ${describe(error)}`);
    }
    this.removeHooks();
    if (this.state !== "failed") this.setState("stopped");
  }

  private signalTree(child: ChildProcess, signal: TreeSignal): void {
    if (child.pid) signalProcessTree(child.pid, signal, this.platform);
  }

  /** Synchronous last-resort signal used from process exit paths. */
  private terminateNow(signal: TreeSignal): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // The host is going away: the coming exit is intentional, not a crash to
    // restart from.
    this.setState("stopping");
    child.stdin?.end();
    this.signalTree(child, signal);
  }

  private handleSignal(signal: "SIGINT" | "SIGTERM"): void {
    this.terminateNow("SIGTERM");
    const target = this.hookTarget;
    // A listener disables Node's default "exit on signal"; when Harness has no
    // handler of its own, restore that default by re-raising.
    if (target && target.listenerCount(signal) === 1) {
      this.removeHooks();
      target.kill(target.pid, signal);
    }
  }

  private installHooks(): void {
    const target = this.hookTarget;
    if (!target || this.hooksInstalled) return;
    if (this.options.handleSignals) {
      target.on("SIGINT", this.onSignal);
      target.on("SIGTERM", this.onSignal);
    }
    target.on("beforeExit", this.onBeforeExit);
    target.on("exit", this.onExit);
    this.hooksInstalled = true;
  }

  private removeHooks(): void {
    const target = this.hookTarget;
    if (!target || !this.hooksInstalled) return;
    if (this.options.handleSignals) {
      target.off("SIGINT", this.onSignal);
      target.off("SIGTERM", this.onSignal);
    }
    target.off("beforeExit", this.onBeforeExit);
    target.off("exit", this.onExit);
    this.hooksInstalled = false;
  }
}
