import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  desktopBootstrapPath,
  globalOpencodeConfigDir,
  legacyDesktopBootstrapPath,
  MAX_CONFIG_ROOT_LENGTH,
  normalizeWorkspaceRootPath,
  opencodeDbCandidates,
  harnessAuditLogPath,
  harnessEnvStorePath,
  harnessLocalDataDir,
  harnessMemoryDataDir,
  harnessServerConfigPath,
  resolveGlobalOpencodeConfigPath,
  resolveWorkspaceOpencodeConfigPath,
  workspaceOpencodeConfigCandidates,
} from "../index.mjs";

async function withTempDir(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "harness-paths-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("workspace root paths", () => {
  test("normalizes valid Windows verbatim drive and UNC paths cross-platform", () => {
    const opts = { platform: "win32" };
    expect(normalizeWorkspaceRootPath("\\\\?\\C:\\Users\\Ada\\Workspace", opts))
      .toBe("C:\\Users\\Ada\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\?\\C:\\", opts)).toBe("C:\\");
    expect(normalizeWorkspaceRootPath("//?/UNC/server/share/Workspace", opts))
      .toBe("\\\\server\\share\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\?\\UNC\\server\\share", opts))
      .toBe("\\\\server\\share");
  });

  test("preserves valid normal drives and UNC shares without checking availability", () => {
    const opts = { platform: "win32" };
    expect(normalizeWorkspaceRootPath("Z:\\Disconnected\\Workspace", opts))
      .toBe("Z:\\Disconnected\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\offline-server\\share\\Workspace", opts))
      .toBe("\\\\offline-server\\share\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\offline-server\\pipe\\Workspace", opts))
      .toBe("\\\\offline-server\\pipe\\Workspace");
  });

  test("rejects Win32 device namespace roots", () => {
    const opts = { platform: "win32" };
    for (const value of [
      "\\\\.\\pipe\\harness",
      "//./PIPE/harness",
      "\\\\.\\PhysicalDrive0",
      "\\\\?\\UNC\\.\\pipe\\harness",
      "\\\\?\\UNC\\?\\PhysicalDrive0",
    ]) {
      expect(() => normalizeWorkspaceRootPath(value, opts)).toThrow("Invalid Windows workspace root");
    }
  });

  test("rejects incomplete Windows drive and UNC roots", () => {
    const opts = { platform: "win32" };
    for (const value of [
      "C:",
      "\\\\?\\",
      "\\\\?\\C:",
      "\\\\?\\C:Workspace",
      "\\\\?\\UNC",
      "\\\\?\\UNC\\server",
      "\\\\server",
    ]) {
      expect(() => normalizeWorkspaceRootPath(value, opts)).toThrow("Invalid Windows workspace root");
    }
  });

  test("applies Windows validation only when Windows is injected", () => {
    expect(normalizeWorkspaceRootPath("\\\\?\\C:", { platform: "linux" })).toBe("\\\\?\\C:");
  });
});

describe("OpenCode database paths", () => {
  test("uses the production channel name and honors explicit overrides", () => {
    expect(opencodeDbCandidates({
      env: {},
      homeDir: "/Users/ada",
      platform: "darwin",
      defaultChannel: "latest",
    })).toContain("/Users/ada/Library/Application Support/opencode/opencode.db");
    expect(opencodeDbCandidates({
      env: { OPENCODE_CHANNEL: "preview" },
      dataDirs: ["/tmp/opencode"],
      homeDir: "/Users/ada",
      platform: "darwin",
    })[0]).toBe("/tmp/opencode/opencode-preview.db");
    expect(opencodeDbCandidates({
      env: { OPENCODE_DB: "/tmp/production.db" },
      homeDir: "/Users/ada",
      platform: "darwin",
    })).toEqual(["/tmp/production.db"]);
  });
});

