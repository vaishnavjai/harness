import assert from "node:assert/strict";
import test from "node:test";
import { Freestyle } from "freestyle";
import { deletePreview, findSnapshot, launchPreview, snapshotSlug, waitForPublicAccess } from "../src/index.ts";
import { ensureSnapshot } from "../src/builder.ts";

const sha = "a".repeat(40);
function mockApi(snapshotCreatedAt = new Date().toISOString(), files: Record<string, string> = {}) {
  const creates: Record<string, unknown>[] = [];
  const writes: string[] = [];
  const writesByVm = new Map<string, string[]>();
  const createsByVm = new Map<string, Record<string, unknown>>();
  const deleted: string[] = [];
  const commands: string[] = [];
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/v5/snapshots/")) return Response.json({ id: "sh-template", slug: snapshotSlug(sha), createdAt: snapshotCreatedAt });
    if (path === "/v5/vms" && init?.method === "POST") {
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
      const creation = Object.fromEntries(Object.entries(body));
      creates.push(creation);
      const id = `vm-${creates.length}`;
      createsByVm.set(id, creation);
      return Response.json({ id, createdAt: new Date().toISOString() });
    }
    const guestPath = new URL(String(input)).searchParams.get("path") ?? "";
    const file = Object.entries(files).find(([name]) => guestPath.endsWith(`/${name}`));
    if (path.includes("/fs/") && file && (init?.method ?? "GET") === "GET") return new Response(file[1]);
    if (path.includes("/fs/")) {
      const body = await new Response(init?.body).text();
      writes.push(body);
      const vmId = path.split("/")[3];
      writesByVm.set(vmId, [...(writesByVm.get(vmId) ?? []), body]);
      return Response.json({});
    }
    if (path.endsWith("/exec-await")) { commands.push(String(init?.body)); return Response.json({ statusCode: 0, stdout: "" }); }
    if (init?.method === "DELETE") { deleted.push(path); return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected provider request ${init?.method} ${path}`);
  } });
  return { api, creates, writes, createsByVm, writesByVm, deleted, commands };
}

const reachable: typeof fetch = async (input) => new URL(String(input)).pathname === "/__harness_launch"
  ? new Response(null, { status: 303, headers: { "set-cookie": "__Host-harness-preview=synthetic" } })
  : new Response("<title>Harness</title>", { status: 200 });

test("concurrent launches from one report get separate VMs, credentials and provider expiry", async () => {
  const { api, creates, writes } = mockApi();
  const [first, second] = await Promise.all([
    launchPreview({ gitSha: sha, reportId: "b".repeat(32) }, api, reachable),
    launchPreview({ gitSha: sha, reportId: "b".repeat(32) }, api, reachable),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.url, second.url);
  assert.notEqual(new URL(first.url).searchParams.get("token"), new URL(second.url).searchParams.get("token"));
  assert.equal(first.snapshotId, second.snapshotId);
  assert.ok(new URL(first.url).hostname.endsWith(".preview.harness-legacy.invalid"));
  assert.equal(creates.length, 2);
  for (const body of creates) {
    assert.equal(body.snapshotId, "sh-template");
    assert.equal(body.ttlSeconds, 7200);
    assert.ok(body.tls); // Domain lifetime is bound to its VM.
  }
  assert.equal(writes.length, 2);
});

test("failed public readiness cleans up the newly allocated VM", async () => {
  const { api, deleted } = mockApi();
  await assert.rejects(launchPreview({ gitSha: sha }, api, async () => new Response(null, { status: 401 })), /could not be reached/);
  assert.deepEqual(deleted, ["/v5/vms/vm-1"]);
});

test("new public routes can recover from propagation errors without allocating another VM", async () => {
  const { api, creates, deleted } = mockApi();
  let attempts = 0;
  await launchPreview({ gitSha: sha }, api, async (input) => {
    attempts++;
    if (attempts === 1) return new Response(null, { status: 502 });
    return reachable(input);
  });
  assert.equal(attempts, 3);
  assert.equal(creates.length, 1);
  assert.deepEqual(deleted, []);
});

test("launch waits through the restored app's first transient 502", async () => {
  const { api, creates } = mockApi();
  let pageRequests = 0;
  await launchPreview({ gitSha: sha }, api, async (input) => {
    if (new URL(String(input)).pathname === "/") {
      pageRequests++;
      if (pageRequests === 1) return new Response("starting", { status: 502 });
    }
    return reachable(input);
  });
  assert.equal(pageRequests, 2);
  assert.equal(creates.length, 1);
});

test("app-web clones never run guest commands, even from old snapshots, and link only the app", async () => {
  for (const createdAt of [new Date().toISOString(), new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString()]) {
    const provider = mockApi(createdAt);
    const session = await launchPreview({ gitSha: sha, world: "app-web" }, provider.api, reachable);
    assert.deepEqual(provider.commands, []);
    assert.deepEqual(session.outputs, {});
    assert.match(new URL(session.url).hostname, /^ow-[a-f0-9]{32}\.preview\.harness-legacy\.invalid$/);
    const tls = provider.creates[0].tls;
    assert.ok(typeof tls === "object" && tls !== null && "rules" in tls && Array.isArray(tls.rules));
    assert.deepEqual(tls.rules.map((rule: unknown) => typeof rule === "object" && rule !== null && "domain" in rule ? rule.domain : null), [new URL(session.url).hostname]);
  }
});

test("public readiness retries are bounded and do not conceal denied access", async () => {
  let attempts = 0;
  await assert.rejects(waitForPublicAccess("https://unused.example", async () => {
    attempts++;
    throw new TypeError("fetch failed");
  }, async () => undefined), /Public sandbox readiness failed/);
  assert.equal(attempts, 8);
  attempts = 0;
  await assert.rejects(waitForPublicAccess("https://unused.example", async () => {
    attempts++;
    return new Response(null, { status: 401 });
  }, async () => undefined), /HTTP 401/);
  assert.equal(attempts, 1);
});

test("unknown snapshots and invalid revisions never allocate VMs", async () => {
  let calls = 0;
  const api = new Freestyle({ apiKey: "synthetic", fetch: async () => {
    calls += 1;
    return Response.json({ code: "NOT_FOUND", message: "Missing" }, { status: 404 });
  } });
  assert.throws(() => snapshotSlug("dev; echo nope"), /full pushed/);
  assert.equal(await findSnapshot(sha, api), null);
  await assert.rejects(launchPreview({ gitSha: sha }, api, reachable), /no Freestyle snapshot/);
  assert.equal(calls, 2);
});

test("cleanup refuses unrelated VMs", async () => {
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (_url, init) => {
    assert.notEqual(init?.method, "DELETE");
    return Response.json({ id: "vm-unrelated", metadata: {} });
  } });
  await assert.rejects(deletePreview("vm-unrelated", api), /not owned/);
});

test("provider capacity conflicts do not masquerade as an in-progress snapshot", async () => {
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (_url, init) => {
    if (init?.method === "POST") return Response.json({ code: "CONFLICT", message: "No capacity" }, { status: 409 });
    return Response.json({ code: "NOT_FOUND", message: "Missing" }, { status: 404 });
  } });
  await assert.rejects(ensureSnapshot(sha, api, undefined, "app-web", {
    sourceFetch: async () => Response.json({ truncated: false, tree: [{ path: "pnpm-lock.yaml", sha, type: "blob" }] }),
  }), /No capacity/);
});

test("desktop templates use their own runtime and refresh an exact frontend-only revision without world services", async () => {
  const snapshots = new Map<string, { id: string; slug: string; createdAt: string }>();
  const writes: { path: string; text: string }[] = [];
  const creates: { snapshotId: string }[] = [];
  let count = 0;
  const api = new Freestyle({ apiKey: "synthetic", fetch: async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.startsWith("/v5/snapshots/")) {
      const saved = snapshots.get(path.split("/").pop() ?? "");
      return saved ? Response.json(saved) : Response.json({ code: "NOT_FOUND" }, { status: 404 });
    }
    if (path === "/v5/vms" && init?.method === "POST") {
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(body && typeof body === "object" && "snapshotId" in body && typeof body.snapshotId === "string");
      creates.push({ snapshotId: body.snapshotId });
      return Response.json({ id: `builder-${creates.length}` });
    }
    if (path.endsWith("/fs/write")) {
      writes.push({ path: url.searchParams.get("path") ?? "", text: await new Response(init?.body).text() });
      return Response.json({});
    }
    if (path.endsWith("/fs/exists")) return Response.json({ exists: url.searchParams.get("path")?.endsWith(".ready") });
    if (path.endsWith("/fs/read")) {
      assert.ok(url.searchParams.get("path")?.endsWith("build-stages.jsonl"));
      return new Response(JSON.stringify({ stage: "boot-and-verify", durationMs: 1 }));
    }
    if (path.endsWith("/exec-await")) return Response.json({ statusCode: 0, stdout: "" });
    if (path.endsWith("/snapshot")) {
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(body && typeof body === "object" && "slug" in body && typeof body.slug === "string");
      const snapshot = { id: `snapshot-${++count}`, slug: body.slug, createdAt: new Date().toISOString() };
      snapshots.set(body.slug, snapshot);
      return Response.json({ snapshotId: snapshot.id, snapshot });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error("Unexpected mocked builder operation");
  } });
  const source = (revision: string) => async () => Response.json({ truncated: false, tree: [
    { path: "pnpm-lock.yaml", sha, type: "blob" },
    { path: "apps/app/src/main.tsx", sha: revision, type: "blob" },
  ] });
  const first = await ensureSnapshot(sha, api, undefined, "desktop", { sourceFetch: source(sha) });
  assert.equal(creates.length, 5);
  assert.ok([...snapshots.keys()].every((slug) => slug.includes("-desktop-")));
  const text = (name: string) => writes.find((item) => item.path === `/opt/harness-preview/${name}`)?.text ?? "";
  assert.match(text("runtime.mjs"), /bootDesktopOnly/);
  assert.doesNotMatch(text("runtime.mjs"), /bootAcme|signIn|bootstrap|modelId/);
  assert.match(text("health.mjs"), /inspectDesktop/);
  assert.doesNotMatch(text("health.mjs"), /services\.engine|resume\.mjs/);
  assert.match(text("refresh.mjs"), /refreshDesktop/);
  assert.doesNotMatch(text("refresh.mjs"), /services\.app|resume\.mjs|signInDesktopAs/);
  assert.match(text("desktop-state.mjs"), /firstRun/);
  const secondSha = "b".repeat(40);
  const second = await ensureSnapshot(secondSha, api, undefined, "desktop", { sourceFetch: source(secondSha) });
  assert.notEqual(first.id, second.id);
  assert.equal(creates.length, 6, "frontend-only commits reuse the running desktop template");
  const refresh = writes.filter((item) => item.path.endsWith("/refresh.sh")).at(-1)?.text ?? "";
  assert.ok(refresh.includes(`git fetch --depth=1 origin ${secondSha}`));
  assert.ok(refresh.includes(`node /opt/harness-preview/refresh.mjs ${secondSha}`));
  assert.doesNotMatch(refresh, /resume\.mjs|health\.mjs|git clean/);
});

test("an existing immutable snapshot is reused without creating a builder", async () => {
  const { api, creates } = mockApi();
  assert.equal((await ensureSnapshot(sha, api)).id, "sh-template");
  assert.equal(creates.length, 0);
});

test("snapshot identity separates worlds and rejects unknown recipes", async () => {
  const { previewWorld } = await import("../src/index.ts");
  assert.notEqual(snapshotSlug(sha, "app-web"), snapshotSlug(sha, "desktop"));
  for (const retired of ["arbitrary-command", "acme-web"]) assert.throws(() => previewWorld(retired), /Unsupported/);
});

test("world outputs accept disposable credentials but reject malformed values", async () => {
  const { parsePreviewOutputs } = await import("../src/outputs.ts");
  assert.deepEqual(parsePreviewOutputs({ password: { value: "synthetic", secret: true, group: "Accounts" } }), {
    password: { value: "synthetic", secret: true, group: "Accounts" },
  });
  assert.throws(() => parsePreviewOutputs({ password: { value: {}, secret: true } }), /Invalid/);
  assert.throws(() => parsePreviewOutputs({ password: { value: "synthetic", secret: "false" } }), /Invalid/);
});

const desktopFiles = {
  "source-sha": sha,
  "status": "ready-signed-out",
  "outputs.json": JSON.stringify({ desktopStatus: { value: "ready-signed-out", group: "Desktop" } }),
};
const desktopReachable: typeof fetch = async (input) => new URL(String(input)).pathname === "/vnc.html"
  ? new Response("<title>noVNC</title>") : reachable(input);

test("the review page accepts every service link a desktop launch returns", async () => {
  const { parsePreviewOutputs } = await import("../src/outputs.ts");
  const ready = mockApi(undefined, desktopFiles);
  const session = await launchPreview({ gitSha: sha, world: "desktop" }, ready.api, desktopReachable);
  // The browser re-validates the launch response; a rejected link hides a working sandbox.
  const parsed = parsePreviewOutputs(JSON.parse(JSON.stringify(session.outputs)));
  assert.ok(parsed.desktopUrl, "the desktop viewer link must survive client validation");
  assert.throws(() => parsePreviewOutputs({ desktopUrl: { value: "https://evil.example/__harness_launch?token=x", group: "Services" } }), /Invalid private service link/);
});

test("desktop clones use only their viewer, isolated access and exact source even for old snapshots", async () => {
  const provider = mockApi("2020-01-01T00:00:00Z", desktopFiles);
  const [first, second] = await Promise.all([
    launchPreview({ gitSha: sha, world: "desktop", lifetimeMinutes: 10 }, provider.api, desktopReachable),
    launchPreview({ gitSha: sha, world: "desktop", lifetimeMinutes: 10 }, provider.api, desktopReachable),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.url, second.url);
  assert.notEqual(first.outputs.previewCookie.value, second.outputs.previewCookie.value);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(first.url, first.outputs.desktopUrl.value);
  assert.deepEqual(Object.keys(first.outputs).sort(), ["desktopStatus", "desktopUrl", "previewCookie"]);
  assert.deepEqual(provider.commands, []);
  for (const session of [first, second]) {
    const domain = new URL(session.url).hostname;
    assert.match(domain, /^desktop-[a-f0-9]{32}\.preview\.harness-legacy\.invalid$/);
    // Concurrent file uploads can complete in either order. Match receipts to
    // their VM, never to the index at which a response body finished reading.
    const creation = provider.createsByVm.get(session.id);
    const writes = provider.writesByVm.get(session.id);
    assert.ok(creation);
    assert.ok(writes && writes.length === 1);
    assert.equal(creation.ttlSeconds, 600);
    assert.deepEqual(creation.tls, { rules: [{ action: "allow", domain, source: { public: true }, destination: { port: 8080 } }] });
    const access = JSON.parse(writes[0]);
    assert.deepEqual(access.origins, { desktop: `https://${domain}` });
    assert.equal(access.templateOrigins, undefined);
    assert.equal(access.expiresAt, session.expiresAt);
  }
  assert.notEqual(snapshotSlug(sha, "desktop"), snapshotSlug(sha, "app-web"));
});

for (const files of [
  { ...desktopFiles, "source-sha": "b".repeat(40) },
  { ...desktopFiles, "status": "starting" },
  { ...desktopFiles, "outputs.json": JSON.stringify({ webUrl: { value: "unwanted" } }) },
]) {
  test("invalid desktop snapshot fails closed and deletes its clone", async () => {
    const provider = mockApi(undefined, files);
    await assert.rejects(launchPreview({ gitSha: sha, world: "desktop" }, provider.api, desktopReachable), /could not be reached/);
    assert.deepEqual(provider.deleted, ["/v5/vms/vm-1"]);
    assert.deepEqual(provider.commands, []);
  });
}

test("desktop viewer readiness failure cleans up and does not accept web HTML", async () => {
  const provider = mockApi(undefined, desktopFiles);
  await assert.rejects(launchPreview({ gitSha: sha, world: "desktop" }, provider.api, async () => new Response(null, { status: 401 })), /could not be reached/);
  assert.deepEqual(provider.deleted, ["/v5/vms/vm-1"]);
  await assert.rejects(waitForPublicAccess("https://unused.example", reachable, async () => undefined, "desktop"), /Public sandbox readiness failed/);
});
