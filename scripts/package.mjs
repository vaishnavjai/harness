#!/usr/bin/env node
// `npm run package`: one command from a checkout to a self-contained, runnable
// Harness build for this machine.
//
//   1. check the toolchain (Node, pnpm, bun, uv)
//   2. install workspace dependencies (frozen lockfile)
//   3. typecheck the app, server, desktop main process and the new packages
//   4. build the Hindsight memory runtime (relocatable CPython + pinned deps)
//   5. build the desktop app (renderer, server, OpenCode sidecar, plugins)
//   6. aggregate every third-party license into THIRD_PARTY_LICENSES.txt
//   7. assemble the unpacked app with electron-builder (--dir)
//   8. verify the artifact: every bundled runtime is present and starts
//
// Flags:
//   --skip-install       reuse node_modules as they are
//   --skip-typecheck     skip step 3
//   --fresh-runtime      rebuild the Hindsight runtime even if it is current
//
// Network is needed at build time (packages, CPython, the OpenCode release);
// the packaged app never downloads anything.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_MODULE_PROBE, REMOVED_RUNTIME_PACKAGES } from "./hindsight/runtime-policy.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repoRoot, "apps", "desktop");
const runtimeDir = join(desktopRoot, "resources", "hindsight-runtime");
const licensesOut = join(desktopRoot, "resources", "licenses", "THIRD_PARTY_LICENSES.txt");
const isWindows = process.platform === "win32";

const options = {
  skipInstall: process.argv.includes("--skip-install"),
  skipTypecheck: process.argv.includes("--skip-typecheck"),
  freshRuntime: process.argv.includes("--fresh-runtime"),
};

const started = Date.now();
let stepNumber = 0;

function step(title) {
  stepNumber += 1;
  process.stdout.write(`\n[${stepNumber}/8] ${title}\n`);
}

/** Run a command with an argument vector; no shell parsing except Windows .cmd shims. */
function run(command, args, { cwd = repoRoot, env } = {}) {
  const executable = isWindows && ["pnpm", "npm", "npx"].includes(command) ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, {
    cwd,
    stdio: "inherit",
    env: env ? { ...process.env, ...env } : process.env,
    shell: isWindows && executable.endsWith(".cmd"),
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function capture(command, args) {
  const executable = isWindows && ["pnpm", "npm", "npx"].includes(command) ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, { encoding: "utf8", shell: isWindows && executable.endsWith(".cmd") });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

export function checkToolchain(probe = capture) {
  const problems = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) problems.push(`Node 22 or newer is required (found ${process.versions.node}).`);
  if (!probe("pnpm", ["--version"])) problems.push("pnpm is required: run `corepack enable` (the version is pinned in package.json).");
  if (!probe("bun", ["--version"])) problems.push("bun is required to bundle the server and engine plugins: https://bun.sh");
  if (!probe("uv", ["--version"])) problems.push("uv is required to build the memory engine's Python runtime: https://docs.astral.sh/uv/");
  return problems;
}

/**
 * The runtime can be reused when it was built from the same lockfile for this
 * platform, with every package the runtime policy removes already removed.
 */
export function runtimeIsCurrent(dir, lockfileText, platform = process.platform, arch = process.arch) {
  try {
    const provenance = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"));
    if (existsSync(join(dir, ".partial"))) return false;
    const removed = Array.isArray(provenance.removedPackages) ? provenance.removedPackages : [];
    return provenance.kind === "bundled"
      && provenance.platform === platform
      && provenance.arch === arch
      && provenance.lockfileSha256 === createHash("sha256").update(lockfileText).digest("hex")
      && REMOVED_RUNTIME_PACKAGES.every((name) => removed.includes(name));
  } catch {
    return false;
  }
}

/** Where electron-builder put the unpacked app for this platform. */
export function findUnpackedApp(outputDir, platform = process.platform) {
  if (!existsSync(outputDir)) return null;
  for (const entry of readdirSync(outputDir).sort()) {
    const path = join(outputDir, entry);
    if (!statSync(path).isDirectory()) continue;
    if (platform === "darwin" && /^mac/.test(entry)) {
      const app = readdirSync(path).find((name) => name.endsWith(".app"));
      if (app) return { root: join(path, app), resources: join(path, app, "Contents", "Resources") };
    }
    if (platform !== "darwin" && /-unpacked$/.test(entry)) return { root: path, resources: join(path, "resources") };
  }
  return null;
}

/** What a runnable build must contain, relative to its resources directory. */
export function requiredArtifactPaths(platform = process.platform) {
  const opencode = platform === "win32" ? "opencode.exe" : "opencode";
  const python = platform === "win32" ? join("python", "python.exe") : join("python", "bin", "python3");
  return [
    "app.asar",
    join("app-dist", "index.html"),
    join("sidecars", opencode),
    join("harness-ui-mcp", "harness-ui-mcp.mjs"),
    join("hindsight-runtime", "runtime.json"),
    join("hindsight-runtime", "harness_hindsight_launcher.py"),
    join("hindsight-runtime", python),
    join("licenses", "THIRD_PARTY_LICENSES.txt"),
    // Audit trail, encrypted provider keys and long-term memory for the agent.
    join("opencode-plugins", "harness-audit.js"),
    join("opencode-plugins", "harness-provider-keys.js"),
    join("opencode-plugins", "harness-memory.js"),
    join("opencode-plugins", "harness-shell-env.js"),
  ];
}

/** Test files that reached the build's engine plugins folder; none may ship. */
export function shippedTestFiles(resourcesDir) {
  const dir = join(resourcesDir, "opencode-plugins");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /\.test\.[cm]?js$/.test(name)).map((name) => join("opencode-plugins", name));
}

