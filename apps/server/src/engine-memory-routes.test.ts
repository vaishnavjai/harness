import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { startServer } from "./server.js";
import { ENGINE_PROVIDER_KEYS_HEADER, ENGINE_PROVIDER_KEYS_SECRET } from "./provider-key-vault.js";
import type { AgentMemoryProvider, ServerConfig } from "./types.js";

const CLIENT_TOKEN = "hwt_engine_memory_client";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

async function serve(agentMemory?: AgentMemoryProvider) {
  const root = await mkdtemp(join(tmpdir(), "harness-engine-memory-"));
  roots.push(root);
  const vaultKey = randomBytes(32);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: CLIENT_TOKEN, hostToken: "hwt_engine_memory_host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], workspaces: [], authorizedRoots: [root], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    localManagedMcpVaultKey: async () => vaultKey,
    ...(agentMemory ? { agentMemory } : {}),
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const post = (route: string, body: unknown, headers: Record<string, string> = { [ENGINE_PROVIDER_KEYS_HEADER]: ENGINE_PROVIDER_KEYS_SECRET }) =>
    fetch(`${base}/engine/memory/${route}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { post };
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

describe("engine memory routes", () => {
  test("only the engine secret reaches memory; clients and shells without it do not", async () => {
    const calls: unknown[] = [];
    const { post } = await serve({
      recall: async (input) => { calls.push(input); return []; },
      retain: async (input) => { calls.push(input); return {}; },
    });
    for (const route of ["recall", "retain"]) {
      expect((await post(route, { query: "x", content: "x" }, {})).status).toBe(401);
      expect((await post(route, { query: "x", content: "x" }, { authorization: `Bearer ${CLIENT_TOKEN}` })).status).toBe(401);
      expect((await post(route, { query: "x", content: "x" }, { [ENGINE_PROVIDER_KEYS_HEADER]: "wrong" })).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  test("recall forwards a bounded query and returns only the fields the agent needs", async () => {
    const calls: Array<{ query: string; maxTokens?: number }> = [];
    const { post } = await serve({
      recall: async (input) => {
        calls.push(input);
        return [{ text: "Jordan prefers pnpm.", type: "world", context: "chat", occurred_start: "2026-09-01T00:00:00Z" }];
      },
      retain: async () => ({}),
    });
    const response = await post("recall", { query: `  ${"q".repeat(3_000)}  `, maxTokens: 100_000 });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ results: [{ text: "Jordan prefers pnpm.", type: "world", context: "chat", occurredAt: "2026-09-01T00:00:00Z" }] });
    expect(calls).toEqual([{ query: "q".repeat(2_000), maxTokens: 8_192 }]);
    expect((await post("recall", { query: "   " })).status).toBe(400);
  });

  test("retain forwards content and context, and refuses empty or oversized content", async () => {
    const calls: Array<{ content: string; context?: string }> = [];
    const { post } = await serve({ recall: async () => [], retain: async (input) => { calls.push(input); return {}; } });
    expect((await post("retain", { content: "Ship on Fridays is banned.", context: "release chat" })).status).toBe(200);
    expect((await post("retain", { content: " " })).status).toBe(400);
    expect((await post("retain", { content: "x".repeat(50_001) })).status).toBe(400);
    expect(calls).toEqual([{ content: "Ship on Fridays is banned.", context: "release chat" }]);
  });

  test("memory that is absent, off or failing answers 503 without leaking engine details", async () => {
    const absent = await serve();
    expect((await absent.post("recall", { query: "x" })).status).toBe(503);
    const off = await serve({
      recall: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8888 token=abc"); },
      retain: async () => { throw new Error("Memory is not running."); },
    });
    const recall = await off.post("recall", { query: "x" });
    expect(recall.status).toBe(503);
    const text = await recall.text();
    expect(text).toContain("Settings > Memory");
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("token=abc");
    expect((await off.post("retain", { content: "x" })).status).toBe(503);
  });
});
