import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bundledRuntimeComponents,
  componentsNeedingReview,
  npmComponentsFromListing,
  pythonComponents,
  renderLicenses,
} from "./aggregate-licenses.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harness-licenses-"));
  const pkg = join(root, "node_modules", "left-pad");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "LICENSE"), "MIT License\r\nCopyright (c) left-pad authors\r\n");
  writeFileSync(join(pkg, "index.js"), "");
  const runtime = join(root, "runtime");
  const site = join(runtime, "python", "lib", "python3.11", "site-packages");
  const distInfo = join(site, "requests-2.32.0.dist-info");
  mkdirSync(join(distInfo, "licenses"), { recursive: true });
  writeFileSync(join(distInfo, "METADATA"), "Metadata-Version: 2.1\nName: requests\nVersion: 2.32.0\nLicense: Apache-2.0\nClassifier: License :: OSI Approved :: Apache Software License\n\nLong description here.\nLicense: not a header\n");
  writeFileSync(join(distInfo, "licenses", "LICENSE"), "Apache License 2.0 text");
  const classified = join(site, "idna-3.7.dist-info");
  mkdirSync(classified, { recursive: true });
  writeFileSync(join(classified, "METADATA"), "Name: idna\nVersion: 3.7\nClassifier: License :: OSI Approved :: BSD License\n");
  writeFileSync(join(runtime, "python", "LICENSE.txt"), "PSF LICENSE AGREEMENT");
  writeFileSync(join(runtime, "runtime.json"), JSON.stringify({ pythonVersion: "3.11.13" }));
  const electron = join(root, "electron-dist");
  mkdirSync(electron, { recursive: true });
  writeFileSync(join(electron, "LICENSE"), "Copyright (c) Electron contributors");
  writeFileSync(join(electron, "version"), "43.2.0");
  return { root, pkg, runtime, electron };
}

test("npm packages carry the license text from their installed directory", () => {
  const { root, pkg } = fixture();
  try {
    const [component] = npmComponentsFromListing({
      MIT: [{ name: "left-pad", versions: ["1.3.0"], paths: [pkg], license: "MIT", homepage: "https://example.com" }],
    });
    assert.equal(component.name, "left-pad");
    assert.equal(component.version, "1.3.0");
    assert.equal(component.license, "MIT");
    assert.deepEqual(component.texts, [{ file: "LICENSE", text: "MIT License\nCopyright (c) left-pad authors" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Python distributions are read from dist-info metadata, headers only", () => {
  const { root, runtime } = fixture();
  try {
    const components = pythonComponents(runtime);
    assert.deepEqual(components.map((c) => [c.name, c.version, c.license]), [
      ["idna", "3.7", "BSD License"],
      ["requests", "2.32.0", "Apache-2.0"],
    ]);
    assert.deepEqual(components[1].texts, [{ file: join("licenses", "LICENSE"), text: "Apache License 2.0 text" }]);
    assert.deepEqual(components[0].texts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundled runtimes include OpenCode, Electron and CPython", () => {
  const { root, runtime, electron } = fixture();
  try {
    const components = bundledRuntimeComponents({ runtimeDir: runtime, electronDir: electron, opencodeVersion: "v1.18.30" });
    assert.deepEqual(components.map((c) => [c.name, c.version]), [
      ["OpenCode", "v1.18.30"],
      ["Electron", "43.2.0"],
      ["CPython (python-build-standalone)", "3.11.13"],
    ]);
    assert.match(components[0].texts[0].text, /Copyright \(c\) 2025 opencode/);
    assert.equal(components[2].texts[0].text, "PSF LICENSE AGREEMENT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the inventory is deterministic, totals licenses, and flags ones to review", () => {
  const components = [
    { ecosystem: "python", name: "psycopg2-binary", version: "2.9", license: "LGPL with exceptions", homepage: null, texts: [] },
    { ecosystem: "npm", name: "b", version: "1.0.0", license: "MIT", homepage: null, texts: [{ file: "LICENSE", text: "MIT b" }] },
    { ecosystem: "npm", name: "a", version: "1.0.0", license: "MIT", homepage: "https://a.example", texts: [{ file: "LICENSE", text: "MIT a" }] },
  ];
  const text = renderLicenses({ components, harnessVersion: "1.2.3", notices: "OpenWork MIT", generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(text, renderLicenses({ components: [...components].reverse(), harnessVersion: "1.2.3", notices: "OpenWork MIT", generatedAt: "2026-01-01T00:00:00.000Z" }));
  assert.match(text, /2 npm packages, 1 Python packages, 0 bundled runtimes/);
  assert.match(text, / {4}2 {2}MIT/);
  assert.ok(text.indexOf("npm: a 1.0.0") < text.indexOf("npm: b 1.0.0"));
  assert.match(text, /OpenWork MIT/);
  assert.match(text, /No license file is included in this package; it declares "LGPL with exceptions"/);
  assert.deepEqual(componentsNeedingReview(components).map((c) => c.name), ["psycopg2-binary"]);
});
