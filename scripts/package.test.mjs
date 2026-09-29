import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REMOVED_RUNTIME_PACKAGES } from "./hindsight/runtime-policy.mjs";
import { checkToolchain, findUnpackedApp, requiredArtifactPaths, runtimeIsCurrent, shippedTestFiles } from "./package.mjs";

test("the toolchain check names every missing tool with how to get it", () => {
  const problems = checkToolchain((command) => (command === "pnpm" ? "11.0.0" : null));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /bun is required/);
  assert.match(problems[1], /uv is required/);
  assert.deepEqual(checkToolchain(() => "1.0.0"), []);
});

test("a runtime is reused only when built from the same lockfile for this platform", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-runtime-"));
  try {
    const lock = Buffer.from("pkg==1.0 --hash=sha256:abc\n");
    const digest = createHash("sha256").update(lock).digest("hex");
    const removedPackages = [...REMOVED_RUNTIME_PACKAGES];
    assert.equal(runtimeIsCurrent(dir, lock), false);
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ kind: "bundled", platform: "linux", arch: "x64", lockfileSha256: digest, removedPackages }));
    assert.equal(runtimeIsCurrent(dir, lock, "linux", "x64"), true);
    assert.equal(runtimeIsCurrent(dir, lock, "darwin", "arm64"), false);
    assert.equal(runtimeIsCurrent(dir, Buffer.from("pkg==2.0\n"), "linux", "x64"), false);
    writeFileSync(join(dir, ".partial"), "");
    assert.equal(runtimeIsCurrent(dir, lock, "linux", "x64"), false);
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ kind: "development-venv", platform: "linux", arch: "x64", lockfileSha256: digest, removedPackages }));
    assert.equal(runtimeIsCurrent(dir, lock, "linux", "x64"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runtime built before the telemetry SDKs were removed is rebuilt", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-runtime-"));
  try {
    const lock = Buffer.from("pkg==1.0 --hash=sha256:abc\n");
    const base = { kind: "bundled", platform: "linux", arch: "x64", lockfileSha256: createHash("sha256").update(lock).digest("hex") };
    assert.ok(REMOVED_RUNTIME_PACKAGES.includes("sentry-sdk"));
    writeFileSync(join(dir, "runtime.json"), JSON.stringify(base));
    assert.equal(runtimeIsCurrent(dir, lock, "linux", "x64"), false);
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ ...base, removedPackages: ["fastapi-cloud-cli"] }));
    assert.equal(runtimeIsCurrent(dir, lock, "linux", "x64"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finds the unpacked app for each platform layout", () => {
  const out = mkdtempSync(join(tmpdir(), "harness-dist-"));
  try {
    assert.equal(findUnpackedApp(join(out, "missing")), null);
    mkdirSync(join(out, "linux-unpacked", "resources"), { recursive: true });
    assert.deepEqual(findUnpackedApp(out, "linux"), { root: join(out, "linux-unpacked"), resources: join(out, "linux-unpacked", "resources") });
    mkdirSync(join(out, "mac-arm64", "Harness.app", "Contents", "Resources"), { recursive: true });
    assert.deepEqual(findUnpackedApp(out, "darwin"), {
      root: join(out, "mac-arm64", "Harness.app"),
      resources: join(out, "mac-arm64", "Harness.app", "Contents", "Resources"),
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a runnable build must carry the engine, the memory runtime and the licenses", () => {
  const linux = requiredArtifactPaths("linux");
  assert.ok(linux.includes(join("sidecars", "opencode")));
  assert.ok(linux.includes(join("hindsight-runtime", "python", "bin", "python3")));
  assert.ok(linux.includes(join("licenses", "THIRD_PARTY_LICENSES.txt")));
  const windows = requiredArtifactPaths("win32");
  assert.ok(windows.includes(join("sidecars", "opencode.exe")));
  assert.ok(windows.includes(join("hindsight-runtime", "python", "python.exe")));
});

test("a build must carry the audit, provider-key and memory engine plugins and ship no tests", () => {
  const linux = requiredArtifactPaths("linux");
  for (const plugin of ["harness-audit.js", "harness-provider-keys.js", "harness-memory.js", "harness-shell-env.js"]) {
    assert.ok(linux.includes(join("opencode-plugins", plugin)), plugin);
  }
  const resources = mkdtempSync(join(tmpdir(), "harness-resources-"));
  try {
    assert.deepEqual(shippedTestFiles(resources), []);
    mkdirSync(join(resources, "opencode-plugins"));
    writeFileSync(join(resources, "opencode-plugins", "harness-memory.js"), "");
    writeFileSync(join(resources, "opencode-plugins", "harness-memory.test.js"), "");
    assert.deepEqual(shippedTestFiles(resources), [join("opencode-plugins", "harness-memory.test.js")]);
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});
