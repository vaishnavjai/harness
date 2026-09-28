import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedRuntimeEnvironment, parseRemoteRuntime } from "../src/app-web-runtime.ts";
import { bootAppWebWorld } from "../../../../worlds/app-web.ts";

test("seed app-web runtime remains isolated and Cloud-off", () => {
  const env = isolatedRuntimeEnvironment("/tmp/owned-fixture");
  assert.equal(env.HARNESS_DEV_HEADLESS_WEB_DEN_PROXY, "0");
  assert.equal(env.VITE_DISABLE_HARNESS_MODELS, "1");
  assert.equal(env.HARNESS_REMOTE_ACCESS, "0");
  assert.equal(env.VITE_HOST, "127.0.0.1");
  assert.equal(env.HOME, "/tmp/owned-fixture/home");
  assert.equal(env.HARNESS_VITE_CACHE_DIR, "/tmp/owned-fixture/cache/vite");
  assert.equal(env.HARNESS_TOKEN, undefined);
  assert.equal(env.HARNESS_HOST_TOKEN, undefined);
});

test("remote runtime receipts preserve loopback identity and never expose malformed output", () => {
  const receipt = { webUrl: "http://127.0.0.1:5178", harnessUrl: "http://127.0.0.1:8778", runtimeManifestPath: "/workspace/tmp/worlds/runtime/app-web/runtime.json" };
  assert.deepEqual(parseRemoteRuntime(JSON.stringify(receipt)), receipt);
  assert.throws(() => parseRemoteRuntime(JSON.stringify({ ...receipt, webUrl: "https://5178-secret.example.test" })), /loopback/);
  assert.throws(() => parseRemoteRuntime("secret"), (error: unknown) => error instanceof Error && !error.message.includes("secret"));
});

function fakeWorld(failure?: "launch" | "verify" | "source") {
  const calls: string[] = [];
  const ref = "a".repeat(40);
  const source = { requestedRef: ref, expectedSha: ref, actualSha: ref, preparedFingerprint: "b".repeat(64), dependenciesInstalled: true, verifiedAt: "now" };
  const deps: NonNullable<Parameters<typeof bootAppWebWorld>[3]> = {
    local: async () => { throw new Error("unexpected local launch"); },
    localSource: async () => ({ sha: ref, dirty: true }),
    provision: async (options) => {
      assert.equal(options.private, true);
      assert.equal(options.reuse, undefined);
      assert.equal(options.secrets, undefined);
      assert.match(options.name, /^app-web--test-stage-/);
      await options.onCreated?.("owned-name");
      calls.push("provision");
      return { sandbox: "owned-name", created: true, source: failure === "source" ? { ...source, actualSha: "c".repeat(40) } : source };
    },
    privateId: async () => "owned-id",
    track: async (entry) => { assert.equal(entry.id, "owned-id"); calls.push("track"); },
    release: async (id) => { assert.equal(id, "owned-id"); calls.push("delete"); },
    preview: async (_id, _port, _exec, expires) => {
      calls.push("preview");
      assert.equal(expires, 7800);
      return { browserOrigin: "https://5178-private.example.test", unsignedOrigin: "https://5178-owned-id.example.test", browserHostSuffix: ".example.test" };
    },
    verify: async () => { calls.push("verify"); if (failure === "verify") throw new Error("security prerequisite"); },
    remote: async (id, name, workspace, receipt, options) => {
      calls.push("launch");
      assert.equal(id, "owned-id");
      assert.match(name, /^app-web--test-stage-/);
      assert.equal(workspace, "/workspace");
      assert.equal(receipt.actualSha, ref);
      const expectedEnv: NodeJS.ProcessEnv = { HARNESS_WEB_PORT: "5178", VITE_HOST: "0.0.0.0" };
      assert.deepEqual(options, {
        browserHostSuffix: ".example.test",
        env: expectedEnv,
      });
      assert.equal(options?.env?.HARNESS_TOKEN, undefined);
      if (failure === "launch") throw new Error("launch failed");
      return { webUrl: "http://127.0.0.1:5178", harnessUrl: "http://127.0.0.1:8778", fixtureRoot: "/tmp/fixture", runtimeDirectory: "/workspace/tmp/runtime", source,
        stop: async () => { calls.push("stop"); },
      };
    },
  };
  return { deps, calls, ref };
}

const callerEnv = { HARNESS_WORLD_STAGE: "test-stage", HARNESS_TOKEN: "never-transfer" };

test("app-web world composes owned private provisioning, exact source, runtime and secret browser output", async () => {
  const { deps, calls, ref } = fakeWorld();
  const stack = new AsyncDisposableStack();
  const output = await bootAppWebWorld(stack, { place: "daytona", ref }, callerEnv, deps);
  assert.deepEqual(output.webUrl, { value: "https://5178-private.example.test", secret: true });
  assert.equal(output.runtimeWebUrl, "http://127.0.0.1:5178");
  assert.equal(output.sourceSha, ref);
  assert.equal(output.placement, "daytona");
  assert.equal(output.previewExpiresInSeconds, "7800");
  await stack.disposeAsync();
  assert.deepEqual(calls, ["track", "provision", "preview", "launch", "verify", "stop", "delete"]);
});

test("app-web failure cleanup deletes its sandbox after launch, source, or security failure", async () => {
  for (const failure of ["launch", "verify", "source"] satisfies Array<"launch" | "verify" | "source">) {
    const { deps, calls, ref } = fakeWorld(failure);
    await assert.rejects(async () => {
      await using stack = new AsyncDisposableStack();
      await bootAppWebWorld(stack, { place: "daytona", ref }, callerEnv, deps);
    });
    assert.equal(calls.at(-1), "delete");
    assert.equal(calls.filter((call) => call === "delete").length, 1);
    if (failure === "verify") assert(calls.includes("stop"));
    if (failure === "source") assert(!calls.includes("launch"));
  }
});

test("local app-web uses this working tree and owned runtime cleanup without provisioning, never forwarding caller secrets", async () => {
  const { deps, calls, ref } = fakeWorld();
  const fixtureRoot = await mkdtemp(join(tmpdir(), "app-web-world-unit-"));
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "app-web-runtime-unit-"));
  try {
    deps.local = async (name, workspace, options) => {
      assert.match(name, /^app-web--test-stage-/);
      assert.equal(workspace, fileURLToPath(new URL("../../../../", import.meta.url)));
      assert.equal(options, undefined);
      return { webUrl: "http://127.0.0.1:5178", harnessUrl: "http://127.0.0.1:8778", fixtureRoot, runtimeDirectory, source: null,
        stop: async () => { calls.push("stop"); },
      };
    };
    const stack = new AsyncDisposableStack();
    const output = await bootAppWebWorld(stack, { place: "local" }, callerEnv, deps);
    assert.equal(output.sourceSha, ref);
    assert.equal(output.sourceDirty, "true");
    assert.equal(output.sourceKind, "working-tree");
    assert.equal(output.webUrl, "http://127.0.0.1:5178");
    await stack.disposeAsync();
    assert.deepEqual(calls, ["stop"]);
    await assert.rejects(access(fixtureRoot));
    await assert.rejects(access(runtimeDirectory));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