describe("harness server config paths", () => {
  test("uses APPDATA on Windows", () => {
    expect(harnessServerConfigPath({
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
      homeDir: "C:\\Users\\Ada",
      platform: "win32",
    })).toBe("C:\\Users\\Ada\\AppData\\Roaming\\harness\\server.json");
  });

  test("uses XDG_CONFIG_HOME on Unix", () => {
    expect(harnessServerConfigPath({
      env: { XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/xdg/harness/server.json");
  });

  test("falls back to ~/.config", () => {
    expect(harnessServerConfigPath({ env: {}, homeDir: "/home/ada", platform: "linux" }))
      .toBe("/home/ada/.config/harness/server.json");
  });

  test("honors HARNESS_SERVER_CONFIG", () => {
    expect(harnessServerConfigPath({
      env: { HARNESS_SERVER_CONFIG: "/tmp/harness/server.json" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/harness/server.json");
  });
});

describe("harness env store and desktop bootstrap paths", () => {
  test("honors HARNESS_ENV_STORE", () => {
    expect(harnessEnvStorePath({
      env: { HARNESS_ENV_STORE: "/tmp/harness/env.json" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/harness/env.json");
  });

  test("uses the same harness config layout for env.json", () => {
    expect(harnessEnvStorePath({
      env: { XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/xdg/harness/env.json");
  });

  test("honors HARNESS_DESKTOP_BOOTSTRAP_PATH", () => {
    expect(desktopBootstrapPath({
      env: { HARNESS_DESKTOP_BOOTSTRAP_PATH: "/tmp/bootstrap.json" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/bootstrap.json");
  });

  test("preserves dev-data desktop bootstrap path when userDataDir is injected", () => {
    expect(desktopBootstrapPath({
      env: { HARNESS_DEV_MODE: "1" },
      homeDir: "/Users/ada",
      platform: "darwin",
      userDataDir: "/tmp/harness-userdata",
    })).toBe("/tmp/harness-userdata/harness-dev-data/home/.config/harness/desktop-bootstrap.json");
  });

  test("resolves the legacy desktop bootstrap path from the chosen home", () => {
    expect(legacyDesktopBootstrapPath({ env: {}, homeDir: "/Users/ada", platform: "darwin" }))
      .toBe("/Users/ada/.config/harness/desktop-bootstrap.json");
  });
});

describe("global OpenCode config paths", () => {
  test("accepts safe OPENCODE_CONFIG_DIR as the config directory", async () => {
    await withTempDir(async (root) => {
      const opencodeConfigDir = path.join(root, "explicit-opencode");
      await mkdir(opencodeConfigDir, { recursive: true });
      const json = path.join(opencodeConfigDir, "opencode.json");
      await writeFile(json, "{}", "utf8");

      const opts = {
        env: { OPENCODE_CONFIG_DIR: opencodeConfigDir, XDG_CONFIG_HOME: path.join(root, "xdg") },
        homeDir: path.join(root, "home"),
        platform: "linux",
      };
      expect(globalOpencodeConfigDir(opts)).toBe(opencodeConfigDir);
      expect(resolveGlobalOpencodeConfigPath(opts)).toBe(json);
    });
  });

  test("prefers opencode.jsonc over opencode.json and falls back to jsonc", async () => {
    await withTempDir(async (root) => {
      const dir = path.join(root, "xdg", "opencode");
      await mkdir(dir, { recursive: true });
      const opts = { env: { XDG_CONFIG_HOME: path.join(root, "xdg") }, homeDir: path.join(root, "home"), platform: "linux" };
      const jsonc = path.join(dir, "opencode.jsonc");
      const json = path.join(dir, "opencode.json");

      expect(resolveGlobalOpencodeConfigPath(opts)).toBe(jsonc);
      await writeFile(json, "{}", "utf8");
      expect(resolveGlobalOpencodeConfigPath(opts)).toBe(json);
      await writeFile(jsonc, "{}", "utf8");
      expect(resolveGlobalOpencodeConfigPath(opts)).toBe(jsonc);
    });
  });

  test("rejects relative OPENCODE_CONFIG_DIR", () => {
    const opts = {
      env: { OPENCODE_CONFIG_DIR: "relative/opencode", XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    };
    expect(globalOpencodeConfigDir(opts)).toBe("/tmp/xdg/opencode");
  });

  test("rejects over-long OPENCODE_CONFIG_DIR", () => {
    const opts = {
      env: { OPENCODE_CONFIG_DIR: `/${"a".repeat(MAX_CONFIG_ROOT_LENGTH)}`, XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    };
    expect(globalOpencodeConfigDir(opts)).toBe("/tmp/xdg/opencode");
  });

  test("rejects forbidden control characters in OPENCODE_CONFIG_DIR", () => {
    const opts = {
      env: { OPENCODE_CONFIG_DIR: "/tmp/opencode\n", XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    };
    expect(globalOpencodeConfigDir(opts)).toBe("/tmp/xdg/opencode");
  });
});

describe("workspace OpenCode config paths", () => {
  test("returns the four server candidates in order", () => {
    expect(workspaceOpencodeConfigCandidates("/repo/workspace")).toEqual([
      "/repo/workspace/opencode.jsonc",
      "/repo/workspace/opencode.json",
      "/repo/workspace/.opencode/opencode.jsonc",
      "/repo/workspace/.opencode/opencode.json",
    ]);
  });

  test("resolves the first existing workspace candidate", async () => {
    await withTempDir(async (root) => {
      await mkdir(path.join(root, ".opencode"), { recursive: true });
      const hiddenJsonc = path.join(root, ".opencode", "opencode.jsonc");
      const hiddenJson = path.join(root, ".opencode", "opencode.json");
      await writeFile(hiddenJson, "{}", "utf8");
      expect(resolveWorkspaceOpencodeConfigPath(root)).toBe(hiddenJson);
      await writeFile(hiddenJsonc, "{}", "utf8");
      expect(resolveWorkspaceOpencodeConfigPath(root)).toBe(hiddenJsonc);
    });
  });
});

describe("harness local data and audit paths", () => {
  test("live under ~/.config/harness on POSIX, honoring XDG_CONFIG_HOME", () => {
    const opts = { platform: "linux", env: {}, homeDir: "/home/alex" };
    expect(harnessLocalDataDir(opts)).toBe("/home/alex/.config/harness/data");
    expect(harnessMemoryDataDir(opts)).toBe("/home/alex/.config/harness/data/hindsight");
    expect(harnessAuditLogPath(opts)).toBe("/home/alex/.config/harness/audit.log");
    const xdg = { platform: "darwin", env: { XDG_CONFIG_HOME: "/tmp/xdg" }, homeDir: "/Users/alex" };
    expect(harnessLocalDataDir(xdg)).toBe("/tmp/xdg/harness/data");
    expect(harnessAuditLogPath(xdg)).toBe("/tmp/xdg/harness/audit.log");
  });

  test("use %APPDATA%\\harness on Windows", () => {
    const opts = { platform: "win32", env: { APPDATA: "C:\\Users\\alex\\AppData\\Roaming" }, homeDir: "C:\\Users\\alex" };
    expect(harnessLocalDataDir(opts)).toBe("C:\\Users\\alex\\AppData\\Roaming\\harness\\data");
    expect(harnessAuditLogPath(opts)).toBe("C:\\Users\\alex\\AppData\\Roaming\\harness\\audit.log");
  });

  test("accept explicit overrides", () => {
    const opts = {
      platform: "linux",
      env: { HARNESS_LOCAL_DATA_DIR: "~/portable/data", HARNESS_AUDIT_LOG: "/var/tmp/audit.log" },
      homeDir: "/home/alex",
    };
    expect(harnessLocalDataDir(opts)).toBe("/home/alex/portable/data");
    expect(harnessMemoryDataDir(opts)).toBe("/home/alex/portable/data/hindsight");
    expect(harnessAuditLogPath(opts)).toBe("/var/tmp/audit.log");
  });
});
