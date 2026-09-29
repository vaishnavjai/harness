import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { buildAppCsp, inlineScriptHashes, installAppCsp } from "./content-security-policy.mjs";

const sha = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

describe("inlineScriptHashes", () => {
  it("hashes every inline script exactly as written, and skips external and empty ones", () => {
    const html = `<html><head><script>window.a = 1;</script><script type="module" crossorigin src="./x.js"></script>
      <script type="module">import "./y.js";</script><script>   </script></head></html>`;
    assert.deepEqual(inlineScriptHashes(html), [sha("window.a = 1;"), sha('import "./y.js";')]);
  });

  it("returns nothing for a page with no inline scripts", () => {
    assert.deepEqual(inlineScriptHashes('<script src="./a.js"></script>'), []);
  });
});

describe("buildAppCsp", () => {
  const policy = buildAppCsp({ scriptHashes: [sha("x")] });
  const directive = (name) => policy.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";

  it("allows only the app's own scripts, plus the hashed inline ones", () => {
    assert.equal(directive("script-src"), `script-src 'self' 'wasm-unsafe-eval' ${sha("x")}`);
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
    assert.doesNotMatch(policy, /'unsafe-eval'/);
  });

  it("locks plugins, workers, frames, base URL and forms to the app", () => {
    assert.match(directive("object-src"), /^object-src 'self' blob: data:$/);
    assert.match(directive("base-uri"), /'self'$/);
    assert.match(directive("form-action"), /'self'$/);
    assert.doesNotMatch(directive("frame-src"), /https:/);
    assert.match(policy, /^default-src 'self'/);
  });
});

describe("installAppCsp", () => {
  const indexPath = path.join(path.sep, "opt", "Harness", "resources", "app-dist", "index.html");
  const appUrl = pathToFileURL(indexPath).href;

  async function install(mode) {
    let listener;
    const session = { webRequest: { onHeadersReceived: (fn) => { listener = fn; } } };
    const info = await installAppCsp(session, { indexPath, mode, readFile: async () => "<script>boot();</script>", platform: "linux" });
    const respond = (details) => new Promise((resolve) => listener(details, resolve));
    return { info, respond };
  }

  it("sets the policy on the app document and replaces any existing one", async () => {
    const { info, respond } = await install();
    const { responseHeaders } = await respond({ resourceType: "mainFrame", url: appUrl, responseHeaders: { "content-security-policy": ["default-src *"], Other: ["1"] } });
    assert.deepEqual(responseHeaders["Content-Security-Policy"], [info.policy]);
    assert.equal(responseHeaders["content-security-policy"], undefined);
    assert.deepEqual(responseHeaders.Other, ["1"]);
    assert.match(info.policy, new RegExp(sha("boot();").replace(/[$()*+?.[\]\\^|]/g, "\\$&")));
  });

  it("leaves other documents and subresources alone", async () => {
    const { respond } = await install();
    for (const details of [
      { resourceType: "mainFrame", url: "https://example.com/" },
      { resourceType: "script", url: pathToFileURL(path.join(path.dirname(indexPath), "assets", "app.js")).href },
      { resourceType: "mainFrame", url: pathToFileURL(path.join(path.sep, "other", "index.html")).href },
    ]) {
      const { responseHeaders } = await respond({ ...details, responseHeaders: {} });
      assert.deepEqual(Object.keys(responseHeaders), []);
    }
  });

  it("can report instead of block, for finding breakage on other machines", async () => {
    const { info, respond } = await install("report-only");
    assert.equal(info.headerName, "Content-Security-Policy-Report-Only");
    const { responseHeaders } = await respond({ resourceType: "mainFrame", url: appUrl, responseHeaders: {} });
    assert.ok(responseHeaders["Content-Security-Policy-Report-Only"]);
    assert.equal(responseHeaders["Content-Security-Policy"], undefined);
  });
});
