// Shared by the Harness engine plugins that call back into the local server.

const SECRET_SLOT = Symbol.for("harness.engineSecret");

/**
 * Move the per-launch secret out of the environment on first load. The
 * engine hands its environment to every shell command and MCP server it
 * starts; with the secret gone from it, an agent's shell cannot call the
 * server's engine routes. The process-wide slot survives plugin reloads and
 * is shared by every plugin that needs the secret.
 */
export function takeEngineSecret(): string {
  const fromEnv = process.env.HARNESS_ENGINE_SECRET;
  if (fromEnv) {
    Reflect.set(globalThis, SECRET_SLOT, fromEnv);
    delete process.env.HARNESS_ENGINE_SECRET;
  }
  const held: unknown = Reflect.get(globalThis, SECRET_SLOT);
  return typeof held === "string" ? held : "";
}
