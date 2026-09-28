import test from "node:test";
import assert from "node:assert/strict";

import path from "node:path";

import { reconcileInjectedUserEnv, resolveUserEnvFilePath } from "./runtime.mjs";

test("resolves the user env store from the effective desktop profile", () => {
  assert.equal(
    resolveUserEnvFilePath({
      HOME: "/Users/example",
      XDG_CONFIG_HOME: "/tmp/harness-dev-profile/config",
    }),
    path.join("/tmp/harness-dev-profile/config", "harness", "env.json"),
  );
});

test("removes a user env key from the long-lived desktop process after deletion", () => {
  const inheritedEnv = { PATH: "/usr/bin" };
  const processEnv = {
    ...inheritedEnv,
    ANTHROPIC_API_KEY: "previously-injected",
  };

  const nextKeys = reconcileInjectedUserEnv({
    processEnv,
    inheritedEnv,
    userEnv: {},
    previouslyInjectedKeys: new Set(["ANTHROPIC_API_KEY"]),
  });

  assert.equal(processEnv.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual([...nextKeys], []);
});

test("restores an inherited value when a user env override is removed", () => {
  const inheritedEnv = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "inherited",
  };
  const processEnv = {
    ...inheritedEnv,
    ANTHROPIC_API_KEY: "user-store-value",
  };

  reconcileInjectedUserEnv({
    processEnv,
    inheritedEnv,
    userEnv: {},
    previouslyInjectedKeys: new Set(["ANTHROPIC_API_KEY"]),
  });

  assert.equal(processEnv.ANTHROPIC_API_KEY, "inherited");
});

test("refreshes an injected user env key when its stored value changes", () => {
  const inheritedEnv = { PATH: "/usr/bin" };
  const processEnv = {
    ...inheritedEnv,
    ANTHROPIC_API_KEY: "old-value",
  };

  reconcileInjectedUserEnv({
    processEnv,
    inheritedEnv,
    userEnv: { ANTHROPIC_API_KEY: "new-value" },
    previouslyInjectedKeys: new Set(["ANTHROPIC_API_KEY"]),
  });

  assert.equal(processEnv.ANTHROPIC_API_KEY, "new-value");
});

test("dev child env reconciliation preserves an inherited OPENCODE_DB override", () => {
  const inheritedEnv = {
    HARNESS_DEV_MODE: "1",
    OPENCODE_DB: "/tmp/installed-production/opencode.db",
  };
  const processEnv = { ...inheritedEnv };

  reconcileInjectedUserEnv({
    processEnv,
    inheritedEnv,
    userEnv: {},
    previouslyInjectedKeys: new Set(),
  });

  assert.equal(processEnv.OPENCODE_DB, "/tmp/installed-production/opencode.db");
});

test("injects variables from the encrypted store the server writes, and nothing without the key", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { randomBytes } = await import("node:crypto");
  const { deriveEnvStoreKey, encryptEnvStore } = await import("@harness/paths/env-store");
  const { loadUserEnvFile } = await import("./runtime.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "harness-user-env-"));
  try {
    const file = path.join(dir, "env.json");
    const root = randomBytes(32);
    await writeFile(file, encryptEnvStore({
      updatedAt: 1,
      variables: [
        { key: "ANTHROPIC_API_KEY", value: "sk-ant", updatedAt: 1 },
        { key: "HARNESS_TOKEN", value: "stolen", updatedAt: 1 },
      ],
    }, deriveEnvStoreKey(root)));
    const env = { HARNESS_ENV_STORE: file };
    assert.deepEqual(await loadUserEnvFile(env, async () => root), { ANTHROPIC_API_KEY: "sk-ant" });
    assert.deepEqual(await loadUserEnvFile(env, undefined), {});
    assert.deepEqual(await loadUserEnvFile(env, async () => randomBytes(32)), {});
    assert.deepEqual(await loadUserEnvFile(env, async () => { throw new Error("keychain locked"); }), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