function electronDistDir() {
  const dist = join(desktopRoot, "node_modules", "electron", "dist");
  return existsSync(dist) ? dist : null;
}

function main() {
  step("Checking the toolchain");
  const problems = checkToolchain();
  if (problems.length) throw new Error(`Cannot package Harness:\n  - ${problems.join("\n  - ")}`);

  step("Installing dependencies");
  if (options.skipInstall) process.stdout.write("Skipped (--skip-install).\n");
  else run("pnpm", ["install", "--frozen-lockfile", "--config.allow-unused-patches=true"]);

  step("Compiling and typechecking TypeScript");
  run("pnpm", ["--filter", "@harness/types", "--filter", "@harness/memory", "--filter", "@harness/audit", "--filter", "@harness/headless-threads", "build"]);
  if (options.skipTypecheck) {
    process.stdout.write("Typecheck skipped (--skip-typecheck).\n");
  } else {
    run("pnpm", ["--filter", "@harness/app", "typecheck"]);
    run("pnpm", ["--filter", "@harness/server", "typecheck"]);
    run("pnpm", ["--filter", "@harness/desktop", "typecheck:electron"]);
    run("pnpm", ["--filter", "@harness/memory", "--filter", "@harness/audit", "typecheck"]);
  }

  step("Building the memory engine runtime");
  const lockfileText = readFileSync(join(repoRoot, "vendor", "hindsight", "requirements.lock.txt"));
  if (!options.freshRuntime && runtimeIsCurrent(runtimeDir, lockfileText)) {
    // Keep the launcher in step with the source even when the runtime is reused.
    copyFileSync(join(repoRoot, "packages", "memory", "python", "harness_hindsight_launcher.py"), join(runtimeDir, "harness_hindsight_launcher.py"));
    process.stdout.write(`Reusing ${relative(repoRoot, runtimeDir)} (built from the current lockfile).\n`);
  } else {
    run(process.execPath, [join(repoRoot, "scripts", "hindsight", "prepare-runtime.mjs"), "--outdir", runtimeDir]);
  }

  step("Building the desktop app");
  run("pnpm", ["--filter", "@harness/desktop", "build:electron"]);

  step("Aggregating third-party licenses");
  const electronDist = electronDistDir();
  run(process.execPath, [
    join(repoRoot, "scripts", "licenses", "aggregate-licenses.mjs"),
    "--runtime", runtimeDir,
    "--out", licensesOut,
    ...(electronDist ? ["--electron", electronDist] : []),
  ]);
  copyFileSync(licensesOut, join(repoRoot, "THIRD_PARTY_LICENSES.txt"));

  step("Assembling the app");
  run("pnpm", [
    "exec", "electron-builder", "--config", "electron-builder.yml", "--dir", "--publish", "never",
    // Use the Electron already installed rather than downloading another copy.
    ...(electronDist ? [`--config.electronDist=${electronDist}`] : []),
  ], { cwd: desktopRoot });

  step("Verifying the build");
  const app = findUnpackedApp(join(desktopRoot, "dist-electron"));
  if (!app) throw new Error("electron-builder produced no unpacked app in apps/desktop/dist-electron.");
  const missing = requiredArtifactPaths().filter((path) => !existsSync(join(app.resources, path)));
  if (missing.length) throw new Error(`The build is missing:\n  - ${missing.join("\n  - ")}`);
  const tests = shippedTestFiles(app.resources);
  if (tests.length) throw new Error(`The build ships test files:\n  - ${tests.join("\n  - ")}`);
  const opencode = join(app.resources, "sidecars", isWindows ? "opencode.exe" : "opencode");
  const opencodeVersion = capture(opencode, ["--version"]);
  if (!opencodeVersion) throw new Error("The bundled OpenCode engine does not start.");
  const python = join(app.resources, "hindsight-runtime", ...(isWindows ? ["python", "python.exe"] : ["python", "bin", "python3"]));
  const importCheck = spawnSync(python, ["-I", "-c", "import hindsight_api.main, pg0; print('ok')"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  if (importCheck.status !== 0 || importCheck.stdout.trim() !== "ok") {
    throw new Error(`The bundled memory engine does not import: ${importCheck.stderr || importCheck.stdout}`);
  }
  const telemetryCheck = spawnSync(python, ["-I", "-c", FORBIDDEN_MODULE_PROBE], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  if (telemetryCheck.status !== 0 || telemetryCheck.stdout.trim()) {
    throw new Error(`The bundled memory engine ships telemetry modules: ${telemetryCheck.stdout.trim() || telemetryCheck.stderr.trim()}`);
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write([
    "",
    `Harness is packaged (${seconds}s).`,
    `  App:       ${relative(repoRoot, app.root)}`,
    `  Engine:    OpenCode ${opencodeVersion}`,
    `  Memory:    ${JSON.parse(readFileSync(join(app.resources, "hindsight-runtime", "runtime.json"), "utf8")).hindsightVersion} (Python runtime bundled)`,
    `  Licenses:  ${relative(repoRoot, join(app.resources, "licenses", "THIRD_PARTY_LICENSES.txt"))}`,
    "",
  ].join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`\nPackaging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

