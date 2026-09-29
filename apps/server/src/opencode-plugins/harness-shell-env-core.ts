// Helpers for the harness-shell-env engine plugin. Kept out of the plugin
// entry because OpenCode calls every function a plugin module exports.

/**
 * Credentials the engine process holds for Harness's own use. A command the
 * agent runs is a child of that process and would inherit them, and with
 * them could call the engine's or the server's APIs as if it were the app
 * (which can hand back provider keys). Shells get these emptied.
 */
export const SHELL_HIDDEN_ENV_NAMES: readonly string[] = [
  "HARNESS_SERVER_TOKEN",
  "HARNESS_HOST_TOKEN",
  "HARNESS_TOKEN",
  "HARNESS_POLICY_TOKEN",
  "HARNESS_ENGINE_SECRET",
  "HARNESS_ENCRYPTION_KEY",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_PASSWORD",
];

/** The engine merges this hook's env over its own for shells and terminals, so an empty value hides the variable. */
export function hideCredentialsFromShell(output: { env?: Record<string, string> }): void {
  output.env ??= {};
  for (const name of SHELL_HIDDEN_ENV_NAMES) output.env[name] = "";
}

export function createShellEnvPlugin() {
  return async () => ({
    "shell.env": async (_input: unknown, output: { env?: Record<string, string> }) => {
      hideCredentialsFromShell(output);
    },
  });
}
