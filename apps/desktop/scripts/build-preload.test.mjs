import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildPreload, sandboxProblems } from "./build-preload.mjs";

const bunAvailable = spawnSync(process.platform === "win32" ? "bun.exe" : "bun", ["--version"], { encoding: "utf8" }).status === 0;

describe("sandboxProblems", () => {
  it("accepts a bundle that only requires electron", () => {
    assert.deepEqual(sandboxProblems('var e = require("electron");\nmodule.exports = {};\n'), []);
  });

  it("flags Node modules, ES module syntax and dynamic imports", () => {
    assert.deepEqual(sandboxProblems('require("node:fs")'), ['requires "node:fs"']);
    assert.deepEqual(sandboxProblems('const p = require("path");'), ['requires "path"']);
    assert.ok(sandboxProblems('import { a } from "./x.mjs";\n').some((problem) => problem.includes("ES module")));
    assert.ok(sandboxProblems('export default 1;\n').some((problem) => problem.includes("ES module")));
    assert.ok(sandboxProblems("const u = import.meta.url;").includes("uses import.meta"));
    assert.ok(sandboxProblems('await import("./y.mjs");').includes("uses dynamic import()"));
  });
});

describe("buildPreload", { skip: !bunAvailable && "bun is not installed" }, () => {
  it("bundles the real preload into a single sandbox-safe CommonJS file", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-preload-"));
    try {
      const outfile = join(dir, "preload.cjs");
      const result = buildPreload({ outfile });
      const text = readFileSync(outfile, "utf8");
      assert.equal(result.outfile, outfile);
      assert.ok(result.bytes > 1_000);
      assert.deepEqual(sandboxProblems(text), []);
      // The bridge the renderer depends on is in the bundle, and so is the module it imports.
      assert.match(text, /__HARNESS_ELECTRON__/);
      assert.match(text, /installBrowserShortcutFocusTracking/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
