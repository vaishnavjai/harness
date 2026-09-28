import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { startServer } from "./server.js";
import {
  ENGINE_PROVIDER_KEYS_HEADER,
  ENGINE_PROVIDER_KEYS_SECRET,
  listProviderKeyIds,
  readProviderKeys,
  setProviderKey,
} from "./provider-key-vault.js";
import { runtimeStorageDir } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

const CLIENT_TOKEN = "hwt_provider_keys_client";
const HOST_TOKEN = "hwt_provider_keys_host";
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "harness-provider-keys-"));
  roots.push(root);
  return root;
}

function serverConfig(root: string, vaultKey = randomBytes(32)): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    localManagedMcpVaultKey: async () => vaultKey,
  };
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

describe("provider key vault", () => {
  test("stores keys encrypted, owner-only, and never in plaintext", async () => {
    const config = serverConfig(await tempRoot());
    await setProviderKey(config, "openai", "sk-live-very-secret-value");
    await setProviderKey(config, "anthropic", "sk-ant-another-secret");

    const file = join(runtimeStorageDir(config), "provider-keys.json");
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("sk-live-very-secret-value");
    expect(raw).not.toContain("sk-ant-another-secret");
    expect(raw).not.toContain("openai");
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1, algorithm: "aes-256-gcm" });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    expect(await readProviderKeys(config)).toEqual({ openai: "sk-live-very-secret-value", anthropic: "sk-ant-another-secret" });
    expect(await listProviderKeyIds(config)).toEqual(["anthropic", "openai"]);

    await setProviderKey(config, "openai", null);
    expect(await readProviderKeys(config)).toEqual({ anthropic: "sk-ant-another-secret" });
  });

  test("refuses to decrypt with another key or after tampering", async () => {
    const root = await tempRoot();
    const config = serverConfig(root);
    await setProviderKey(config, "openai", "sk-test");
    await expect(readProviderKeys(serverConfig(root))).rejects.toThrow();

    const file = join(runtimeStorageDir(config), "provider-keys.json");
    const envelope = JSON.parse(await readFile(file, "utf8"));
    const data = Buffer.from(envelope.data, "base64");
    data[0] = (data[0] ?? 0) ^ 0xff;
    await writeFile(file, JSON.stringify({ ...envelope, data: data.toString("base64") }));
    await expect(readProviderKeys(config)).rejects.toThrow();
  });

  test("serializes concurrent writes without losing a key", async () => {
    const config = serverConfig(await tempRoot());
    await Promise.all(["a", "b", "c", "d", "e"].map((id) => setProviderKey(config, `provider-${id}`, `key-${id}`)));
    expect(await listProviderKeyIds(config)).toEqual(["provider-a", "provider-b", "provider-c", "provider-d", "provider-e"]);
  });

  test("rejects ids that could escape the provider map", async () => {
    const config = serverConfig(await tempRoot());
    await expect(setProviderKey(config, "../auth", "sk")).rejects.toThrow("Invalid provider id");
    await expect(setProviderKey(config, "__proto__", "sk")).rejects.toThrow("Invalid provider id");
    await expect(setProviderKey(config, "openai", "   ")).rejects.toThrow("Invalid API key");
  });
});

describe("provider key routes", () => {
  test("clients write and list ids; only the engine secret reads keys", async () => {
    const config = serverConfig(await tempRoot());
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const client = { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" };

    const put = await fetch(`${base}/provider-keys/openai`, { method: "PUT", headers: client, body: JSON.stringify({ key: "sk-route-secret" }) });
    expect(put.status).toBe(200);

    const listed = await fetch(`${base}/provider-keys`, { headers: client });
    const listedText = await listed.text();
    expect(JSON.parse(listedText)).toEqual({ providers: ["openai"] });
    expect(listedText).not.toContain("sk-route-secret");

    expect((await fetch(`${base}/engine/provider-keys`)).status).toBe(401);
    expect((await fetch(`${base}/engine/provider-keys`, { headers: { authorization: `Bearer ${CLIENT_TOKEN}` } })).status).toBe(401);
    expect((await fetch(`${base}/engine/provider-keys`, { headers: { [ENGINE_PROVIDER_KEYS_HEADER]: "wrong" } })).status).toBe(401);

    const engine = await fetch(`${base}/engine/provider-keys`, { headers: { [ENGINE_PROVIDER_KEYS_HEADER]: ENGINE_PROVIDER_KEYS_SECRET } });
    expect(engine.status).toBe(200);
    expect(engine.headers.get("cache-control")).toBe("no-store");
    expect(await engine.json()).toEqual({ keys: { openai: "sk-route-secret" } });

    expect((await fetch(`${base}/provider-keys/openai`, { method: "DELETE", headers: client })).status).toBe(200);
    expect(await (await fetch(`${base}/provider-keys`, { headers: client })).json()).toEqual({ providers: [] });
    expect((await fetch(`${base}/provider-keys/openai`, { method: "PUT", body: JSON.stringify({ key: "x" }) })).status).toBe(401);
  });
});
