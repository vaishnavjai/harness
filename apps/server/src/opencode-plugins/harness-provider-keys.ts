// Gives the engine the model-provider API keys Harness keeps encrypted, in
// memory only. The engine's own credential store is a plaintext file, so
// Harness never writes an API key there; instead this plugin asks the local
// Harness server for the keys each time the engine loads its configuration
// and sets them as provider options. The request goes to loopback and carries
// a per-launch secret that only the engine process receives.

import { createProviderKeysPlugin } from "./harness-provider-keys-core.js";

const SECRET_SLOT = Symbol.for("harness.engineSecret");

/**
 * Move the per-launch secret out of the environment on first load. The
 * engine hands its environment to every shell command and MCP server it
 * starts; with the secret gone from it, an agent's shell cannot ask the
 * server for the keys. The process-wide slot survives plugin reloads.
 */
function takeEngineSecret(): string {
  const fromEnv = process.env.HARNESS_ENGINE_SECRET;
  if (fromEnv) {
    Reflect.set(globalThis, SECRET_SLOT, fromEnv);
    delete process.env.HARNESS_ENGINE_SECRET;
  }
  const held: unknown = Reflect.get(globalThis, SECRET_SLOT);
  return typeof held === "string" ? held : "";
}

takeEngineSecret();

export default async function harnessProviderKeys() {
  return createProviderKeysPlugin({
    serverUrl: String(process.env.HARNESS_SERVER_URL || ""),
    secret: takeEngineSecret(),
  })();
}
