#!/usr/bin/env node
// Aggregates the license of every third-party component a Harness build ships
// into one THIRD_PARTY_LICENSES.txt:
//
//   - npm packages in the production dependency closure of the desktop app,
//     its renderer and the local server (from `pnpm licenses list --prod`),
//   - Python packages installed in the bundled Hindsight runtime
//     (`*.dist-info` metadata and license files),
//   - the runtimes shipped as binaries (OpenCode, Electron/Chromium, CPython),
//   - OpenWork and Hindsight, whose notices are in THIRD_PARTY_NOTICES.md.
//
//   node scripts/licenses/aggregate-licenses.mjs \
//     --runtime apps/desktop/resources/hindsight-runtime \
//     --out apps/desktop/resources/licenses/THIRD_PARTY_LICENSES.txt
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Workspace projects whose production dependencies end up in a build. */
export const SHIPPED_WORKSPACE_PROJECTS = ["@harness/desktop", "@harness/app", "@harness/server"];

/** Licenses that need a human look before shipping; reported, not fatal. */
const REVIEW_PATTERN = /\b(A?GPL|LGPL|MPL|EPL|CDDL|SSPL|BUSL|Commons-Clause|UNLICENSED|UNKNOWN)\b/i;

const LICENSE_FILE_PATTERN = /^(LICEN[CS]E|COPYING|NOTICE|COPYRIGHT)(\..*)?$|^(LICEN[CS]E|COPYING)[-_.]/i;

const SEPARATOR = "=".repeat(78);

function licenseFilesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function readText(path) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Turn `pnpm licenses list --json` output into one component per
 * package version, with the license text read from the installed package.
 * @param {Record<string, Array<{ name: string, versions: string[], paths: string[], license: string, homepage?: string }>>} listing
 */
export function npmComponentsFromListing(listing) {
  const components = [];
  for (const [license, packages] of Object.entries(listing)) {
    for (const pkg of packages) {
      pkg.versions.forEach((version, index) => {
        const path = pkg.paths[index] ?? pkg.paths[0] ?? "";
        const texts = licenseFilesIn(path).map((file) => ({ file: relative(path, file), text: readText(file) }));
        const declared = pkg.license || license;
        components.push({
          ecosystem: "npm",
          name: pkg.name,
          version,
          license: /^unknown$/i.test(declared) ? licenseFromText(texts) ?? declared : declared,
          homepage: pkg.homepage ?? null,
          texts,
        });
      });
    }
  }
  return components;
}

/** A package that declares no license but ships a recognisable MIT text. */
export function licenseFromText(texts) {
  const text = texts.map((entry) => entry.text).join("\n");
  if (/^\s*(The )?MIT License/i.test(text) || /Permission is hereby granted, free of charge, to any person obtaining a copy/.test(text)) {
    return "MIT (from license text)";
  }
  return null;
}

/** The site-packages directory of a bundled or venv Python. */
export function sitePackagesDirs(runtimeDir) {
  const python = join(runtimeDir, "python");
  const candidates = [join(python, "Lib", "site-packages")];
  const lib = join(python, "lib");
  if (existsSync(lib)) {
    for (const entry of readdirSync(lib)) {
      if (/^python3\.\d+$/.test(entry)) candidates.push(join(lib, entry, "site-packages"));
    }
  }
  return candidates.filter((path) => existsSync(path));
}

function metadataFields(text) {
  const fields = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) break;
    const match = /^([A-Za-z-]+):\s?(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    fields.set(key, [...(fields.get(key) ?? []), match[2].trim()]);
  }
  return fields;
}

function pythonLicense(fields) {
  const expression = fields.get("license-expression")?.[0];
  if (expression) return expression;
  const declared = fields.get("license")?.[0];
  if (declared && declared.length <= 80 && !declared.includes("\n")) return declared;
  const classifiers = (fields.get("classifier") ?? [])
    .filter((value) => value.startsWith("License ::"))
    .map((value) => value.split("::").pop().trim())
    .filter((value) => value && value !== "OSI Approved");
  if (classifiers.length) return classifiers.join(" OR ");
  return declared ? "See license text" : "UNKNOWN";
}

