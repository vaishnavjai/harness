import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWithinRoot } from "./paths.js";

const roots: string[] = [];

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "harness-paths-"));
  roots.push(base);
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "secret");
  return { root, outside };
}

afterEach(async () => {
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

describe("resolveWithinRoot", () => {
  test("accepts paths inside the workspace, existing or new", async () => {
    const { root } = await fixture();
    expect(await resolveWithinRoot(root, "src")).toEndWith(join("workspace", "src"));
    expect(await resolveWithinRoot(root, "src", "new", "file.ts")).toEndWith(join("src", "new", "file.ts"));
    expect(await resolveWithinRoot(root)).toEndWith("workspace");
  });

  test("rejects .. and absolute escapes", async () => {
    const { root, outside } = await fixture();
    await expect(resolveWithinRoot(root, "..", "outside", "secret.txt")).rejects.toThrow("Path escapes workspace root");
    await expect(resolveWithinRoot(root, "src/../../outside")).rejects.toThrow("Path escapes workspace root");
    await expect(resolveWithinRoot(root, join(outside, "secret.txt"))).rejects.toThrow("Path escapes workspace root");
    await expect(resolveWithinRoot(root, "../workspace-sibling")).rejects.toThrow("Path escapes workspace root");
  });

  test.skipIf(process.platform === "win32")("rejects symlinks that lead outside, including files not created yet", async () => {
    const { root, outside } = await fixture();
    await symlink(outside, join(root, "link"));
    await symlink(join(outside, "secret.txt"), join(root, "secret-link"));
    await expect(resolveWithinRoot(root, "link", "secret.txt")).rejects.toThrow("Path escapes workspace root");
    await expect(resolveWithinRoot(root, "secret-link")).rejects.toThrow("Path escapes workspace root");
    // The case the old check missed: the file does not exist yet, so only the
    // symlinked parent reveals that a write would land outside.
    await expect(resolveWithinRoot(root, "link", "new-file.txt")).rejects.toThrow("Path escapes workspace root");
    await expect(resolveWithinRoot(root, "link", "deeper", "new-file.txt")).rejects.toThrow("Path escapes workspace root");
  });

  test.skipIf(process.platform === "win32")("allows symlinks that stay inside the workspace", async () => {
    const { root } = await fixture();
    await symlink(join(root, "src"), join(root, "src-link"));
    expect(await resolveWithinRoot(root, "src-link", "new.ts")).toEndWith(join("src-link", "new.ts"));
  });
});
