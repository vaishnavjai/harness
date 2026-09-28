import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  electronProfilePaths,
  electronSurfaceEnv,
  liveSharedProductionStateEnv,
  removeOwnedSurfaceFiles,
  resolveInstalledProductionDesktopState,
} from "@harness/hosts";
import {
  test,
} from "@harness/testkit";
import { desktopProductionLive } from "../../worlds/desktop-prod-live.ts";

test("live shared production desktop state requires consent and selects state without mutating it", async ({ evidence }) => {
  let stateAcquisitions = 0;
  await assert.rejects(
    () => Reflect.apply(desktopProductionLive, undefined, [{
      resolveInstalledProductionState: async () => {
        stateAcquisitions += 1;
        throw new Error("Installed production state must not be acquired without consent.");
      },
    }]),
    /without explicit allowSharedState: true consent/,
  );
  assert.equal(stateAcquisitions, 0);

  const fixtureRoot = await mkdtemp(join(tmpdir(), "harness-prod-live-state-"));
  try {
    const homeDir = join(fixtureRoot, "home");
    const dataDir = join(homeDir, ".harness", "harness-server");
    const configDir = join(homeDir, ".config", "harness");
    const opencodeConfigDir = join(homeDir, ".config", "opencode");
    const userDataDir = join(homeDir, "Library", "Application Support", "com.vaishnavjai.harness");
    const opencodeDb = join(homeDir, "Library", "Application Support", "opencode", "opencode.db");
    await mkdir(dataDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(opencodeConfigDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(dirname(opencodeDb), { recursive: true });
    await writeFile(opencodeDb, "fixture", "utf8");
    for (const path of [
      join(configDir, "desktop-bootstrap.json"),
      join(configDir, "env.json"),
      join(configDir, "server.json"),
      join(userDataDir, "harness-server-state.json"),
      join(userDataDir, "harness-server-tokens.json"),
      join(userDataDir, "harness-workspaces.json"),
    ]) {
      await writeFile(path, "{}\n", "utf8");
    }

    const resolved = await resolveInstalledProductionDesktopState({
      env: {},
      homeDir,
      platform: "darwin",
    });
    assert.deepEqual(resolved, {
      bootstrapPath: join(configDir, "desktop-bootstrap.json"),
      dataDir,
      envStorePath: join(configDir, "env.json"),
      homeDir,
      opencodeDb,
      opencodeConfigDir,
      serverConfigPath: join(configDir, "server.json"),
      serverStatePath: join(userDataDir, "harness-server-state.json"),
      serverTokenStorePath: join(userDataDir, "harness-server-tokens.json"),
      workspaceStatePath: join(userDataDir, "harness-workspaces.json"),
    });

    const isolatedProfile = join(fixtureRoot, "isolated-eval-profile");
    const profilePaths = electronProfilePaths(isolatedProfile);
    await mkdir(profilePaths.userDataDir, { recursive: true });
    const launchEnv = electronSurfaceEnv(
      profilePaths,
      {
        appName: "Harness Eval production-live",
        appIdentifier: "com.vaishnavjai.harness.eval.production-live",
        port: 31_001,
        cdpPort: 31_002,
      },
      liveSharedProductionStateEnv(resolved),
    );
    assert.equal(launchEnv.HARNESS_DATA_DIR, dataDir);
    assert.equal(launchEnv.OPENCODE_DB, opencodeDb);
    assert.equal(launchEnv.HARNESS_DESKTOP_WORKSPACE_STATE_PATH, join(userDataDir, "harness-workspaces.json"));
    assert.equal(launchEnv.HARNESS_SERVER_TOKEN_STORE_PATH, join(userDataDir, "harness-server-tokens.json"));
    assert.equal(launchEnv.HARNESS_SERVER_STATE_PATH, join(userDataDir, "harness-server-state.json"));
    assert.equal(launchEnv.HARNESS_ENV_STORE, join(configDir, "env.json"));
    assert.equal(launchEnv.HARNESS_SERVER_CONFIG, join(configDir, "server.json"));
    assert.equal(launchEnv.HARNESS_DEV_SHARED_STATE, "1");
    assert.equal(launchEnv.HARNESS_ELECTRON_USERDATA, profilePaths.userDataDir);
    assert.notEqual(launchEnv.HARNESS_ELECTRON_USERDATA, dataDir);
    assert.equal(launchEnv.HARNESS_ELECTRON_APP_IDENTIFIER, "com.vaishnavjai.harness.eval.production-live");
    assert.equal(launchEnv.HARNESS_ELECTRON_REMOTE_DEBUG_PORT, "31002");

    await removeOwnedSurfaceFiles({
      name: "production-live",
      kind: "electron",
      hostKind: "local",
      cdpUrl: "http://127.0.0.1:31002",
      profileDir: isolatedProfile,
      meta: { profileOwner: "host" },
    });
    await assert.rejects(() => access(isolatedProfile));
    await access(dataDir);
    await access(opencodeDb);
    assert.equal(await readFile(opencodeDb, "utf8"), "fixture");
    assert.equal(await readFile(join(configDir, "desktop-bootstrap.json"), "utf8"), "{}\n");

    evidence.recordAssertionEvidence(
      "Live production state requires explicit consent before state acquisition",
      "The direct builder refused an omitted allowSharedState: true value without invoking its installed-state resolver.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Dev Electron points at installed production stores from an isolated profile",
      "The launch environment selected production Harness, OpenCode, workspace, config, and token paths while retaining an isolated Electron userData directory.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Cleanup owns only the isolated dev profile and does not mutate selected production state",
      "Cleanup removed the eval profile while preserving the production bootstrap content and OpenCode database bytes.",
      true,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
