import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveMainWindowSecurity } from "./main-window-security.mjs";

const dirname = path.join(path.sep, "app", "electron");

describe("resolveMainWindowSecurity", () => {
  it("uses the bundled preload and turns the sandbox on", () => {
    const result = resolveMainWindowSecurity({ dirname, isPackaged: true, exists: (file) => file === path.join(dirname, "preload.cjs") });
    assert.deepEqual(result, { preload: path.join(dirname, "preload.cjs"), sandbox: true });
  });

  it("refuses to run a packaged app without the bundled preload", () => {
    assert.throws(() => resolveMainWindowSecurity({ dirname, isPackaged: true, exists: () => false }), /missing electron\/preload\.cjs/);
  });

  it("lets an unbuilt development checkout fall back, loudly", () => {
    const result = resolveMainWindowSecurity({ dirname, isPackaged: false, exists: () => false });
    assert.equal(result.sandbox, false);
    assert.equal(result.preload, path.join(dirname, "preload.mjs"));
    assert.match(result.warning ?? "", /WITHOUT the renderer sandbox/);
  });
});