/** One component per installed distribution, from its `*.dist-info`. */
export function pythonComponents(runtimeDir) {
  const components = [];
  for (const sitePackages of sitePackagesDirs(runtimeDir)) {
    for (const entry of readdirSync(sitePackages).filter((name) => name.endsWith(".dist-info")).sort()) {
      const distInfo = join(sitePackages, entry);
      const metadataPath = join(distInfo, "METADATA");
      if (!existsSync(metadataPath)) continue;
      const fields = metadataFields(readText(metadataPath));
      const texts = [
        ...licenseFilesIn(distInfo),
        ...licenseFilesIn(join(distInfo, "licenses")),
        ...collectNested(join(distInfo, "licenses")),
      ];
      const unique = [...new Set(texts)];
      components.push({
        ecosystem: "python",
        name: fields.get("name")?.[0] ?? entry.replace(/-[^-]+\.dist-info$/, ""),
        version: fields.get("version")?.[0] ?? "",
        license: pythonLicense(fields),
        homepage: fields.get("home-page")?.[0] ?? null,
        texts: unique.map((file) => ({ file: relative(distInfo, file), text: readText(file) })),
      });
    }
  }
  return components;
}

function collectNested(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectNested(path));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

/** Runtimes shipped as prebuilt binaries rather than packages. */
export function bundledRuntimeComponents({ runtimeDir, electronDir, opencodeVersion }) {
  const components = [];
  components.push({
    ecosystem: "binary",
    name: "OpenCode",
    version: opencodeVersion ?? "",
    license: "MIT",
    homepage: "https://github.com/anomalyco/opencode",
    texts: [{
      file: "LICENSE",
      text: [
        "MIT License",
        "",
        "Copyright (c) 2025 opencode",
        "",
        "Permission is hereby granted, free of charge, to any person obtaining a copy",
        "of this software and associated documentation files (the \"Software\"), to deal",
        "in the Software without restriction, including without limitation the rights",
        "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
        "copies of the Software, and to permit persons to whom the Software is",
        "furnished to do so, subject to the following conditions:",
        "",
        "The above copyright notice and this permission notice shall be included in all",
        "copies or substantial portions of the Software.",
        "",
        "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
        "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
        "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
        "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
        "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
        "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
        "SOFTWARE.",
      ].join("\n"),
    }],
  });
  if (electronDir && existsSync(join(electronDir, "LICENSE"))) {
    const version = existsSync(join(electronDir, "version")) ? readText(join(electronDir, "version")) : "";
    components.push({
      ecosystem: "binary",
      name: "Electron",
      version,
      license: "MIT (Electron); Chromium components under their own licenses",
      homepage: "https://www.electronjs.org/",
      texts: [
        { file: "LICENSE", text: readText(join(electronDir, "LICENSE")) },
        { file: "LICENSES.chromium.html", text: "Chromium's component licenses ship with every build as LICENSES.chromium.html next to the application executable." },
      ],
    });
  }
  if (runtimeDir && pythonComponents(runtimeDir).some((component) => component.name === "pg0-embedded")) {
    components.push(...embeddedPostgresComponents());
  }
  const python = runtimeDir ? join(runtimeDir, "python") : null;
  if (python && existsSync(python)) {
    const pythonLicenseFile = [
      join(python, "LICENSE.txt"),
      join(python, "LICENSE"),
      ...sitePackagesDirs(runtimeDir).map((dir) => join(dir, "..", "LICENSE.txt")),
    ].find((path) => existsSync(path) && statSync(path).isFile());
    const buildLicenses = existsSync(join(python, "licenses")) ? collectNested(join(python, "licenses")) : [];
    components.push({
      ecosystem: "binary",
      name: "CPython (python-build-standalone)",
      version: readRuntimePythonVersion(runtimeDir),
      license: "PSF-2.0 (CPython); bundled libraries under their own licenses",
      homepage: "https://github.com/astral-sh/python-build-standalone",
      texts: [
        ...(pythonLicenseFile ? [{ file: relative(python, pythonLicenseFile), text: readText(pythonLicenseFile) }] : []),
        ...buildLicenses.map((file) => ({ file: relative(python, file), text: readText(file) })),
      ],
    });
  }
  return components;
}

