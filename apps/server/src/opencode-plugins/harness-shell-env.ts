// Keeps Harness's own credentials out of every shell and terminal the agent
// starts. The engine process needs them (its server password, the server
// token its plugins use); a command it runs must not.

import { createShellEnvPlugin } from "./harness-shell-env-core.js";

export default async function harnessShellEnv() {
  return createShellEnvPlugin()();
}
