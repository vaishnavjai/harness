// Gives the agent long-term memory: the memory_recall and memory_retain tools
// reach the desktop's local memory engine through the Harness server on
// loopback, carrying the per-launch engine secret. The memory engine's own
// credential never enters the engine process or an agent's shell.

import { takeEngineSecret } from "./engine-secret.js";
import { createMemoryPlugin } from "./harness-memory-core.js";

takeEngineSecret();

export default async function harnessMemory() {
  return createMemoryPlugin({
    serverUrl: String(process.env.HARNESS_SERVER_URL || ""),
    secret: takeEngineSecret(),
  })();
}
