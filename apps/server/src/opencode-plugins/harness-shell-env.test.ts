import { describe, expect, test } from "bun:test";

import * as entry from "./harness-shell-env.js";
import { SHELL_HIDDEN_ENV_NAMES, createShellEnvPlugin, hideCredentialsFromShell } from "./harness-shell-env-core.js";

describe("harness-shell-env plugin", () => {
  test("exports only the default plugin function", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
  });

  test("empties every Harness credential and keeps what the hook was given", async () => {
    const hooks = await createShellEnvPlugin()();
    const output = { env: { KEEP_ME: "1" } as Record<string, string> };
    await hooks["shell.env"]({ cwd: "/work" }, output);
    for (const name of SHELL_HIDDEN_ENV_NAMES) expect(output.env[name]).toBe("");
    expect(output.env.KEEP_ME).toBe("1");
  });

  test("works when the engine passes no env object", () => {
    const output: { env?: Record<string, string> } = {};
    hideCredentialsFromShell(output);
    expect(output.env?.OPENCODE_SERVER_PASSWORD).toBe("");
  });

  test("covers the credentials the engine actually holds", () => {
    for (const name of ["HARNESS_SERVER_TOKEN", "OPENCODE_SERVER_PASSWORD", "HARNESS_ENGINE_SECRET", "OPENCODE_PASSWORD"]) {
      expect(SHELL_HIDDEN_ENV_NAMES).toContain(name);
    }
  });
});
