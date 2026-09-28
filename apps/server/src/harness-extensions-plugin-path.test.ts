import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { harnessPluginPath } from "./harness-extensions-plugin-path.js";

function withPluginDir(value: string | undefined, fn: () => void) {
  const previous = process.env.HARNESS_EXTENSIONS_PLUGIN_DIR;
  if (value === undefined) {
    delete process.env.HARNESS_EXTENSIONS_PLUGIN_DIR;
  } else {
    process.env.HARNESS_EXTENSIONS_PLUGIN_DIR = value;
  }

  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.HARNESS_EXTENSIONS_PLUGIN_DIR;
    } else {
      process.env.HARNESS_EXTENSIONS_PLUGIN_DIR = previous;
    }
  }
}

function restoreResourcesPath(previous: string | undefined) {
  if (previous === undefined) {
    delete process.resourcesPath;
  } else {
    process.resourcesPath = previous;
  }
}

describe("harnessPluginPath", () => {
  test("prefers HARNESS_EXTENSIONS_PLUGIN_DIR", () => {
    withPluginDir("/opt/harness/opencode-plugins", () => {
      const resourcesPath = join("/Applications", "Harness.app", "Contents", "Resources");
      const previousResourcesPath = process.resourcesPath;
      process.resourcesPath = resourcesPath;
      try {
        expect(harnessPluginPath("harness-extensions-preview", join(resourcesPath, "app.asar", "server", "dist")))
          .toBe(join("/opt/harness/opencode-plugins", "harness-extensions-preview.js"));
      } finally {
        restoreResourcesPath(previousResourcesPath);
      }
    });
  });

  test("uses external resources plugin path in packaged Electron when env is unset", () => {
    withPluginDir(undefined, () => {
      const previousResourcesPath = process.resourcesPath;
      const resourcesPath = join("/Applications", "Harness.app", "Contents", "Resources");
      process.resourcesPath = resourcesPath;
      try {
        const pluginPath = harnessPluginPath(
          "harness-extensions-preview",
          join(resourcesPath, "app.asar", "server", "dist"),
        );

        expect(pluginPath).toBe(join(resourcesPath, "opencode-plugins", "harness-extensions-preview.js"));
        expect(pluginPath).not.toContain("app.asar");
      } finally {
        restoreResourcesPath(previousResourcesPath);
      }
    });
  });

  test("uses source plugin path in development when env is unset", () => {
    withPluginDir(undefined, () => {
      const here = join("/repo", "apps", "server", "src");
      expect(harnessPluginPath("harness-extensions-preview", here))
        .toBe(join(here, "opencode-plugins", "harness-extensions-preview.ts"));
    });
  });
});
