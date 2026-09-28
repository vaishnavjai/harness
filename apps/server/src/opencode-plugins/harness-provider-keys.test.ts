import { describe, expect, test } from "bun:test";

import { applyProviderKeys, createProviderKeysPlugin, fetchProviderKeys } from "./harness-provider-keys-core.js";

describe("harness-provider-keys plugin", () => {
  test("the plugin module exports only its entry: OpenCode runs every exported function", async () => {
    const plugin = await import("./harness-provider-keys.js");
    expect(Object.keys(plugin)).toEqual(["default"]);
  });


  test("sets each key as the provider's apiKey and keeps other options", () => {
    const config: { provider?: Record<string, { name?: string; options?: Record<string, unknown> }> } = {
      provider: { openai: { name: "OpenAI", options: { baseURL: "https://api.openai.com/v1" } } },
    };
    applyProviderKeys(config, { openai: "sk-a", anthropic: "sk-b" });
    expect(config).toEqual({
      provider: {
        openai: { name: "OpenAI", options: { baseURL: "https://api.openai.com/v1", apiKey: "sk-a" } },
        anthropic: { options: { apiKey: "sk-b" } },
      },
    });
  });

  test("asks the local server with the engine secret", async () => {
    const seen: Array<{ url: string; secret: string | null }> = [];
    const keys = await fetchProviderKeys({
      serverUrl: "http://127.0.0.1:4321/",
      secret: "engine-secret",
      fetchImpl: async (url, init) => {
        seen.push({ url, secret: new Headers(init.headers).get("x-harness-engine-secret") });
        return new Response(JSON.stringify({ keys: { openai: "sk-a", bad: 7 } }));
      },
    });
    expect(keys).toEqual({ openai: "sk-a" });
    expect(seen).toEqual([{ url: "http://127.0.0.1:4321/engine/provider-keys", secret: "engine-secret" }]);
  });

  test("never sends the secret off the machine and never blocks startup", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return new Response("{}");
    };
    expect(await fetchProviderKeys({ serverUrl: "https://evil.example.com", secret: "s", fetchImpl })).toEqual({});
    expect(await fetchProviderKeys({ serverUrl: "http://127.0.0.1:1", secret: "", fetchImpl })).toEqual({});
    expect(called).toBe(false);
    expect(await fetchProviderKeys({ serverUrl: "http://127.0.0.1:1", secret: "s", fetchImpl: async () => { throw new Error("down"); } })).toEqual({});
    expect(await fetchProviderKeys({ serverUrl: "http://127.0.0.1:1", secret: "s", fetchImpl: async () => new Response("", { status: 401 }) })).toEqual({});
  });

  test("the config hook applies the fetched keys", async () => {
    const hooks = await createProviderKeysPlugin({
      serverUrl: "http://localhost:9",
      secret: "s",
      fetchImpl: async () => new Response(JSON.stringify({ keys: { groq: "gsk" } })),
    })();
    const config: { provider?: Record<string, { options?: Record<string, unknown> }> } = {};
    await hooks.config(config);
    expect(config.provider?.groq?.options?.apiKey).toBe("gsk");
  });
});
