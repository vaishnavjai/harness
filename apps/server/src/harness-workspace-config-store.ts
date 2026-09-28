import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

function normalizeHarnessWorkspaceConfig(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseHarnessWorkspaceConfig(configJson: string): Record<string, unknown> {
  try {
    return normalizeHarnessWorkspaceConfig(JSON.parse(configJson));
  } catch {
    return {};
  }
}

const harnessWorkspaceConfigStore = createWorkspaceKvStore<Record<string, unknown>>({
  tableName: "harness_workspace_configs",
  valueColumn: "config_json",
  parse: parseHarnessWorkspaceConfig,
  serialize: (value) => JSON.stringify(value),
});

export async function readHarnessWorkspaceConfig(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  return await harnessWorkspaceConfigStore.get(config, workspaceId) ?? {};
}

export async function writeHarnessWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const next = normalizeHarnessWorkspaceConfig(updater(await readHarnessWorkspaceConfig(config, workspaceId)));
  await harnessWorkspaceConfigStore.set(config, workspaceId, next);
  return next;
}

export async function hasHarnessWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  return harnessWorkspaceConfigStore.has(config, workspaceId);
}

/**
 * Seed the DB-backed harness config for a workspace if no row exists yet.
 * Used at workspace creation and as the migrate-on-read landing spot for
 * legacy `.opencode/harness.json` files. No-op when a row is already present,
 * so it never clobbers live provisioning state.
 */
export async function seedHarnessWorkspaceConfigIfEmpty(
  config: ServerConfig,
  workspaceId: string,
  seed: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (await hasHarnessWorkspaceConfig(config, workspaceId)) {
    return readHarnessWorkspaceConfig(config, workspaceId);
  }
  return writeHarnessWorkspaceConfig(config, workspaceId, () => seed);
}

export function mergeHarnessWorkspaceConfigs(
  legacy: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  return { ...legacy, ...stored };
}
