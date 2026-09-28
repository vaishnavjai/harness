import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OFFLINE_NPMRC, engineGlobalConfigDir, keepConfigDirInstallsLocal } from "./engine-npm-local.js";
import { ensureWorkspaceFiles } from "./workspace-init.js";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "harness-npmrc-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

describe("engine config folders stay off the npm registry", () => {
  test("writes an offline .npmrc and never replaces one that exists", async () => {
    const dir = join(await tempRoot(), ".opencode");
    expect(await keepConfigDirInstallsLocal(dir)).toBe(true);
    expect(await readFile(join(dir, ".npmrc"), "utf8")).toBe(OFFLINE_NPMRC);
    expect(OFFLINE_NPMRC).toContain("offline=true");
    await writeFile(join(dir, ".npmrc"), "registry=https://npm.example.test/\n");
    expect(await keepConfigDirInstallsLocal(dir)).toBe(false);
    expect(await readFile(join(dir, ".npmrc"), "utf8")).toBe("registry=https://npm.example.test/\n");
  });

  test("leaves a global folder the person manages themselves alone", async () => {
    const dir = join(await tempRoot(), "opencode");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), "{\"dependencies\":{}}");
    expect(await keepConfigDirInstallsLocal(dir, { onlyIfUnmanaged: true })).toBe(false);
    await expect(readFile(join(dir, ".npmrc"), "utf8")).rejects.toThrow();
  });

  test("finds OpenCode's global config folder the way the engine does", () => {
    expect(engineGlobalConfigDir({ HOME: "/home/a" })).toBe(join("/home/a", ".config", "opencode"));
    expect(engineGlobalConfigDir({ HOME: "/home/a", XDG_CONFIG_HOME: "/x" })).toBe(join("/x", "opencode"));
  });

  test("workspace setup protects the workspace's .opencode folder", async () => {
    const workspace = await tempRoot();
    await ensureWorkspaceFiles(workspace, "starter");
    expect(await readFile(join(workspace, ".opencode", ".npmrc"), "utf8")).toBe(OFFLINE_NPMRC);
  });
});
