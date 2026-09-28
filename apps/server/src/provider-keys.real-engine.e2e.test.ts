import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Runs the real pinned OpenCode binary. Opt in with
// HARNESS_TEST_OPENCODE_BIN=/path/to/opencode (the version in constants.json).
const opencodeBin = process.env.HARNESS_TEST_OPENCODE_BIN?.trim();

async function findFiles(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile() && entry.name === name) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

describe.skipIf(!opencodeBin)("provider keys with the real engine", () => {
  test("a stored key connects its provider without ever touching the engine's plaintext auth.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-provider-keys-e2e-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
    for (const [name, dir] of Object.entries({ HOME: "home", XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) {
      process.env[name] = join(root, dir);
      await mkdir(join(root, dir), { recursive: true });
    }
    const secretKey = `sk-e2e-${randomBytes(12).toString("hex")}`;
    const { startEmbeddedServer } = await import("./embedded.js");
    const handle = await startEmbeddedServer({
      configPath: join(root, "server.json"),
      host: "127.0.0.1",
      port: 0,
      token: "client-token",
      hostToken: "host-token",
      workspaces: [workspace],
      manageOpencode: true,
      opencodeBin,
      opencodeCwd: workspace,
      localManagedMcpVaultKey: async () => randomBytes(32),
    });
    try {
      const client = { authorization: "Bearer client-token", "content-type": "application/json" };
      const put = await fetch(`${handle.url}/provider-keys/openai`, { method: "PUT", headers: client, body: JSON.stringify({ key: secretKey }) });
      expect(put.status).toBe(200);

      const engineUrl = handle.config.opencodeBaseUrl ?? "";
      const engineAuth = `Basic ${Buffer.from(`${handle.config.opencodeUsername}:${handle.config.opencodePassword}`).toString("base64")}`;
      const engine = (path: string, init: RequestInit = {}) => fetch(`${engineUrl}${path}?directory=${encodeURIComponent(workspace)}`, {
        ...init,
        headers: { authorization: engineAuth, ...(init.headers ?? {}) },
      });
      // The app disposes the instance after saving a key; the config hook reruns.
      expect((await engine("/instance/dispose", { method: "POST" })).ok).toBe(true);
      const providers = await (await engine("/provider")).json() as { connected: string[] };
      expect(providers.connected).toContain("openai");
      expect(providers.connected).not.toContain("opencode");

      for (const file of await findFiles(root, "auth.json")) {
        expect(await readFile(file, "utf8")).not.toContain(secretKey);
      }
      for (const file of await findFiles(root, "provider-keys.json")) {
        expect(await readFile(file, "utf8")).not.toContain(secretKey);
      }

      // Every Harness plugin must load in the real engine.
      for (const file of await readdir(join(root, "data", "opencode", "log")).catch(() => [])) {
        const failures = (await readFile(join(root, "data", "opencode", "log", file), "utf8"))
          .split("\n")
          .filter((line) => line.includes("failed to load plugin"));
        expect(failures).toEqual([]);
      }

      const removed = await fetch(`${handle.url}/provider-keys/openai`, { method: "DELETE", headers: client });
      expect(removed.status).toBe(200);
      expect((await engine("/instance/dispose", { method: "POST" })).ok).toBe(true);
      const after = await (await engine("/provider")).json() as { connected: string[] };
      expect(after.connected).not.toContain("openai");
    } finally {
      await handle.stop();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
