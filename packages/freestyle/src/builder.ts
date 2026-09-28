import { setTimeout as delay } from "node:timers/promises";
import type { Vm } from "freestyle";
import { client, execChecked, findSnapshot, snapshotSlug, type PreviewWorld } from "./index.ts";
import { compiledFingerprint, runningFingerprint, dependencyFingerprint, dependencyInput, digest, ensureLayer, sourceTree, startBuildUnit, type ObserveBuild } from "./cache.ts";
import { checkoutRecipe, compiledRecipe, dependencyRecipe, toolsRecipe } from "./build-recipes.ts";
import { readAsset, type ControllerAsset } from "./assets.ts";

export interface BuildOptions {
  observe?: ObserveBuild;
  sourceFetch?: typeof fetch;
  diagnostic?: (stage: string, log: string) => Promise<void>;
}

/** Metadata on every builder VM of one commit/world build; see `isBuilding`. */
export function buildLabel(sha: string, world: PreviewWorld): Record<string, string> {
  return { harnessBuild: `${world}-${sha}` };
}

export async function runScript(vm: Vm, stage: string, script: string, options: BuildOptions) {
  const root = `/opt/harness-preview/${stage}`;
  await execChecked(vm, "mkdir -p /opt/harness-preview");
  await vm.fs.writeTextFile(`${root}.sh`, `#!/bin/bash
set -euo pipefail
exec > ${root}.log 2>&1
trap 'touch ${root}.failed' ERR
rm -f ${root}.ready ${root}.failed
export pnpm_config_verify_deps_before_run=false
${script}
touch ${root}.ready
`);
  await startBuildUnit(vm, stage, options.diagnostic);
  const deadline = Date.now() + 11 * 60_000;
  while (Date.now() < deadline) {
    // Poll files directly: spawning a shell for every check can be interrupted
    // while a restored guest settles, even when the build itself is healthy.
    const [failed, ready] = await Promise.all([vm.fs.exists(`${root}.failed`), vm.fs.exists(`${root}.ready`)]);
    const state = failed ? "failed" : ready ? "ready" : "building";
    if (state === "ready") return;
    if (state === "failed") {
      if (options.diagnostic) {
        const runtime = stage === "world" ? await execChecked(vm, "journalctl -u harness-preview-runtime --no-pager -n 100") : "";
        await options.diagnostic(stage, await vm.fs.readTextFile(`${root}.log`) + runtime);
      }
      throw new Error(`Snapshot ${stage} failed. Private builder log: ${root}.log`);
    }
    await delay(1_000);
  }
  if (options.diagnostic) await options.diagnostic(stage, await vm.fs.readTextFile(`${root}.log`));
  throw new Error(`Snapshot ${stage} exceeded 11 minutes`);
}

