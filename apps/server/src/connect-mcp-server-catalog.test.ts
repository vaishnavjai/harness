import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECT_MCP_APP_HOST_CAPABILITY,
  CONNECT_MCP_APP_HOST_CAPABILITY_HEADER,
  CONNECT_MCP_SERVER_INDEX_URI,
  connectDirectMcpRuntimeName,
  connectMcpAppHostName,
  type HarnessConnectMcpServerIndex,
  readHarnessConnectMcpAppHostAuthorizationReady,
  readHarnessConnectMcpAppHostCatalog,
  readHarnessConnectMcpServerIndex,
  readHarnessConnectMcpServerIndexWithDiagnostics,
  reconcileHarnessConnectMcpServers,
  refreshHarnessConnectMcpAppHostCatalog,
  writeHarnessConnectMcpAppHostAuthorization,
  writeHarnessConnectMcpAppHostCatalog,
} from "./connect-mcp-server-catalog.js";
import { runtimeDbPath } from "./runtime-db.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore } from "./workspace-kv-store.js";

const roots: string[] = [];
const previousRuntimeDb = process.env.HARNESS_RUNTIME_DB;
const previousBootstrapPath = process.env.HARNESS_DESKTOP_BOOTSTRAP_PATH;

afterEach(async () => {
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.HARNESS_RUNTIME_DB;
  else process.env.HARNESS_RUNTIME_DB = previousRuntimeDb;
  if (previousBootstrapPath === undefined) delete process.env.HARNESS_DESKTOP_BOOTSTRAP_PATH;
  else process.env.HARNESS_DESKTOP_BOOTSTRAP_PATH = previousBootstrapPath;
});

async function fixtureConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "harness-connect-mcp-servers-"));
  roots.push(root);
  process.env.HARNESS_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.HARNESS_DESKTOP_BOOTSTRAP_PATH = join(root, "desktop-bootstrap.json");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test",
    hostToken: "host",
    configPath: join(root, "harness.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "One", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

function indexFetcher(
  requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>,
  servers: Array<Partial<HarnessConnectMcpServerIndex["servers"][number]>> = [{
    connectionId: "emc_01k28e8q8pf8r9sff9mhyqxved",
    name: "Project Atlas",
    description: null,
    url: "https://api.harness.invalid/mcp/agent/connections/emc_01k28e8q8pf8r9sff9mhyqxved",
  }],
) {
  return async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, headers: new Headers(init?.headers), body });
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { resources: {} } } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: {
        contents: [{
          uri: CONNECT_MCP_SERVER_INDEX_URI,
          mimeType: "application/json",
          text: JSON.stringify({
            schemaVersion: "harness.connect/mcp-servers/1",
            servers,
          }),
        }],
      },
    });
  };
}

