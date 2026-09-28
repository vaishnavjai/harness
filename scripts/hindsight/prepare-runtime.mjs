#!/usr/bin/env node
// Builds the self-contained Python runtime that runs the vendored Hindsight
// memory engine, so Harness never installs packages at runtime.
//
//   node scripts/hindsight/prepare-runtime.mjs --outdir apps/desktop/resources/hindsight-runtime
//   node scripts/hindsight/prepare-runtime.mjs --dev     # ./.hindsight-runtime (venv, for development)
//
// Layout of the output directory:
//   python/                          relocatable CPython (python-build-standalone) with
//                                    Hindsight and its hash-pinned dependencies installed
//   harness_hindsight_launcher.py    the loopback/egress/orphan-guarded entry point
//   runtime.json                     provenance: versions and the lockfile digest
//
// Requires uv (https://docs.astral.sh/uv/). Network access is needed here, at
// build time, and never by the packaged app.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_MODULE_PROBE, REMOVED_RUNTIME_PACKAGES } from "./runtime-policy.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vendorRoot = join(repoRoot, "vendor", "hindsight");
const lockfile = join(vendorRoot, "requirements.lock.txt");
const launcherSource = join(repoRoot, "packages", "memory", "python", "harness_hindsight_launcher.py");
const MARKER = "runtime.json";

function parseArgs(argv) {
  const options = { dev: false, outdir: null, pythonVersion: "3.11" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dev") options.dev = true;
    else if (arg === "--outdir") options.outdir = argv[++index];
    else if (arg === "--python-version") options.pythonVersion = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.outdir = resolve(repoRoot, options.outdir ?? (options.dev ? ".hindsight-runtime" : "apps/desktop/resources/hindsight-runtime"));
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function pythonIn(root) {
  return process.platform === "win32" ? join(root, "python", "python.exe") : join(root, "python", "bin", "python3");
}

/** Refuse to delete anything this script did not create. */
function cleanOutdir(outdir) {
  if (!existsSync(outdir)) return;
  const entries = readdirSync(outdir);
  if (entries.length > 0 && !entries.includes(MARKER) && !entries.includes(".partial")) {
    throw new Error(`${outdir} exists and is not a Hindsight runtime directory; refusing to overwrite it.`);
  }
  rmSync(outdir, { recursive: true, force: true });
}

function directorySize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

/**
 * Payload no Harness code path can load. claude_agent_sdk ships a ~230 MB
 * Claude Code CLI used only by Hindsight's `claude-code` LLM provider, which
 * Harness does not offer; the SDK imports lazily, so the engine still starts.
 */
const PRUNE_FROM_SITE_PACKAGES = [join("claude_agent_sdk", "_bundled")];

function pruneBundledRuntime(python) {
  const sitePackages = capture(python, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"]);
  if (!sitePackages) throw new Error("Could not locate site-packages in the bundled runtime");
  for (const entry of PRUNE_FROM_SITE_PACKAGES) {
    rmSync(join(sitePackages, entry), { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const uvVersion = capture("uv", ["--version"]);
  if (!uvVersion) throw new Error("uv is required to build the Hindsight runtime: https://docs.astral.sh/uv/");
  for (const required of [lockfile, launcherSource, join(vendorRoot, "pyproject.toml")]) {
    if (!existsSync(required)) throw new Error(`Missing ${relative(repoRoot, required)}`);
  }

  cleanOutdir(options.outdir);
  mkdirSync(options.outdir, { recursive: true });
  writeFileSync(join(options.outdir, ".partial"), "");

  if (options.dev) {
    // A plain venv is fine for development; it is never shipped.
    run("uv", ["venv", "--python", options.pythonVersion, join(options.outdir, "python")]);
  } else {
    // python-build-standalone builds are relocatable, so the directory can
    // move into the app bundle as-is.
    const staging = join(options.outdir, ".uv-python");
    run("uv", ["python", "install", options.pythonVersion, "--install-dir", staging, "--no-bin"]);
    const installed = readdirSync(staging).find((name) => name.startsWith("cpython-"));
    if (!installed) throw new Error("uv did not install a CPython build");
    renameSync(join(staging, installed), join(options.outdir, "python"));
    rmSync(staging, { recursive: true, force: true });
  }

  const python = pythonIn(options.outdir);
  const installArgs = ["pip", "install", "--python", python, "--compile-bytecode"];
  if (!options.dev) installArgs.push("--break-system-packages");
  // Every dependency is pinned with sha256 hashes; a changed artifact fails the build.
  run("uv", [...installArgs, "--require-hashes", "-r", lockfile]);
  run("uv", [...installArgs, "--no-deps", vendorRoot]);
  const uninstallArgs = ["pip", "uninstall", "--python", python, ...(options.dev ? [] : ["--break-system-packages"])];
  run("uv", [...uninstallArgs, ...REMOVED_RUNTIME_PACKAGES]);

  if (!options.dev) pruneBundledRuntime(python);
  cpSync(launcherSource, join(options.outdir, "harness_hindsight_launcher.py"));
  const checkEnv = { PATH: process.env.PATH ?? "", PYTHONNOUSERSITE: "1" };
  run(python, ["-c", "import hindsight_api.main, pg0; print('hindsight runtime import check: ok')"], { env: checkEnv });
  const leftover = spawnSync(python, ["-c", FORBIDDEN_MODULE_PROBE], { encoding: "utf8", env: checkEnv, shell: false });
  if (leftover.status !== 0 || leftover.stdout.trim()) {
    throw new Error(`The memory runtime still contains telemetry modules: ${leftover.stdout.trim() || leftover.stderr.trim()}`);
  }

  const pyproject = readFileSync(join(vendorRoot, "pyproject.toml"), "utf8");
  const provenance = {
    hindsightVersion: /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? "unknown",
    pythonVersion: capture(python, ["-c", "import platform; print(platform.python_version())"]),
    platform: process.platform,
    arch: process.arch,
    kind: options.dev ? "development-venv" : "bundled",
    lockfileSha256: createHash("sha256").update(readFileSync(lockfile)).digest("hex"),
    removedPackages: [...REMOVED_RUNTIME_PACKAGES],
    builtWith: uvVersion,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(options.outdir, MARKER), `${JSON.stringify(provenance, null, 2)}\n`);
  rmSync(join(options.outdir, ".partial"), { force: true });
  const megabytes = (directorySize(options.outdir) / 1024 / 1024).toFixed(1);
  process.stdout.write(`Hindsight runtime ready at ${relative(repoRoot, options.outdir)} (${megabytes} MB)\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