const POSTGRES_LICENSE_BODY = [
  "Permission to use, copy, modify, and distribute this software and its",
  "documentation for any purpose, without fee, and without a written agreement",
  "is hereby granted, provided that the above copyright notice and this",
  "paragraph and the following two paragraphs appear in all copies.",
  "",
  "IN NO EVENT SHALL THE UNIVERSITY OF CALIFORNIA BE LIABLE TO ANY PARTY FOR",
  "DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING",
  "LOST PROFITS, ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS",
  "DOCUMENTATION, EVEN IF THE UNIVERSITY OF CALIFORNIA HAS BEEN ADVISED OF THE",
  "POSSIBILITY OF SUCH DAMAGE.",
  "",
  "THE UNIVERSITY OF CALIFORNIA SPECIFICALLY DISCLAIMS ANY WARRANTIES,",
  "INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY",
  "AND FITNESS FOR A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS",
  "ON AN \"AS IS\" BASIS, AND THE UNIVERSITY OF CALIFORNIA HAS NO OBLIGATIONS TO",
  "PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.",
].join("\n");

/**
 * pg0-embedded carries PostgreSQL and pgvector as a compressed archive that
 * it unpacks on first start, so their license files are not on disk at build
 * time. The texts below match what that archive installs (PostgreSQL 18.1.0
 * built by theseus-rs/postgresql_binaries, pgvector 0.8.5).
 */
function embeddedPostgresComponents() {
  const postgresCopyright = [
    "PostgreSQL Database Management System",
    "(also known as Postgres, formerly known as Postgres95)",
    "",
    "Portions Copyright (c) 1996-2025, PostgreSQL Global Development Group",
    "",
    "Portions Copyright (c) 1994, The Regents of the University of California",
    "",
    POSTGRES_LICENSE_BODY,
  ].join("\n");
  const theseus = [
    "Copyright (c) 2024, Theseus",
    "",
    "Permission to use, copy, modify, and distribute this software and its documentation for any purpose, without fee, and without a written agreement is hereby granted, provided that the above copyright notice and this paragraph and the following two paragraphs appear in all copies.",
    "",
    "IN NO EVENT SHALL Theseus BE LIABLE TO ANY PARTY FOR DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING LOST PROFITS, ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN IF Theseus HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.",
    "",
    "Theseus SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE SOFTWARE PROVIDED HEREUNDER IS ON AN \"AS IS\" BASIS, AND Theseus HAS NO OBLIGATIONS TO PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.",
  ].join("\n");
  return [
    {
      ecosystem: "binary",
      name: "PostgreSQL (bundled by pg0-embedded)",
      version: "18.1.0",
      license: "PostgreSQL",
      homepage: "https://www.postgresql.org/",
      texts: [
        { file: "COPYRIGHT", text: postgresCopyright },
        { file: "LICENSE (postgresql_binaries packaging)", text: theseus },
      ],
    },
    {
      ecosystem: "binary",
      name: "pgvector (bundled by pg0-embedded)",
      version: "0.8.5",
      license: "PostgreSQL",
      homepage: "https://github.com/pgvector/pgvector",
      texts: [{
        file: "LICENSE",
        text: [
          "Portions Copyright (c) 1996-2025, PostgreSQL Global Development Group",
          "",
          "Portions Copyright (c) 1994, The Regents of the University of California",
          "",
          POSTGRES_LICENSE_BODY,
        ].join("\n"),
      }],
    },
  ];
}

function readRuntimePythonVersion(runtimeDir) {
  try {
    return JSON.parse(readFileSync(join(runtimeDir, "runtime.json"), "utf8")).pythonVersion ?? "";
  } catch {
    return "";
  }
}

