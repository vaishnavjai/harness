import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const TOKEN = "hwt_files_symlink_client";
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

async function boot() {
  const base = await mkdtemp(join(tmpdir(), "harness-files-symlink-"));
  roots.push(base);
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.md"), "OUTSIDE_SECRET");
  await writeFile(join(workspace, "notes.md"), "inside");
  await symlink(outside, join(workspace, "linkdir"));
  await symlink(join(outside, "planted.md"), join(workspace, "dangling.md"));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(base, "server.json"),
    token: TOKEN,
    hostToken: "hwt_files_symlink_host",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspace, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspace],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  const url = `http://127.0.0.1:${server.port}/workspace/ws_1/files`;
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  return { url, headers, workspace, outside };
}

describe.skipIf(process.platform === "win32")("workspace file API and symbolic links", () => {
  test("reads inside the workspace but never through a link that leads outside", async () => {
    const { url, headers } = await boot();
    const inside = await fetch(`${url}/content?path=notes.md`, { headers });
    expect(inside.status).toBe(200);

    const escaped = await fetch(`${url}/content?path=${encodeURIComponent("linkdir/secret.md")}`, { headers });
    expect(escaped.status).toBe(400);
    expect(await escaped.text()).not.toContain("OUTSIDE_SECRET");
  });

  test("never writes through a symlinked folder or a dangling link", async () => {
    const { url, headers, outside } = await boot();
    const throughFolder = await fetch(`${url}/content`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "linkdir/new.md", content: "pwned", force: true }),
    });
    expect(throughFolder.status).toBe(400);
    await expect(readFile(join(outside, "new.md"), "utf8")).rejects.toThrow();

    const throughDangling = await fetch(`${url}/content`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "dangling.md", content: "pwned", force: true }),
    });
    expect(throughDangling.status).toBe(400);
    await expect(readFile(join(outside, "planted.md"), "utf8")).rejects.toThrow();
  });

  test("file-session operations cannot delete or move things outside through a link", async () => {
    const { url, headers, outside } = await boot();
    const session = await fetch(`${url}/sessions`, { method: "POST", headers, body: JSON.stringify({ write: true }) });
    expect(session.status).toBeLessThan(300);
    const { session: created } = (await session.json()) as { session: { id: string } };
    const opsUrl = url.replace(/\/workspace\/ws_1\/files$/, `/files/sessions/${created.id}/ops`);
    const response = await fetch(opsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ operations: [{ type: "delete", path: "linkdir/secret.md" }] }),
    });
    expect(response.status).toBe(400);
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("OUTSIDE_SECRET");
  });
});
