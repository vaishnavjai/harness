// Gives the engine the model-provider API keys Harness keeps encrypted, in
// memory only. The engine's own credential store is a plaintext file, so
// Harness never writes an API key there; instead this plugin asks the local
// Harness server for the keys each time the engine loads its configuration
// and sets them as provider options. The request goes to loopback and carries
// a per-launch secret that only the engine process receives.

import { createProviderKeysPlugin } from "./harness-provider-keys-core.js";

export default async function harnessProviderKeys() {
  return createProviderKeysPlugin({
    serverUrl: String(process.env.HARNESS_SERVER_URL || ""),
    secret: String(process.env.HARNESS_ENGINE_SECRET || ""),
  })();
}
