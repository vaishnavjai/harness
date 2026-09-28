import { describe, expect, test } from "bun:test";

import { buildHarnessRuntimeConfigObject } from "../harness-runtime-config.js";
import { harnessMemoryPluginPath } from "../harness-extensions-plugin-path.js";
import { MEMORY_UNAVAILABLE, callMemoryRoute, createMemoryPlugin, formatRecall } from "./harness-memory-core.js";

type Seen = { url: string; secret: string | null; body: unknown };

function recorder(response: () => Response) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    seen.push({ url, secret: new Headers(init.headers).get("x-harness-engine-secret"), body: JSON.parse(String(init.body)) });
    return response();
  };
  return { seen, fetchImpl };
}

async function tools(input: Parameters<typeof createMemoryPlugin>[0]) {
  const plugin = await createMemoryPlugin(input)();
  return plugin.tool;
}

describe("harness-memory plugin", () => {
  test("the plugin module exports only its entry: OpenCode runs every exported function", async () => {
    const plugin = await import("./harness-memory.js");
    expect(Object.keys(plugin)).toEqual(["default"]);
  });

  test("the engine loads it right after the provider-keys plugin", async () => {
    const runtime = await buildHarnessRuntimeConfigObject();
    const plugins = Array.isArray(runtime.plugin) ? runtime.plugin.map(String) : [];
    expect(plugins).toContain(harnessMemoryPluginPath());
    expect(plugins.indexOf(harnessMemoryPluginPath())).toBe(plugins.findIndex((path) => path.includes("harness-provider-keys")) + 1);
  });

  test("memory_recall asks the local server with the engine secret and lists what it found", async () => {
    const { seen, fetchImpl } = recorder(() => Response.json({ results: [{ text: "Jordan prefers pnpm.", type: "world" }, { text: 7 }] }));
    const { memory_recall } = await tools({ serverUrl: "http://127.0.0.1:4321/", secret: "engine-secret", fetchImpl });
    expect(await memory_recall.execute({ query: "package manager" })).toBe("Memories:\n- Jordan prefers pnpm. (world)");
    expect(seen).toEqual([{ url: "http://127.0.0.1:4321/engine/memory/recall", secret: "engine-secret", body: { query: "package manager" } }]);
  });

  test("memory_retain stores the fact with its context", async () => {
    const { seen, fetchImpl } = recorder(() => Response.json({ ok: true }));
    const { memory_retain } = await tools({ serverUrl: "http://127.0.0.1:4321", secret: "engine-secret", fetchImpl });
    expect(await memory_retain.execute({ content: "Releases ship on Tuesdays.", context: "release chat" })).toBe("Remembered.");
    expect(seen.map((call) => [call.url, call.body])).toEqual([["http://127.0.0.1:4321/engine/memory/retain", { content: "Releases ship on Tuesdays.", context: "release chat" }]]);
  });

  test("never sends the secret off the machine, and memory being off is a message, not a failure", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return Response.json({}); };
    await expect(callMemoryRoute({ serverUrl: "https://evil.example.com", secret: "s", fetchImpl }, "recall", {})).rejects.toThrow(MEMORY_UNAVAILABLE);
    await expect(callMemoryRoute({ serverUrl: "http://127.0.0.1:1", secret: "", fetchImpl }, "recall", {})).rejects.toThrow(MEMORY_UNAVAILABLE);
    expect(called).toBe(false);
    const down = await tools({ serverUrl: "http://127.0.0.1:1", secret: "s", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    expect(await down.memory_recall.execute({ query: "x" })).toBe(MEMORY_UNAVAILABLE);
    const off = await tools({ serverUrl: "http://127.0.0.1:1", secret: "s", fetchImpl: async () => Response.json({ code: "memory_unavailable", message: MEMORY_UNAVAILABLE }, { status: 503 }) });
    expect(await off.memory_retain.execute({ content: "x" })).toBe(MEMORY_UNAVAILABLE);
    expect(formatRecall({ results: [] })).toBe("No memories matched.");
  });

  test("tool arguments are validated before anything is sent", async () => {
    const { seen, fetchImpl } = recorder(() => Response.json({ results: [] }));
    const { memory_recall, memory_retain } = await tools({ serverUrl: "http://127.0.0.1:4321", secret: "s", fetchImpl });
    await expect(memory_recall.execute({ query: "" })).rejects.toThrow();
    await expect(memory_retain.execute({ content: "x".repeat(50_001) })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