/** Deterministic text for the whole inventory. */
export function renderLicenses({ components, harnessVersion, notices, generatedAt }) {
  const sorted = [...components].sort((left, right) =>
    left.ecosystem.localeCompare(right.ecosystem)
    || left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version));
  const totals = new Map();
  for (const component of sorted) totals.set(component.license, (totals.get(component.license) ?? 0) + 1);
  const counts = { npm: 0, python: 0, binary: 0 };
  for (const component of sorted) counts[component.ecosystem] = (counts[component.ecosystem] ?? 0) + 1;

  const lines = [
    "Harness third-party licenses",
    "",
    `Harness ${harnessVersion}. Generated ${generatedAt} by scripts/licenses/aggregate-licenses.mjs.`,
    `${counts.npm} npm packages, ${counts.python} Python packages, ${counts.binary} bundled runtimes.`,
    "",
    "License totals:",
    ...[...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([license, count]) => `  ${String(count).padStart(5)}  ${license}`),
    "",
  ];
  if (notices) lines.push(SEPARATOR, "Harness, OpenWork and Hindsight notices (THIRD_PARTY_NOTICES.md)", SEPARATOR, "", notices.trimEnd(), "");
  for (const component of sorted) {
    lines.push(SEPARATOR, `${component.ecosystem}: ${component.name}${component.version ? ` ${component.version}` : ""}`, `License: ${component.license}`);
    if (component.homepage) lines.push(`Homepage: ${component.homepage}`);
    lines.push(SEPARATOR, "");
    if (!component.texts.length) {
      lines.push(`No license file is included in this package; it declares "${component.license}".`, "");
      continue;
    }
    for (const { file, text } of component.texts) {
      if (component.texts.length > 1) lines.push(`--- ${file} ---`);
      lines.push(text, "");
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Components whose license needs a human look before shipping. */
export function componentsNeedingReview(components) {
  return components.filter((component) => REVIEW_PATTERN.test(component.license));
}

function pnpmLicenses(projects) {
  const args = ["licenses", "list", "--prod", "--json", ...projects.flatMap((name) => ["--filter", name])];
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) throw new Error(`pnpm licenses list failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function parseArgs(argv) {
  const options = { runtime: null, out: join(repoRoot, "THIRD_PARTY_LICENSES.txt"), electron: join(repoRoot, "apps", "desktop", "node_modules", "electron", "dist") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runtime") options.runtime = resolve(argv[++index]);
    else if (arg === "--out") options.out = resolve(argv[++index]);
    else if (arg === "--electron") options.electron = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const constants = JSON.parse(readFileSync(join(repoRoot, "constants.json"), "utf8"));
  const harnessVersion = JSON.parse(readFileSync(join(repoRoot, "apps", "desktop", "package.json"), "utf8")).version;
  const components = [
    ...npmComponentsFromListing(pnpmLicenses(SHIPPED_WORKSPACE_PROJECTS)),
    ...(options.runtime ? pythonComponents(options.runtime) : []),
    ...bundledRuntimeComponents({ runtimeDir: options.runtime, electronDir: options.electron, opencodeVersion: constants.opencodeVersion }),
  ];
  const notices = existsSync(join(repoRoot, "THIRD_PARTY_NOTICES.md")) ? readText(join(repoRoot, "THIRD_PARTY_NOTICES.md")) : "";
  const text = renderLicenses({ components, harnessVersion, notices, generatedAt: new Date().toISOString() });
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, text);

  const review = componentsNeedingReview(components);
  const missing = components.filter((component) => !component.texts.length);
  process.stdout.write(`Wrote ${relative(repoRoot, options.out)}: ${components.length} components, ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB.\n`);
  if (missing.length) process.stdout.write(`${missing.length} components ship no license file; their declared license is recorded.\n`);
  if (review.length) {
    process.stdout.write(`Licenses to review before distributing (${review.length}):\n`);
    for (const component of review) process.stdout.write(`  ${component.ecosystem} ${component.name} ${component.version}: ${component.license}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
