import { mkdir, writeFile } from "node:fs/promises";
import { launchHeadlessWeb } from "/workspace/packages/world/src/headless-web.ts";

const root = "/opt/harness-preview/state";
for (const dir of ["home", "cache", "config/harness", "config/opencode", "data/harness", "data/opencode", "workspace"]) {
  await mkdir(`${root}/${dir}`, { recursive: true });
}
const runtime = await launchHeadlessWeb({
  repoRoot: "/workspace", name: "freestyle-preview", state: "isolated",
  workspace: `${root}/workspace`, browserHostSuffix: ".preview.harness-legacy.invalid",
  env: {
    PATH: process.env.PATH,
    // Dependencies were verified before snapshotting; changing HOME must not trigger a reinstall.
    pnpm_config_verify_deps_before_run: "false",
    HOME: `${root}/home`, XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, XDG_CACHE_HOME: `${root}/cache`,
    HARNESS_DATA_DIR: `${root}/data/harness`, HARNESS_ENV_STORE: `${root}/config/harness/env.json`,
    HARNESS_SERVER_STATE_PATH: `${root}/data/harness/server-state.json`,
    HARNESS_SERVER_TOKEN_STORE_PATH: `${root}/data/harness/server-tokens.json`,
    OPENCODE_CONFIG_DIR: `${root}/config/opencode`, OPENCODE_DB: `${root}/data/opencode/opencode.db`,
    HARNESS_DEV_HEADLESS_WEB_DEN_PROXY: "1", HARNESS_DEV_DEN_PROXY_TARGET: "https://app.harness.invalid", VITE_DISABLE_HARNESS_MODELS: "0",
    VITE_HARNESS_POSTHOG_KEY: "", VITE_HARNESS_SENTRY_DSN: "",
    HARNESS_PORT: "8778", HARNESS_WEB_PORT: "5178", HOST: "127.0.0.1", VITE_HOST: "127.0.0.1",
  },
});
await writeFile("/opt/harness-preview/services.json", JSON.stringify({ app: runtime.manifest.webUrl, engine: runtime.manifest.harnessUrl }), { mode: 0o600 });
await writeFile("/opt/harness-preview/outputs.json", JSON.stringify({
  harnessToken: { value: runtime.manifest.token, secret: true, group: "Harness" },
  harnessHostToken: { value: runtime.manifest.hostToken, secret: true, group: "Harness" },
}), { mode: 0o600 });
await runtime.detach();
