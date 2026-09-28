import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { createMemoryService, MEMORY_SECRET_NAMES } from "./memory-service.mjs";

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function memorySecretStore() {
  const values = new Map();
  return {
    values,
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => void values.set(name, value),
    delete: async (name) => void values.delete(name),
    has: async (name) => values.has(name),
  };
}

/**
 * @param {Array<import("./memory-service.mjs").MemoryEngineSupervisor & { options: import("@harness/memory").HindsightSupervisorOptions }>} created
 */
function fakeSupervisorFactory(created) {
  /** @param {import("@harness/memory").HindsightSupervisorOptions} options */
  return (options) => {
    /** @type {import("@harness/memory").HindsightSupervisorState} */
    let state = "stopped";
    const supervisor = {
      options,
      async start() {
        state = "ready";
        return { baseUrl: "http://127.0.0.1:8888", token: "t", port: 8888, pid: 1 };
      },
      async stop() {
        state = "stopped";
      },
      status: () => ({
        state,
        pid: 1,
        baseUrl: "http://127.0.0.1:8888",
        port: 8888,
        startedAt: null,
        lastError: null,
        dataDir: options.dataDir,
        restarts: 0,
        recentLogs: [],
      }),
      client: () => ({
        ensureBank: async () => undefined,
        /** @param {string} bankId @param {string} query */
        recall: async (bankId, query) => [{ id: "m1", text: `${bankId}:${query}` }],
        retain: async () => ({ success: true, bank_id: "harness", items_count: 1, is_async: false }),
        listMemories: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
      }),
    };
    created.push(supervisor);
    return supervisor;
  };
}

async function service({ runtime = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "harness-memory-service-"));
  roots.push(root);
  const created = [];
  const events = [];
  const secretStore = memorySecretStore();
  const memory = createMemoryService({
    settingsPath: path.join(root, "memory.json"),
    dataDir: path.join(root, "data", "hindsight"),
    secretStore,
    runtimeOptions: runtime
      ? { env: { HARNESS_HINDSIGHT_PYTHON: "python3" }, repoRoot: path.resolve(import.meta.dirname, "../../..") }
      : { env: {} },
    audit: { event: (kind, detail) => events.push({ kind, detail }) },
    supervisorFactory: fakeSupervisorFactory(created),
    fetchImpl: async (url) => new Response(JSON.stringify({ models: [] }), { status: url.includes("/api/tags") ? 200 : 404 }),
  });
  return { root, memory, created, events, secretStore };
}

describe("memory service", () => {
  test("is off by default and starts nothing", async () => {
    const { memory, created } = await service();
    const status = await memory.startIfEnabled();
    assert.equal(status.settings.enabled, false);
    assert.equal(status.engine.state, "stopped");
    assert.equal(created.length, 0);
  });

  test("turning memory on persists the choice and starts the engine against the local endpoint", async () => {
    const { root, memory, created, events } = await service();
    const status = await memory.start();
    assert.equal(status.engine.state, "ready");
    assert.equal(created.length, 1);
    assert.equal(created[0].options.dataDir, path.join(root, "data", "hindsight"));
    // Electron owns SIGINT/SIGTERM; the supervisor keeps only its exit backstop.
    assert.equal(created[0].options.installExitHooks, true);
    assert.equal(created[0].options.handleSignals, false);
    assert.equal(created[0].options.installExitHooks, true);
    assert.equal(status.llmBaseUrl, "http://127.0.0.1:11434/v1");
    assert.deepEqual(status.egressHosts, []);
    assert.equal(JSON.parse(await readFile(path.join(root, "memory.json"), "utf8")).enabled, true);
    assert.equal(events.at(-1).kind, "memory.engine.started");
    assert.deepEqual(await memory.recall({ query: "pnpm" }), [{ id: "m1", text: "harness:pnpm" }]);
    await memory.shutdown();
    assert.equal(JSON.parse(await readFile(path.join(root, "memory.json"), "utf8")).enabled, true);
  });

  test("hosted providers need a key from the secret store, which never lands in settings", async () => {
    const { root, memory, secretStore, created } = await service();
    await assert.rejects(memory.updateSettings({ enabled: true, llm: { provider: "openai", model: "gpt-4.1-mini" } }), /API key/);
    await memory.setApiKey({ kind: "llm", value: "sk-test-abcdef123456" });
    assert.equal(secretStore.values.get(MEMORY_SECRET_NAMES.llm), "sk-test-abcdef123456");
    const status = await memory.updateSettings({ enabled: true });
    assert.equal(status.engine.state, "ready");
    assert.equal(created.at(-1).options.secrets.llmApiKey, "sk-test-abcdef123456");
    assert.deepEqual(status.egressHosts, ["api.openai.com"]);
    assert.equal((await readFile(path.join(root, "memory.json"), "utf8")).includes("sk-test"), false);
    assert.equal(status.apiKeys.llm, true);
  });

  test("reports a missing runtime instead of downloading one", async () => {
    const { memory } = await service({ runtime: false });
    await assert.rejects(memory.start(), /runtime is not installed/);
  });

  test("probes the local model server without sending memory", async () => {
    const { memory } = await service();
    assert.deepEqual(await memory.probeModelEndpoint(), {
      reachable: true,
      ok: true,
      status: 200,
      url: "http://127.0.0.1:11434/api/tags",
    });
  });

  test("rejects invalid endpoint settings", async () => {
    const { memory } = await service();
    await assert.rejects(memory.updateSettings({ llm: { baseUrl: "file:///etc/passwd" } }));
  });
});
