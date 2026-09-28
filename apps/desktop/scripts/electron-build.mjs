import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareServerConstants } from "./prepare-server-constants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const electronSidecarDir = resolve(desktopRoot, "resources", "sidecars");
const electronHelperDir = resolve(desktopRoot, "resources", "helpers");
const electronRoot = resolve(desktopRoot, "electron");
const packagedServerRoot = resolve(desktopRoot, "server");
const packagedRuntimeRoot = resolve(desktopRoot, ".electron-runtime", "node_modules");

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nodeCmd = process.execPath;

function needsShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: needsShell(command),
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(nodeCmd, [resolve(__dirname, "prepare-sidecar.mjs"), "--force", "--outdir", electronSidecarDir], desktopRoot);
run(nodeCmd, [resolve(__dirname, "prepare-computer-use-helper.mjs"), "--force", "--outdir", electronHelperDir], desktopRoot);
run(nodeCmd, [resolve(__dirname, "prepare-runtime-node-modules.mjs"), "--outdir", packagedRuntimeRoot], desktopRoot);
// Ship the UI-control MCP as one self-contained file so packaged builds run
// it on Electron's Node instead of resolving a package name through npx.
run(process.platform === "win32" ? "bun.exe" : "bun", [
  "build",
  resolve(repoRoot, "packages", "harness-ui-mcp", "index.mjs"),
  "--target", "node",
  "--format", "esm",
  "--outfile", resolve(desktopRoot, ".electron-runtime", "harness-ui-mcp", "harness-ui-mcp.mjs"),
], repoRoot);
// Build the server TS → JS so Electron can import it in-process
// CI already compiles this exact checkout in the required build job.
if (!process.argv.includes("--server-built")) {
  run(pnpmCmd, ["--filter", "@harness/server", "build"], repoRoot);
}
// automation-runner.mjs imports @harness/headless-threads through its
// published "default" export (dist/index.js); build it so plain-node
// consumers resolve it in packaged layouts.
run(pnpmCmd, ["--filter", "@harness/headless-threads", "build"], repoRoot);
// HARNESS_ELECTRON_BUILD tells Vite to emit relative asset paths so
// index.html resolves /assets/* correctly when loaded via file:// from
// inside the packaged .app bundle.
run(pnpmCmd, ["--filter", "@harness/app", "build"], repoRoot, {
  HARNESS_ELECTRON_BUILD: "1",
});
// Relocate repository constants for every compiled server module, including v2.
const serverDistDir = resolve(repoRoot, "apps", "server", "dist");
prepareServerConstants(serverDistDir, resolve(repoRoot, "constants.json"));
rmSync(packagedServerRoot, { recursive: true, force: true });
cpSync(serverDistDir, resolve(packagedServerRoot, "dist"), { recursive: true });
copyFileSync(resolve(repoRoot, "apps", "server", "package.json"), resolve(packagedServerRoot, "package.json"));
for (const fileName of readdirSync(electronRoot).filter((name) => name.endsWith(".mjs")).sort()) {
  run(nodeCmd, ["--check", resolve(electronRoot, fileName)], repoRoot);
}
run(nodeCmd, [resolve(__dirname, "check-electron-bridge.mjs")], repoRoot);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      renderer: "apps/app/dist",
      electronMain: "apps/desktop/electron/main.mjs",
      electronPreload: "apps/desktop/electron/preload.mjs",
    },
    null,
    2,
  )}\n`,
);
