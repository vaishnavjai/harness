import { afterEach, describe, expect, test } from "bun:test";

import { HindsightMemoryClient, HindsightRequestError } from "./hindsight-client.js";

type Captured = { method: string; path: string; authorization: string | null; body: unknown };
const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (servers.length) servers.pop()?.stop();
});

function fakeEngine(respond: (request: Captured) => unknown, status = 200) {
  const captured: Captured[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      const entry = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.get("authorization"),
        body: text ? JSON.parse(text) : null,
      };
      captured.push(entry);
      return Response.json(respond(entry), { status });
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, captured };
}

describe("HindsightMemoryClient", () => {
  test("refuses any endpoint that is not loopback HTTP", () => {
    for (const baseUrl of ["http://10.0.0.5:8888", "https://127.0.0.1:8888", "http://memory.example.com"]) {
      expect(() => new HindsightMemoryClient({ baseUrl, token: "t" })).toThrow("loopback");
    }
  });

  test("retains items with the bearer token and Hindsight's wire shape", async () => {
    const engine = fakeEngine(() => ({ success: true, bank_id: "harness", items_count: 1, async: false }));
    const client = new HindsightMemoryClient({ baseUrl: engine.baseUrl, token: "launch-token" });
    const result = await client.retain("harness", [
      { content: "The user prefers pnpm over npm.", context: "chat", tags: ["workspace:demo"], documentId: "session-1" },
    ]);
    expect(result.items_count).toBe(1);
    expect(result.is_async).toBe(false);
    expect(engine.captured[0]).toEqual({
      method: "POST",
      path: "/v1/default/banks/harness/memories",
      authorization: "Bearer launch-token",
      body: {
        async: false,
        items: [{ content: "The user prefers pnpm over npm.", context: "chat", tags: ["workspace:demo"], document_id: "session-1" }],
      },
    });
  });

  test("recalls with a token budget and returns typed hits", async () => {
    const engine = fakeEngine(() => ({
      results: [{ id: "m1", text: "The user prefers pnpm over npm.", type: "world" }],
    }));
    const client = new HindsightMemoryClient({ baseUrl: engine.baseUrl, token: "launch-token" });
    const hits = await client.recall("harness", "package manager preference", { maxTokens: 512, types: ["world"] });
    expect(hits.map((hit) => hit.text)).toEqual(["The user prefers pnpm over npm."]);
    expect(engine.captured[0]?.body).toEqual({ query: "package manager preference", max_tokens: 512, budget: "mid", types: ["world"] });
  });

  test("encodes bank ids and bounds list pagination", async () => {
    const engine = fakeEngine(() => ({ items: [], total: 0, limit: 500, offset: 0 }));
    const client = new HindsightMemoryClient({ baseUrl: engine.baseUrl, token: "t" });
    await client.listMemories("team/alpha", { limit: 10_000, offset: -3, query: "pnpm" });
    expect(engine.captured[0]?.path).toBe("/v1/default/banks/team%2Falpha/memories/list?limit=500&offset=0&q=pnpm");
  });

  test("surfaces engine errors with their status", async () => {
    const engine = fakeEngine(() => ({ detail: "Invalid API key" }), 401);
    const client = new HindsightMemoryClient({ baseUrl: engine.baseUrl, token: "wrong" });
    const error = await client.listBanks().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HindsightRequestError);
    expect(error instanceof HindsightRequestError ? error.status : 0).toBe(401);
  });
});
