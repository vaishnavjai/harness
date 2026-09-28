import { loopbackFetch } from "./server-fetch.js";

const LOCAL_MODELS_URL = "http://localhost:8791/models";

type ResolveOpencodeModelCatalogEnvOptions = {
  env?: NodeJS.ProcessEnv;
  fetchModels?: (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;
};

/**
 * How a managed engine gets its model catalog. By default it uses the catalog
 * compiled into the OpenCode binary and fetches nothing: Harness makes no
 * request to a host the person did not configure. An explicit
 * OPENCODE_MODELS_URL, or the loopback development catalog, opts back in.
 */
export async function resolveOpencodeModelCatalogEnv(
  options: ResolveOpencodeModelCatalogEnvOptions = {},
): Promise<Record<string, string>> {
  const env = options.env ?? process.env;
  const override = env.OPENCODE_MODELS_URL?.trim();
  if (override) return { OPENCODE_MODELS_URL: override };
  if (env.HARNESS_DEV_MODE === "1") {
    try {
      const response = await (options.fetchModels ?? loopbackFetch)(`${LOCAL_MODELS_URL}/api.json`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return { OPENCODE_MODELS_URL: LOCAL_MODELS_URL };
    } catch {
      // A standalone desktop dev session does not run the local inference stack.
    }
  }
  return { OPENCODE_DISABLE_MODELS_FETCH: "1" };
}
