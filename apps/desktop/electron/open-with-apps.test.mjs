import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { discoverOpenWithApps, isDiscoveredOpenWithApp } from "./open-with-apps.mjs";

/** @param {string} name */
const platformOf = (name) => /** @type {NodeJS.Platform} */ (name);

function fakeFs(files) {
  return {
    readdir: async (dir) => {
      const names = Object.keys(files).filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1)).filter((name) => !name.includes("/"));
      if (!names.length) throw new Error("ENOENT");
      return names;
    },
    readFile: async (file) => {
      if (!(file in files)) throw new Error("ENOENT");
      return files[file];
    },
  };
}

describe("open-with apps on Linux", () => {
  const fs = fakeFs({
    "/usr/share/applications/code.desktop": "[Desktop Entry]\nName=Code\nExec=/usr/bin/code %F\n",
    "/usr/share/applications/broken.desktop": "[Desktop Entry]\nName=No exec\n",
    "/usr/share/applications/readme.txt": "not a desktop entry",
  });
  const deps = { platform: platformOf("linux"), homedir: "/home/u", ...fs };

  it("lists the applications the desktop entries describe, with the Exec placeholders removed", async () => {
    assert.deepEqual(await discoverOpenWithApps(deps), [{ name: "Code", appPath: "/usr/bin/code", icon: null }]);
  });

  it("accepts a listed application and refuses everything else", async () => {
    assert.equal(await isDiscoveredOpenWithApp("/usr/bin/code", deps), true);
    for (const other of ["/tmp/evil", "/usr/bin/code --extra", "", "  ", "../../bin/sh", "/workspace/payload"]) {
      assert.equal(await isDiscoveredOpenWithApp(other, deps), false, other);
    }
  });
});

describe("open-with apps on macOS and elsewhere", () => {
  it("lists .app bundles only", async () => {
    const fs = fakeFs({ "/Applications/TextEdit.app": "", "/Applications/notes.txt": "", "/System/Applications/Preview.app": "" });
    const apps = await discoverOpenWithApps({ platform: platformOf("darwin"), homedir: "/Users/u", ...fs });
    assert.deepEqual(apps.map((entry) => entry.appPath).sort(), ["/Applications/TextEdit.app", "/System/Applications/Preview.app"]);
    assert.equal(await isDiscoveredOpenWithApp("/Applications/TextEdit.app", { platform: platformOf("darwin"), homedir: "/Users/u", ...fs }), true);
    assert.equal(await isDiscoveredOpenWithApp("/tmp/Evil.app", { platform: platformOf("darwin"), homedir: "/Users/u", ...fs }), false);
  });

  it("offers nothing on Windows", async () => {
    assert.deepEqual(await discoverOpenWithApps({ platform: platformOf("win32"), homedir: "C:\\Users\\u", ...fakeFs({}) }), []);
  });
});
