import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_MEMORY_SETTINGS,
  HindsightSupervisor,
  isLocalProvider,
  memoryEgressHosts,
  parseMemorySettings,
  providerRequiresApiKey,
  resolveEmbeddingsBaseUrl,
  resolveHindsightRuntime,
  resolveLlmBaseUrl,
} from "@harness/memory";

/**
 * Owns the embedded Hindsight memory engine for the desktop app: its
 * settings (~/.config/harness/memory.json, no secrets), its API keys (the
 * encrypted secret store), and the supervised engine process. Memory is off
 * until the user turns it on in Settings.
 */

/**
 * What the service needs from a supervisor; HindsightSupervisor implements it.
 * @typedef {{
 *   start(): Promise<unknown>,
 *   stop(): Promise<void>,
 *   status(): import("@harness/memory").HindsightSupervisorStatus,
 *   client(): Pick<import("@harness/memory").HindsightMemoryClient, "ensureBank" | "recall" | "retain" | "listMemories">,
 * }} MemoryEngineSupervisor
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

export const MEMORY_SECRET_NAMES = Object.freeze({
  llm: "memory.llm.api-key",
  embeddings: "memory.embeddings.api-key",
});

/**
 * @param {{
 *   settingsPath: string,
 *   dataDir: string,
 *   secretStore: { get(name: string): Promise<string | null>, set(name: string, value: string): Promise<void>, delete(name: string): Promise<void>, has(name: string): Promise<boolean> },
 *   runtimeOptions: import("@harness/memory").ResolveHindsightRuntimeOptions,
 *   audit?: { event(kind: string, detail?: Record<string, string | number | boolean | null>): void },
 *   logger?: import("@harness/memory").MemoryLogger,
 *   supervisorFactory?: (options: import("@harness/memory").HindsightSupervisorOptions) => MemoryEngineSupervisor,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createMemoryService({
  settingsPath,
  dataDir,
  secretStore,
  runtimeOptions,
  audit,
  logger,
  supervisorFactory = (options) => new HindsightSupervisor(options),
  fetchImpl = (input, init) => fetch(input, init),
}) {
  /** @type {MemoryEngineSupervisor | null} */
  let supervisor = null;
  /** @type {string | null} */
  let lastError = null;
  /** @type {Promise<unknown>} */
  let transition = Promise.resolve();

  async function readSettings() {
    try {
      return parseMemorySettings(JSON.parse(await readFile(settingsPath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") logger?.warn(`[memory] ignoring unreadable settings: ${error?.message ?? error}`);
      return DEFAULT_MEMORY_SETTINGS;
    }
  }

  /** @param {import("@harness/memory").HarnessMemorySettings} settings */
  async function writeSettings(settings) {
    await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    const temporary = `${settingsPath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, settingsPath);
      await chmod(settingsPath, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  function runtimeAvailable() {
    return resolveHindsightRuntime(runtimeOptions) !== null;
  }

  function serialize(work) {
    const next = transition.then(work, work);
    transition = next.catch(() => undefined);
    return next;
  }

  async function stopEngine() {
    if (!supervisor) return;
    const current = supervisor;
    supervisor = null;
    await current.stop();
    audit?.event("memory.engine.stopped", {});
  }

  async function startEngine() {
    const settings = await readSettings();
    await stopEngine();
    if (!settings.enabled) return;
    const runtime = resolveHindsightRuntime(runtimeOptions);
    if (!runtime) {
      throw new Error(
        "The memory engine runtime is not installed. Build Harness with `npm run package`, or run `node scripts/hindsight/prepare-runtime.mjs --dev` for development.",
      );
    }
    const secrets = {
      llmApiKey: (await secretStore.get(MEMORY_SECRET_NAMES.llm)) ?? undefined,
      embeddingsApiKey: (await secretStore.get(MEMORY_SECRET_NAMES.embeddings)) ?? undefined,
    };
    if (providerRequiresApiKey(settings.llm.provider) && !secrets.llmApiKey) {
      throw new Error(`Add an API key for ${settings.llm.provider} in Settings > Memory before turning memory on.`);
    }
    const next = supervisorFactory({
      launch: runtime.launch,
      dataDir,
      settings,
      secrets,
      logger,
      installExitHooks: true,
    });
    supervisor = next;
    await next.start();
    await next.client().ensureBank(settings.bankId);
    audit?.event("memory.engine.started", {
      runtime: runtime.source,
      provider: settings.llm.provider,
      port: next.status().port,
      egress: memoryEgressHosts(settings).join(",") || "loopback-only",
    });
  }

  /** @returns {Promise<import("@harness/types/desktop-ipc").HarnessMemoryStatus>} */
  async function status() {
    const settings = await readSettings();
    const engine = supervisor?.status() ?? null;
    return {
      settings,
      engine: engine
        ? { state: engine.state, pid: engine.pid, baseUrl: engine.baseUrl, port: engine.port, startedAt: engine.startedAt, lastError: engine.lastError, restarts: engine.restarts, recentLogs: engine.recentLogs.slice(-40) }
        : { state: /** @type {const} */ ("stopped"), pid: null, baseUrl: null, port: null, startedAt: null, lastError, restarts: 0, recentLogs: [] },
      runtimeAvailable: runtimeAvailable(),
      dataDir,
      apiKeys: {
        llm: await secretStore.has(MEMORY_SECRET_NAMES.llm).catch(() => false),
        embeddings: await secretStore.has(MEMORY_SECRET_NAMES.embeddings).catch(() => false),
      },
      egressHosts: memoryEgressHosts(settings),
      llmBaseUrl: resolveLlmBaseUrl(settings),
      embeddingsBaseUrl: resolveEmbeddingsBaseUrl(settings),
    };
  }

  function client() {
    if (!supervisor || supervisor.status().state !== "ready") {
      throw new Error("Memory is not running. Turn it on in Settings > Memory.");
    }
    return supervisor.client();
  }

  async function withRecordedError(work) {
    try {
      const result = await work();
      lastError = null;
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  return {
    status,
    /** Start at app launch when memory is enabled; failures are reported, not thrown. */
    async startIfEnabled() {
      const settings = await readSettings();
      if (!settings.enabled) return status();
      await serialize(() => withRecordedError(startEngine)).catch((error) => {
        logger?.warn(`[memory] could not start: ${error?.message ?? error}`);
      });
      return status();
    },
    async start() {
      await serialize(async () => {
        const settings = await readSettings();
        if (!settings.enabled) await writeSettings({ ...settings, enabled: true });
        await withRecordedError(startEngine);
      });
      return status();
    },
    async stop() {
      await serialize(async () => {
        const settings = await readSettings();
        if (settings.enabled) await writeSettings({ ...settings, enabled: false });
        await stopEngine();
      });
      return status();
    },
    /** Stop the engine for app quit without changing the saved preference. */
    shutdown() {
      return serialize(stopEngine);
    },
    /** @param {unknown} patch */
    async updateSettings(patch) {
      await serialize(async () => {
        const current = await readSettings();
        const input = asRecord(patch);
        const merged = parseMemorySettings({
          ...current,
          ...input,
          llm: { ...current.llm, ...asRecord(input.llm) },
          embeddings: { ...current.embeddings, ...asRecord(input.embeddings) },
        });
        await writeSettings(merged);
        if (supervisor || merged.enabled) await withRecordedError(startEngine);
      });
      return status();
    },
    /** @param {{ kind: "llm" | "embeddings", value: string | null }} input */
    async setApiKey(input) {
      const name = MEMORY_SECRET_NAMES[input?.kind];
      if (!name) throw new Error("Unknown API key kind.");
      await serialize(async () => {
        if (input.value) await secretStore.set(name, input.value.trim());
        else await secretStore.delete(name);
        if (supervisor) await withRecordedError(startEngine);
      });
      return status();
    },
    /** @param {{ query: string, maxTokens?: number }} input */
    async recall(input) {
      const settings = await readSettings();
      const query = String(input?.query ?? "").trim();
      if (!query) return [];
      return client().recall(settings.bankId, query.slice(0, 2_000), { maxTokens: input?.maxTokens ?? 2_048 });
    },
    /** @param {{ content: string, context?: string }} input */
    async retain(input) {
      const settings = await readSettings();
      const content = String(input?.content ?? "").trim();
      if (!content) throw new Error("Nothing to remember.");
      return client().retain(settings.bankId, [{ content: content.slice(0, 50_000), context: input?.context?.slice(0, 500) }]);
    },
    /** @param {{ limit?: number, offset?: number, query?: string }} input */
    async list(input = {}) {
      const settings = await readSettings();
      return client().listMemories(settings.bankId, { limit: input.limit, offset: input.offset, query: input.query });
    },
    /** Check the configured model endpoint answers, without sending any memory. */
    async probeModelEndpoint() {
      const settings = await readSettings();
      const base = resolveLlmBaseUrl(settings).replace(/\/+$/, "");
      const probe = settings.llm.provider === "ollama" ? `${base.replace(/\/v1$/, "")}/api/tags` : `${base}/models`;
      const apiKey = await secretStore.get(MEMORY_SECRET_NAMES.llm).catch(() => null);
      try {
        const response = await fetchImpl(probe, {
          headers: apiKey && !isLocalProvider(settings.llm.provider) ? { Authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(4_000),
        });
        // Any HTTP answer proves the server is up; `ok` says it accepted the probe.
        return { reachable: true, ok: response.ok, status: response.status, url: probe };
      } catch (error) {
        return { reachable: false, ok: false, status: null, url: probe, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
