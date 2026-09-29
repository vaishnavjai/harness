#!/usr/bin/env node
// Bundles electron/preload.mjs into one CommonJS file, electron/preload.cjs.
//
// The main window runs with Chromium's renderer sandbox on. A sandboxed
// preload cannot be an ES module and cannot require a sibling file: it gets
// `electron` and nothing else. So the ES-module source (and the modules it
// imports) is bundled here, and the result is checked to touch nothing but
// `electron`.
//
//   node scripts/build-preload.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PRELOAD_SOURCE = resolve(desktopRoot, "electron", "preload.mjs");
export const PRELOAD_BUNDLE = resolve(desktopRoot, "electron", "preload.cjs");

/**
 * Everything a bundled preload may load. Anything else would fail at runtime
 * in the sandbox, or mean a Node module has crept into the renderer.
 */
const ALLOWED_REQUIRES = new Set(["electron"]);

/**
 * @param {string} bundleText
 * @returns {string[]} what is wrong with the bundle; empty when it is sandbox-safe
 */
export function sandboxProblems(bundleText) {
  const problems = [];
  for (const match of bundleText.matchAll(/\brequire\(\s*(["'`])([^"'`]+)\1\s*\)/g)) {
    if (!ALLOWED_REQUIRES.has(match[2])) problems.push(`requires "${match[2]}"`);
  }
  if (/^\s*(import|export)\s[^(]/m.test(bundleText)) problems.push("still contains an ES module import or export");
  if (/\bimport\.meta\b/.test(bundleText)) problems.push("uses import.meta");
  if (/\bimport\(/.test(bundleText)) problems.push("uses dynamic import()");
  return problems;
}

/**
 * @param {{ entry?: string; outfile?: string; bun?: string }} [options]
 * @returns {{ outfile: string; bytes: number }}
 */
export function buildPreload(options = {}) {
  const entry = options.entry ?? PRELOAD_SOURCE;
  const outfile = options.outfile ?? PRELOAD_BUNDLE;
  const result = spawnSync(
    options.bun ?? (process.platform === "win32" ? "bun.exe" : "bun"),
    ["build", entry, "--outfile", outfile, "--target", "node", "--format", "cjs", "--external", "electron"],
    { encoding: "utf8", shell: false },
  );
  if (result.error) throw new Error(`Could not run bun to bundle the preload: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Bundling the preload failed:\n${result.stderr || result.stdout}`);
  const text = readFileSync(outfile, "utf8");
  const problems = sandboxProblems(text);
  if (problems.length) throw new Error(`The bundled preload is not sandbox-safe: ${problems.join("; ")}`);
  return { outfile, bytes: Buffer.byteLength(text) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { outfile, bytes } = buildPreload();
    process.stdout.write(`Bundled the preload to ${outfile} (${bytes} bytes)\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
