import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { SHELL_HIDDEN_ENV_NAMES } from "./opencode-plugins/harness-shell-env-core.js";

// Runs the real pinned OpenCode binary. Opt in with
// HARNESS_TEST_OPENCODE_BIN=/path/to/opencode (the version in constants.json).
const opencodeBin = process.env.HARNESS_TEST_OPENCODE_BIN?.trim();

describe.skipIf(!opencodeBin)("Harness credentials with the real engine", () => {
  test("an agent shell holds no Harness credential, and no Harness route returns a provider key", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-secret-isolation-e2e-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const saved = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].map((name) => [name, process.env[name]] as const);
    for (const [name, dir] of Object.entries({ HOME: "home", XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) {
      process.env[name] = join(root, dir);
      await mkdir(join(root, dir), { recursive: true });
    }
    const secretKey = `sk-e2e-${randomBytes(12).toString("hex")}`;
    const { startEmbeddedServer } = await import("./embedded.js");
    const handle = await startEmbeddedServer({
      configPath: join(root, "server.json"), host: "127.0.0.1", port: 0,
      token: "client-token", hostToken: "host-token", workspaces: [workspace],
      manageOpencode: true, opencodeBin, opencodeCwd: workspace,
      localManagedMcpVaultKey: async () => randomBytes(32),
    });
    try {
      const client = { authorization: "Bearer client-token", "content-type": "application/json" };
      expect((await fetch(`${handle.url}/provider-keys/openai`, { method: "PUT", headers: client, body: JSON.stringify({ key: secretKey }) })).status).toBe(200);

      const engineUrl = handle.config.opencodeBaseUrl ?? "";
      const engineAuth = `Basic ${Buffer.from(`${handle.config.opencodeUsername}:${handle.config.opencodePassword}`).toString("base64")}`;
      const dir = `directory=${encodeURIComponent(workspace)}`;
      const engine = (path: string, init: RequestInit = {}) => fetch(`${engineUrl}${path}${path.includes("?") ? "&" : "?"}${dir}`, {
        ...init, headers: { authorization: engineAuth, "content-type": "application/json", ...(init.headers ?? {}) },
      });
      expect((await engine("/instance/dispose", { method: "POST" })).ok).toBe(true);

      // Harness's proxy of the engine's config and provider reads never carries a key.
      // Including spellings the engine decodes to the same route: a viewer must not get a key by encoding a letter.
      for (const path of ["/opencode/config", "/opencode/provider", "/opencode/%63onfig", "/opencode//config", "/opencode/%70rovider", "/opencode/config/%70roviders", "/opencode/global/%63onfig"]) {
        const response = await fetch(`${handle.url}${path}?${dir}`, { headers: { authorization: "Bearer client-token" } });
        expect(await response.text(), path).not.toContain(secretKey);
      }
      // The engine's own API refuses anyone without its password.
      expect((await fetch(`${engineUrl}/config?${dir}`)).status).toBe(401);

      // An agent's shell holds none of Harness's credentials.
      const session = await (await engine("/session", { method: "POST", body: "{}" })).json() as { id: string };
      const probe = [
        ...SHELL_HIDDEN_ENV_NAMES.map((name) => `if [ -n "\${${name}:-}" ]; then echo "LEAK_${name}"; else echo "CLEAN_${name}"; fi`),
        `echo "SERVER_NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' $HARNESS_SERVER_URL/opencode/config)"`,
        `echo "ENGINE_SECRET_ROUTE=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' $HARNESS_SERVER_URL/engine/provider-keys)"`,
      ].join("; ");
      expect((await engine(`/session/${session.id}/shell`, { method: "POST", body: JSON.stringify({ agent: "harness", command: probe }) })).status).toBe(200);
      const messages = await (await engine(`/session/${session.id}/message`)).json() as Array<{ parts: Array<{ type: string; state?: { output?: string } }> }>;
      const output = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool").map((part) => part.state?.output ?? "").join("\n");
      expect(output).not.toMatch(/^LEAK_/m);
      for (const name of ["HARNESS_SERVER_TOKEN", "OPENCODE_SERVER_PASSWORD", "HARNESS_ENGINE_SECRET"]) expect(output).toContain(`CLEAN_${name}`);
      expect(output).toContain("SERVER_NOAUTH=401");
      expect(output).toContain("ENGINE_SECRET_ROUTE=401");
      expect(output).not.toContain(secretKey);

      // The new plugin must load in the real engine.
      for (const file of await readdir(join(root, "data", "opencode", "log")).catch(() => [])) {
        const failures = (await readFile(join(root, "data", "opencode", "log", file), "utf8")).split("\n").filter((line) => line.includes("failed to load plugin"));
        expect(failures).toEqual([]);
      }
    } finally {
      await handle.stop();
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