/** Immutable tools/dependencies are shared; the running world always belongs to one exact commit. */
export async function ensureSnapshot(sha: string, api = client(), log: (message: string) => void = () => {}, world: PreviewWorld = "app-web", options: BuildOptions = {}) {
  const slug = snapshotSlug(sha, world);
  const observe: ObserveBuild = (event) => { log(JSON.stringify(event)); options.observe?.(event); };
  const existing = await findSnapshot(sha, api, world);
  if (existing) { observe({ stage: "world", durationMs: 0, cacheHit: true }); return existing; }
  const entries = await sourceTree(sha, options.sourceFetch);
  const tools = toolsRecipe(world);
  const dependencies = dependencyRecipe(world);
  const toolsSlug = `ow-tools-v1-${world}-${digest(tools)}`;
  const depsSlug = `ow-deps-v1-${world}-${digest(toolsSlug + dependencies + dependencyFingerprint(entries))}`;
  const deps = await ensureLayer({ slug: depsSlug, stage: "dependencies", observe, metadata: buildLabel(sha, world),
    parent: async () => (await ensureLayer({ slug: toolsSlug, stage: "tools", observe, metadata: buildLabel(sha, world),
      parent: async () => "freestyle/ubuntu",
      prepare: async (vm) => runScript(vm, "tools", tools, options),
    }, api)).id,
    prepare: async (vm) => {
      // Remove application source before installing the shared layer. Only
      // fingerprinted inputs and immutable registry dependencies may affect it.
      const inputs = entries.filter((entry) => entry.type === "blob" && dependencyInput(entry.path)).map((entry) => entry.path);
      await vm.fs.writeTextFile("/opt/harness-preview/dependency-inputs.json", JSON.stringify(inputs));
      await runScript(vm, "dependencies", `${checkoutRecipe(sha)}
node --input-type=module - <<'NODE'
import { readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const keep = new Set(JSON.parse(await readFile('/opt/harness-preview/dependency-inputs.json', 'utf8')));
for (const path of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\\0').filter(Boolean)) {
  if (!keep.has(path)) await rm(path, { force: true });
}
NODE
${dependencies}`, options);
    },
  }, api);
  const compile = compiledRecipe(world);
  const compiledSlug = `ow-build-v1-${world}-${digest(depsSlug + compile + compiledFingerprint(entries, world))}`;
  const compiled = await ensureLayer({ slug: compiledSlug, stage: "compiled", observe, metadata: buildLabel(sha, world),
    parent: async () => deps.id,
    prepare: async (vm) => runScript(vm, "compiled", `${checkoutRecipe(sha)}\n${compile}`, options),
  }, api);
  const controllerFiles: ControllerAsset[] = ["builder.ts", "cache.ts", "build-recipes.ts", "browser-recipe.ts", "browser-health.mjs", "gateway.mjs", "runtime.mjs", "health.mjs", "desktop.mjs", "refresh.mjs", "desktop-runtime.mjs", "desktop-state.mjs", "desktop-health.mjs", "desktop-refresh.mjs"];
  const controller = (await Promise.all(controllerFiles.map(readAsset))).join("\n");
  const runningSlug = `ow-warm-v1-${world}-${digest(compiledSlug + controller + runningFingerprint(entries, world))}`;
  const running = await ensureLayer({ slug: runningSlug, stage: "running-template", observe, metadata: buildLabel(sha, world), ttlSeconds: 86400,
    parent: async () => compiled.id,
    prepare: async (vm) => {
      log(`Preparing ${world} at ${sha} from cached dependencies`);
      const files: [string, ControllerAsset][] = [
        ["browser-health.mjs", "browser-health.mjs"], ["gateway.mjs", "gateway.mjs"], ["runtime.mjs", world === "desktop" ? "desktop-runtime.mjs" : "runtime.mjs"],
        ["health.mjs", world === "desktop" ? "desktop-health.mjs" : "health.mjs"], ["desktop.mjs", "desktop.mjs"],
        ["refresh.mjs", world === "desktop" ? "desktop-refresh.mjs" : "refresh.mjs"], ["desktop-state.mjs", "desktop-state.mjs"],
      ];
      for (const [target, source] of files) {
        await vm.fs.writeTextFile(`/opt/harness-preview/${target}`, await readAsset(source));
      }
      await vm.fs.writeTextFile("/etc/systemd/system/harness-preview-runtime.service", `[Unit]
Description=Harness isolated preview runtime
[Service]
Type=${world === "app-web" ? "oneshot" : "simple"}
RemainAfterExit=${world === "app-web" ? "yes" : "no"}
WorkingDirectory=/workspace
Environment=PATH=/opt/harness-preview/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/env node /opt/harness-preview/runtime.mjs
`);
      await vm.fs.writeTextFile("/etc/systemd/system/harness-preview-gateway.service", `[Unit]
Description=Harness private preview gateway
[Service]
ExecStart=/usr/bin/env node /opt/harness-preview/gateway.mjs
Restart=on-failure
[Install]
WantedBy=multi-user.target
`);
      await runScript(vm, "world", `
stage_start=$(date +%s%3N)
mark() { now=$(date +%s%3N); printf '{"stage":"%s","durationMs":%s}\\n' "$1" "$((now-stage_start))" >> /opt/harness-preview/build-stages.jsonl; stage_start=$now; }
${checkoutRecipe(sha)}
mark checkout
tar -xf /opt/harness-preview/compiled.tar -C /workspace
mark compile
export PATH="/opt/harness-preview/tools/node_modules/.bin:$PATH"
systemctl daemon-reload
systemctl start harness-preview-runtime
${world === "app-web" ? "curl --retry 180 --retry-delay 1 --retry-max-time 180 --retry-all-errors -fsS http://127.0.0.1:5178/ >/dev/null" : `for attempt in $(seq 1 480); do
  test ! -f /opt/harness-preview/failed-world
  if test -f /opt/harness-preview/ready-world; then break; fi
  sleep 1
done
test -f /opt/harness-preview/ready-world`}
node /opt/harness-preview/health.mjs
${world === "app-web" ? `node /opt/harness-preview/refresh.mjs ${sha}` : ""}
systemctl enable --now harness-preview-gateway
mark boot-and-verify
`, options);
      const timings = await vm.fs.readTextFile("/opt/harness-preview/build-stages.jsonl");
      for (const line of timings.trim().split("\n")) {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || !("stage" in value) || typeof value.stage !== "string"
          || !["checkout", "compile", "boot-and-verify"].includes(value.stage) || !("durationMs" in value)
          || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) throw new Error("Invalid build timing");
        observe({ stage: value.stage, durationMs: value.durationMs });
      }
    },
  }, api);
  // Per-commit worlds are built on first launch and rarely reopened. Storage is
  // billed until deletion, so keep them two days at most and one day unused.
  return ensureLayer({ slug, stage: "world", observe, metadata: buildLabel(sha, world), ttlSeconds: 2 * 86400, autoDeleteSeconds: 86400,
    parent: async () => running.id,
    prepare: async (vm) => {
      log(`Refreshing ${world} at ${sha} from an isolated running template`);
      const start = performance.now();
      // Keep the isolated database and running processes. Only tracked frontend
      // source (or inert docs/CI files) may differ from this immutable template.
      await runScript(vm, "refresh", `${checkoutRecipe(sha).replace("git clean -ffdx -e node_modules/", "")}
node /opt/harness-preview/refresh.mjs ${sha}`, options);
      observe({ stage: "source-refresh", durationMs: Math.round(performance.now() - start) });
    },
  }, api);

}

/**
 * True while a builder VM started for this commit/world is alive. Between layers
 * and while the source tree is read there is briefly none, so callers should only
 * treat a sustained "not building, not ready" as a failed build.
 */
export async function isBuilding(sha: string, world: PreviewWorld, api = client()): Promise<boolean> {
  const { vms } = await api.vms.list({ metadata: `harnessBuild:${buildLabel(sha, world).harnessBuild}`, limit: 20 });
  return vms.some((vm) => vm.state === "starting" || vm.state === "running");
}
