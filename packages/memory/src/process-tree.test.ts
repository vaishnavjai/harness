import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isProcessAlive, reapEmbeddedPostgres, readPostmasterPid, waitForExit } from "./process-tree.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-reap-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Start a long-lived process whose command name is `name`. */
async function startNamed(dir: string, name: string) {
  const binary = join(dir, name);
  await symlink("/bin/sleep", binary);
  const child = spawn(binary, ["300"], { stdio: "ignore" });
  cleanups.push(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  return child.pid ?? 0;
}

describe.skipIf(process.platform === "win32")("reapEmbeddedPostgres", () => {
  test("stops a postmaster left behind by an engine that died hard", async () => {
    const dir = await tempDir();
    const pid = await startNamed(dir, "postgres");
    await writeFile(join(dir, "postmaster.pid"), `${pid}\n${dir}\n1700000000\n5432\n`);
    expect(await readPostmasterPid(dir)).toBe(pid);
    expect(await reapEmbeddedPostgres(dir)).toBe(true);
    expect(await waitForExit(pid, 2_000)).toBe(true);
  }, 20_000);

  test("never signals a reused PID that is not Postgres", async () => {
    const dir = await tempDir();
    const pid = await startNamed(dir, "unrelated-app");
    await writeFile(join(dir, "postmaster.pid"), `${pid}\n`);
    expect(await reapEmbeddedPostgres(dir)).toBe(false);
    expect(isProcessAlive(pid)).toBe(true);
  });

  test("is a no-op without a postmaster.pid", async () => {
    expect(await reapEmbeddedPostgres(await tempDir())).toBe(false);
  });
});