describe("Harness Connect MCP server catalog", () => {
  test("reports workspace- and origin-bound private authorization readiness without initializing storage", async () => {
    const config = await fixtureConfig();
    config.workspaces.push({ ...config.workspaces[0]!, id: "ws_2", name: "Two" });
    const readOnlyConfig = { ...config, readOnly: true };
    const dbPath = runtimeDbPath(config);
    const cloudMcp = {
      type: "remote", enabled: true, url: "https://api.harness.invalid/mcp/agent",
      headers: { Authorization: "Bearer member-token" },
    };
    expect(await readHarnessConnectMcpAppHostAuthorizationReady(readOnlyConfig, "ws_1", cloudMcp)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ mcp: { "harness-cloud": cloudMcp } }));
    const sqlite = new Database(dbPath, { readonly: true, create: false });
    try {
      const schema = sqlite.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
      expect(sqlite.query("SELECT name FROM sqlite_master WHERE name = ?").get("connect_mcp_app_host_authorizations")).toBeNull();
      expect(await readHarnessConnectMcpAppHostAuthorizationReady(readOnlyConfig, "ws_1", cloudMcp)).toBe(false);
      expect(sqlite.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    } finally {
      sqlite.close();
    }
    await writeHarnessConnectMcpAppHostAuthorization(config, "ws_1", "Bearer private-app-host-token", cloudMcp.url);
    expect(await readHarnessConnectMcpAppHostAuthorizationReady(readOnlyConfig, "ws_1", cloudMcp)).toBe(true);
    expect(await readHarnessConnectMcpAppHostAuthorizationReady(readOnlyConfig, "ws_2", cloudMcp)).toBe(false);
    expect(await readHarnessConnectMcpAppHostAuthorizationReady(readOnlyConfig, "ws_1", {
      ...cloudMcp, url: "https://api.harness-legacy.invalid/mcp/agent",
    })).toBe(false);
    expect(await readHarnessConnectMcpAppHostAuthorizationReady(readOnlyConfig, "ws_1", cloudMcp)).toBe(true);
  });

  test("reports malformed stored private authorization as not provisioned", async () => {
    const config = await fixtureConfig();
    const cloudMcp = { type: "remote", enabled: true, url: "https://api.harness.invalid/mcp/agent" };
    const authorizations = createWorkspaceKvStore<string>({
      tableName: "connect_mcp_app_host_authorizations", valueColumn: "authorization_json",
      parse: (json) => json, serialize: (json) => json,
    });
    for (const value of [
      "not-json",
      JSON.stringify({ authorization: 123, origin: "https://api.harness.invalid" }),
      JSON.stringify({ authorization: "Bearer token with spaces", origin: "https://api.harness.invalid" }),
      JSON.stringify({ authorization: "Bearer private-app-host-token", origin: "not-an-origin" }),
    ]) {
      await authorizations.set(config, "ws_1", value);
      expect(await readHarnessConnectMcpAppHostAuthorizationReady(config, "ws_1", cloudMcp)).toBe(false);
    }
  });

  test("leaves private authorization readiness unknown for ineligible endpoints", async () => {
    const config = await fixtureConfig();
    const cloudMcp = { type: "remote", enabled: true, url: "https://api.harness.invalid/mcp/agent" };
    await writeHarnessConnectMcpAppHostAuthorization(config, "ws_1", "Bearer private-app-host-token", cloudMcp.url);
    for (const endpoint of [null, { ...cloudMcp, enabled: false }, { ...cloudMcp, type: "local" }, { ...cloudMcp, url: "not-a-url" }]) {
      expect(await readHarnessConnectMcpAppHostAuthorizationReady(config, "ws_1", endpoint)).toBeNull();
    }
    const untrusted = { ...cloudMcp, url: "https://untrusted.invalid/mcp/agent" };
    await writeHarnessConnectMcpAppHostAuthorization(config, "ws_1", "Bearer private-app-host-token", untrusted.url);
    expect(await readHarnessConnectMcpAppHostAuthorizationReady(config, "ws_1", untrusted)).toBeNull();
  });

  test("reads the member catalog through an authenticated MCP resource", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const index = await readHarnessConnectMcpServerIndex({
      type: "remote",
      url: "https://api.harness.invalid/mcp/agent",
      headers: { Authorization: "Bearer member-token" },
    }, "Bearer private-app-host-token", indexFetcher(requests));

    expect(index?.servers[0]?.name).toBe("Project Atlas");
    expect(requests.map((request) => request.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "resources/read",
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer private-app-host-token")).toBe(true);
    expect(requests.every((request) => request.headers.get(CONNECT_MCP_APP_HOST_CAPABILITY_HEADER)
      === CONNECT_MCP_APP_HOST_CAPABILITY)).toBe(true);
  });

  test("keeps hosted api-origin provider proxies on the credential-bound app gateway origin", async () => {
    const index = await readHarnessConnectMcpServerIndex({
      type: "remote",
      url: "https://app.harness.invalid/api/den/mcp/agent",
    }, "Bearer private-app-host-token", indexFetcher([]));

    expect(index?.servers[0]?.url).toBe(
      "https://app.harness.invalid/api/den/mcp/agent/connections/emc_01k28e8q8pf8r9sff9mhyqxved",
    );
  });

  test("reconciles only Harness-owned proxy entries and preserves user MCPs", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "harness-cloud": { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "harness-connect-stale": { type: "remote", url: "https://cloud.example/stale" },
      },
    }));
    const connectionId = "emc_01k28e8q8pf8r9sff9mhyqxved";
    const result = await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: {
        type: "remote",
        url: "https://api.harness.invalid/mcp/agent",
        headers: { Authorization: "Bearer member-token" },
      },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([]),
    });

    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(result).toEqual({
      status: "synced",
      diagnostic: "ready",
      appHostNames: [connectMcpAppHostName(connectionId)],
      directNames: [],
      removedNames: ["harness-connect-stale"],
    });
    expect(runtime.mcp?.["harness-cloud"]).toEqual({ type: "remote", url: "https://api.harness.invalid/mcp/agent" });
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
    expect(runtime.mcp?.["harness-connect-stale"]).toBeUndefined();
    expect(Object.keys(runtime.mcp ?? {}).some((name) => name.startsWith("harness-connect-"))).toBe(false);
    expect(Object.keys(runtime.mcp ?? {}).some((name) => name.startsWith("harness-direct-"))).toBe(false);
    expect(await readHarnessConnectMcpAppHostCatalog(config, "ws_1")).toEqual({
      schemaVersion: "harness.connect/mcp-servers/1",
      servers: [{
        connectionId,
        name: "Project Atlas",
        description: null,
        url: `https://api.harness.invalid/mcp/agent/connections/${connectionId}`,
        exposeDirectly: false,
      }],
    });
  });

  test("projects directly exposed connections into the model runtime with the member credential", async () => {
    const config = await fixtureConfig();
    const directId = "emc_01direct";
    const boundedId = "emc_01bounded";
    const direct = { connectionId: directId, name: "Linear (Engineering)" };
    const directName = connectDirectMcpRuntimeName(direct);
    expect(directName).toMatch(/^harness-direct-linear-engineering-[0-9a-f]{6}$/);
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "harness-direct-revoked-abc123": { type: "remote", url: "https://api.harness.invalid/mcp/agent/connections/emc_01revoked" },
      },
    }));
    const cloudMcp = {
      type: "remote",
      url: "https://api.harness.invalid/mcp/agent",
      enabled: true,
      headers: { Authorization: "Bearer member-token" },
    };
    const result = await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp,
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [
        { ...direct, description: null, url: `https://api.harness.invalid/mcp/agent/connections/${directId}`, exposeDirectly: true },
        { connectionId: boundedId, name: "Bounded", description: null, url: `https://api.harness.invalid/mcp/agent/connections/${boundedId}` },
      ]),
    });

    expect(result).toEqual({
      status: "synced",
      diagnostic: "ready",
      appHostNames: [connectMcpAppHostName(boundedId), connectMcpAppHostName(directId)].sort(),
      directNames: [directName],
      removedNames: ["harness-direct-revoked-abc123"],
    });
    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(runtime.mcp?.[directName]).toEqual({
      type: "remote",
      url: `https://api.harness.invalid/mcp/agent/connections/${directId}`,
      enabled: true,
      headers: { Authorization: "Bearer member-token" },
      oauth: false,
    });
    expect(runtime.mcp?.["harness-direct-revoked-abc123"]).toBeUndefined();
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
    expect(Object.keys(runtime.mcp ?? {}).filter((name) => name.startsWith("harness-direct-"))).toEqual([directName]);
    expect(JSON.stringify(runtime.mcp)).not.toContain("private-app-host-token");

    // Turning the flag off removes the entry on the next reconcile.
    const revoked = await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp,
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [
        { ...direct, description: null, url: `https://api.harness.invalid/mcp/agent/connections/${directId}`, exposeDirectly: false },
      ]),
    });
    expect(revoked.directNames).toEqual([]);
    expect(revoked.removedNames).toEqual([directName]);
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.[directName]).toBeUndefined();
  });

  test("a flagged connection is not projected when the Cloud entry carries no member credential", async () => {
    const config = await fixtureConfig();
    const directId = "emc_01direct";
    const result = await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [
        { connectionId: directId, name: "Linear", description: null, url: `https://api.harness.invalid/mcp/agent/connections/${directId}`, exposeDirectly: true },
      ]),
    });
    expect(result.status).toBe("synced");
    expect(result.directNames).toEqual([]);
    expect(Object.keys((await readRuntimeOpencodeConfig(config, "ws_1")).mcp ?? {})).toEqual([]);
  });

  test("an unavailable index purges directly exposed entries instead of trusting a stale catalog", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: { "harness-direct-linear-abc123": { type: "remote", url: "https://api.harness.invalid/mcp/agent/connections/emc_01x" } },
    }));
    const result = await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
      fetcher: async () => new Response(null, { status: 404 }),
    });
    expect(result).toEqual({
      status: "unavailable",
      diagnostic: "missing_app_host_auth",
      appHostNames: [],
      directNames: [],
      removedNames: ["harness-direct-linear-abc123"],
    });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["harness-direct-linear-abc123"]).toBeUndefined();
  });

  test("opportunistically refreshes a stale private catalog from the runtime Cloud endpoint", async () => {
    const config = await fixtureConfig();
    const connectionId = "emc_01k28e8q8pf8r9sff9mhyqxved";
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "harness-cloud": { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
      },
    }));
    await writeHarnessConnectMcpAppHostAuthorization(
      config,
      "ws_1",
      "Bearer private-app-host-token",
      "https://api.harness.invalid/mcp/agent",
    );

    const result = await refreshHarnessConnectMcpAppHostCatalog(config, "ws_1", indexFetcher(requests));

    expect(result).toEqual({ status: "synced", diagnostic: "ready", appHostNames: [connectMcpAppHostName(connectionId)] });
    expect((await readHarnessConnectMcpAppHostCatalog(config, "ws_1")).servers[0]?.connectionId).toBe(connectionId);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer private-app-host-token")).toBe(true);
  });

  test("preserves the last known-good catalog when an opportunistic refresh is unavailable", async () => {
    const config = await fixtureConfig();
    const connectionId = "emc_01lastknowngood";
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "harness-cloud": { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
      },
    }));
    await writeHarnessConnectMcpAppHostAuthorization(
      config,
      "ws_1",
      "Bearer private-app-host-token",
      "https://api.harness.invalid/mcp/agent",
    );
    await writeHarnessConnectMcpAppHostCatalog(config, "ws_1", {
      schemaVersion: "harness.connect/mcp-servers/1",
      servers: [{
        connectionId,
        name: "Last known good",
        description: null,
        url: `https://api.harness.invalid/mcp/agent/connections/${connectionId}`,
        exposeDirectly: false,
      }],
    });

    const result = await refreshHarnessConnectMcpAppHostCatalog(
      config,
      "ws_1",
      async () => new Response(null, { status: 503 }),
    );

    expect(result).toEqual({ status: "unavailable", diagnostic: "discovery_unavailable", appHostNames: [] });
    expect((await readHarnessConnectMcpAppHostCatalog(config, "ws_1")).servers[0]?.connectionId).toBe(connectionId);
  });

  test("fails closed and purges prior runtime entries when Cloud has no index", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: { "harness-connect-existing": { type: "remote", url: "https://cloud.example/existing" } },
    }));
    const result = await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
      fetcher: async () => new Response(null, { status: 404 }),
    });
    expect(result).toEqual({
      status: "unavailable",
      diagnostic: "missing_app_host_auth",
      appHostNames: [],
      directNames: [],
      removedNames: ["harness-connect-existing"],
    });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["harness-connect-existing"]).toBeUndefined();
    expect((await readHarnessConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("an empty index removes prior Harness-owned provider servers", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "harness-connect-existing": { type: "remote", url: "https://cloud.example/existing" },
      },
    }));
    const result = await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], []),
    });

    expect(result).toEqual({
      status: "synced",
      diagnostic: "empty",
      appHostNames: [],
      directNames: [],
      removedNames: ["harness-connect-existing"],
    });
    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(runtime.mcp?.["harness-connect-existing"]).toBeUndefined();
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
  });

  test("never sends the persisted App-host credential to an untrusted reconcile endpoint", async () => {
    const config = await fixtureConfig();
    const trustedRequests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher(trustedRequests),
    });
    expect(trustedRequests.length).toBeGreaterThan(0);

    let untrustedRequests = 0;
    const result = await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://attacker.example/mcp/agent" },
      fetcher: async () => {
        untrustedRequests += 1;
        return new Response(null, { status: 500 });
      },
    });

    expect(untrustedRequests).toBe(0);
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic).toBe("untrusted_origin");
    expect((await readHarnessConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("rejects a catalog that points the private App-host credential at another origin", async () => {
    const config = await fixtureConfig();
    const result = await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [{
        connectionId: "emc_01crossorigin",
        name: "Untrusted endpoint",
        description: null,
        url: "https://attacker.example/mcp/agent/connections/emc_01crossorigin",
      }]),
    });

    expect(result).toEqual({ status: "unavailable", diagnostic: "invalid_proxy_descriptor", appHostNames: [], directNames: [], removedNames: [] });
    expect((await readHarnessConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("rejects a hosted api-origin descriptor that is not the exact connection proxy", async () => {
    const config = await fixtureConfig();
    const result = await reconcileHarnessConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://app.harness.invalid/api/den/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [{
        connectionId: "emc_01crossorigin",
        name: "Wrong proxy path",
        description: null,
        url: "https://api.harness.invalid/mcp/agent/connections/another-connection",
      }]),
    });

    expect(result).toEqual({ status: "unavailable", diagnostic: "invalid_proxy_descriptor", appHostNames: [], directNames: [], removedNames: [] });
    expect((await readHarnessConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });
  test("attributes malformed JSON and invalid index schemas without returning provider data", async () => {
    for (const text of ["not-json", JSON.stringify({ schemaVersion: "unsupported", servers: [] })]) {
      const result = await readHarnessConnectMcpServerIndexWithDiagnostics(
        { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
        "Bearer private-app-host-token",
        async (url, init) => {
          const response = await indexFetcher([])(url, init);
          if (JSON.parse(String(init?.body)).method !== "resources/read") return response;
          return Response.json({ jsonrpc: "2.0", id: 2, result: { contents: [{ uri: CONNECT_MCP_SERVER_INDEX_URI, text }] } });
        },
      );
      expect(result).toEqual({ index: null, diagnostic: "invalid_catalog" });
    }
  });

  test("does not mislabel HTTP failures as missing auth or a successful empty catalog", async () => {
    for (const status of [401, 403, 404, 503]) {
      const result = await readHarnessConnectMcpServerIndexWithDiagnostics(
        { type: "remote", url: "https://api.harness.invalid/mcp/agent" },
        "Bearer private-app-host-token",
        async () => new Response(null, { status }),
      );
      expect(result).toEqual({ index: null, diagnostic: "discovery_unavailable" });
    }
  });
});
