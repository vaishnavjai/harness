import { afterEach, expect, test } from "bun:test";

import type { Client, ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { HarnessServerError, type HarnessServerClient } from "../src/app/lib/harness-server";
import { createProviderAuthStore, type ProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { clearProviderListQueries } from "../src/react-app/infra/provider-list-query";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

const stores: ProviderAuthStore[] = [];

afterEach(() => {
  for (const store of stores) store.dispose();
  stores.length = 0;
  clearProviderListQueries(getReactQueryClient());
});

function providerItem(id: string): ProviderListItem {
  return { id, name: id, source: "api", env: [], options: {}, models: {} };
}

function createHarness(vault: "available" | "missing-route" | "unavailable" | "none") {
  const engine = {
    authSet: [] as Array<{ providerID: string; key: unknown }>,
    authRemoved: [] as string[],
    disposes: 0,
    connected: [] as string[],
  };
  const vaultCalls: Array<{ op: "set" | "remove"; providerId: string; key?: string }> = [];

  const client = {
    auth: {
      set: async (input: { providerID: string; auth: { key?: unknown } }) => {
        engine.authSet.push({ providerID: input.providerID, key: input.auth?.key });
        engine.connected.push(input.providerID);
        return { data: true };
      },
      remove: async (input: { providerID: string }) => {
        engine.authRemoved.push(input.providerID);
        return { data: true };
      },
    },
    global: { health: async () => ({ data: { healthy: true } }) },
    instance: {
      dispose: async () => {
        engine.disposes += 1;
        return { data: true };
      },
    },
    config: {
      get: async () => ({ data: {} }),
      update: async (input: { config: Record<string, unknown> }) => ({ data: input.config }),
    },
    provider: {
      list: async () => ({
        data: { all: engine.connected.map(providerItem), connected: engine.connected, default: {} },
      }),
    },
  } as unknown as Client;

  const failure = (status: number) => new HarnessServerError(status, status === 404 ? "not_found" : "managed_mcp_secure_storage_unavailable", "vault");
  const harnessServerClient = {
    getEngineV2PreviewStatus: async () => ({ enabled: false, chatRouting: false }),
    setProviderKey: async (providerId: string, key: string) => {
      vaultCalls.push({ op: "set", providerId, key });
      if (vault === "missing-route") throw failure(404);
      if (vault === "unavailable") throw failure(503);
      engine.connected.push(providerId);
      return { ok: true as const, providerId };
    },
    removeProviderKey: async (providerId: string) => {
      vaultCalls.push({ op: "remove", providerId });
      if (vault === "missing-route") throw failure(404);
      engine.connected = engine.connected.filter((id) => id !== providerId);
      return { ok: true as const, providerId };
    },
  } as unknown as HarnessServerClient;

  const workspace: WorkspaceDisplay = {
    id: "ws_vault",
    name: "Vault Workspace",
    path: "/tmp/ws-vault",
    preset: "default",
    workspaceType: "local",
  };

  const store = createProviderAuthStore({
    client: () => client,
    providers: () => [],
    providerDefaults: () => ({}),
    providerConnectedIds: () => engine.connected,
    disabledProviders: () => [],
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => workspace,
    providerBaseUrl: () => `http://127.0.0.1:1/${workspace.id}`,
    selectedWorkspaceRoot: () => workspace.path,
    runtimeWorkspaceId: () => null,
    harnessServer: {
      getSnapshot: () => ({
        harnessServerStatus: vault === "none" ? "disconnected" : "connected",
        harnessServerClient: vault === "none" ? null : harnessServerClient,
        harnessServerCapabilities: null,
      }),
    },
    setProviders: () => undefined,
    setProviderDefaults: () => undefined,
    setProviderConnectedIds: () => undefined,
    setDisabledProviders: () => undefined,
    markOpencodeConfigReloadRequired: () => undefined,
  });
  stores.push(store);
  return { engine, vaultCalls, store };
}

test("an API key goes to the encrypted vault and never to the engine's plaintext store", async () => {
  const { engine, vaultCalls, store } = createHarness("available");
  await store.submitProviderApiKey("openai", "  sk-live-secret  ");

  expect(vaultCalls).toEqual([{ op: "set", providerId: "openai", key: "sk-live-secret" }]);
  expect(engine.authSet).toEqual([]);
  // Any copy an older build left in the engine store is removed.
  expect(engine.authRemoved).toEqual(["openai"]);
  // The engine reloads its config so the plugin injects the new key.
  expect(engine.disposes).toBeGreaterThan(0);
});

test("a vault that cannot encrypt is an error, never a plaintext fallback", async () => {
  const { engine, store } = createHarness("unavailable");
  await expect(store.submitProviderApiKey("openai", "sk-live-secret")).rejects.toThrow();
  expect(engine.authSet).toEqual([]);
  expect(store.getSnapshot().providerAuthError).not.toBeNull();
});

test("an older remote server without the vault keeps using its engine store", async () => {
  const { engine, store } = createHarness("missing-route");
  await store.submitProviderApiKey("openai", "sk-remote");
  expect(engine.authSet).toEqual([{ providerID: "openai", key: "sk-remote" }]);
});

test("disconnecting removes the key from the vault as well as the engine", async () => {
  const { engine, vaultCalls, store } = createHarness("available");
  await store.submitProviderApiKey("groq", "gsk");
  await store.disconnectProvider("groq");
  expect(vaultCalls.at(-1)).toEqual({ op: "remove", providerId: "groq" });
  expect(engine.authRemoved).toContain("groq");
});
