import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pickInstalledPython } from "./staged-python.mjs";

test("the real install is chosen, never the minor-version link that sorts before it", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-staged-python-"));
  try {
    mkdirSync(join(dir, "cpython-3.11.14-windows-x86_64-none"));
    // A junction on Windows, a symlink elsewhere; both report as links, not folders.
    symlinkSync(join(dir, "cpython-3.11.14-windows-x86_64-none"), join(dir, "cpython-3.11-windows-x86_64-none"), "junction");
    mkdirSync(join(dir, ".lock-not-a-python"));
    assert.equal(pickInstalledPython(dir), "cpython-3.11.14-windows-x86_64-none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports nothing when uv installed no Python", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-staged-python-"));
  try {
    assert.equal(pickInstalledPython(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
