// Helpers for the harness-provider-keys engine plugin. Kept out of the plugin
// entry because OpenCode calls every function a plugin module exports.

const ENGINE_SECRET_HEADER = "x-harness-engine-secret";
const REQUEST_TIMEOUT_MS = 5_000;

type ProviderConfig = { options?: Record<string, unknown> } & Record<string, unknown>;
type EngineConfig = { provider?: Record<string, ProviderConfig> };
type FetchKeys = (url: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/** Fetch the stored keys. Any failure yields none: the engine still starts. */
export async function fetchProviderKeys(input: {
  serverUrl: string;
  secret: string;
  fetchImpl?: FetchKeys;
}): Promise<Record<string, string>> {
  const base = input.serverUrl.replace(/\/+$/, "");
  if (!base || !input.secret || !isLoopbackUrl(base)) return {};
  try {
    const response = await (input.fetchImpl ?? fetch)(`${base}/engine/provider-keys`, {
      headers: { [ENGINE_SECRET_HEADER]: input.secret },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return {};
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.keys)) return {};
    const keys: Record<string, string> = {};
    for (const [providerId, key] of Object.entries(body.keys)) {
      if (typeof key === "string" && key) keys[providerId] = key;
    }
    return keys;
  } catch {
    return {};
  }
}

/** Set each key as its provider's apiKey option, keeping every other option. */
export function applyProviderKeys(config: EngineConfig, keys: Record<string, string>): void {
  if (!Object.keys(keys).length) return;
  config.provider ??= {};
  for (const [providerId, apiKey] of Object.entries(keys)) {
    const entry = config.provider[providerId] ?? {};
    config.provider[providerId] = { ...entry, options: { ...(entry.options ?? {}), apiKey } };
  }
}

export function createProviderKeysPlugin(input: { serverUrl: string; secret: string; fetchImpl?: FetchKeys }) {
  return async () => ({
    config: async (config: EngineConfig) => {
      applyProviderKeys(config, await fetchProviderKeys(input));
    },
  });
}
