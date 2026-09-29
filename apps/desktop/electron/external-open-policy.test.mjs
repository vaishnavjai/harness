import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { checkExternalUrl, checkOpenablePath, effectiveExtension, isCodeLaunchingType, isNetworkPath } from "./external-open-policy.mjs";

describe("checkExternalUrl", () => {
  it("allows web and mail links and returns the normalised URL", () => {
    assert.deepEqual(checkExternalUrl("https://example.com/a?b=1"), { ok: true, url: "https://example.com/a?b=1" });
    assert.deepEqual(checkExternalUrl("  http://127.0.0.1:3005/x "), { ok: true, url: "http://127.0.0.1:3005/x" });
    assert.equal(checkExternalUrl("mailto:someone@example.com?subject=hi").ok, true);
  });

  it("refuses every other scheme, including the ones that run code", () => {
    for (const url of [
      "file:///C:/Windows/System32/calc.exe", "file://attacker/share/payload.exe", "javascript:alert(1)", "data:text/html,<script>1</script>",
      "ms-msdt:/id PCWDiagnostic", "search-ms:query=x&crumb=location:\\\\attacker\\share", "smb://attacker/share", "vscode://x", "steam://run/1",
      "tel:123", "ftp://example.com/x", "harness://chat?prompt=x", "\\\\attacker\\share\\payload.exe", "C:\\Windows\\System32\\cmd.exe", "calc.exe",
    ]) {
      assert.equal(checkExternalUrl(url).ok, false, url);
    }
  });

  it("refuses empty, non-string, oversized and credential-bearing input", () => {
    for (const value of ["", "   ", null, undefined, 42, {}, `https://example.com/${"a".repeat(9_000)}`, "https://user:pass@example.com/", "https://user@example.com/"]) {
      assert.equal(checkExternalUrl(value).ok, false, String(value));
    }
  });

  it("returns what the parser sees, so quotes and line breaks cannot smuggle arguments", () => {
    const result = checkExternalUrl('http://example.com/x y"z\nnext');
    assert.equal(result.ok, true);
    assert.equal(result.url, "http://example.com/x%20y%22znext");
    assert.equal(checkExternalUrl("https://exa\u0000mple.com/").ok, false);
  });
});

describe("what counts as code", () => {
  it("recognises executables and scripts on every platform, case-insensitively", () => {
    for (const name of ["a.exe", "A.EXE", "run.bat", "x.cmd", "s.ps1", "s.vbs", "s.js", "x.lnk", "x.url", "x.msi", "Tool.app", "x.command", "x.pkg", "x.sh", "x.AppImage", "x.desktop", "x.py", "x.jar", "x.search-ms"]) {
      assert.equal(isCodeLaunchingType(name), true, name);
    }
  });

  it("treats a name that is only a dot and an extension as having that extension", () => {
    for (const name of [".bat", ".cmd", ".exe", ".lnk", ".ps1", "C:\\work\\.bat", "/w/.sh"]) {
      assert.equal(isCodeLaunchingType(name), true, name);
    }
    assert.equal(effectiveExtension(".gitignore"), "gitignore");
    assert.equal(isCodeLaunchingType(".gitignore"), false);
    assert.equal(isCodeLaunchingType(".env"), false);
  });

  it("knows the less common types that run or connect when opened", () => {
    for (const name of ["a.rdp", "a.jnlp", "a.pyz", "a.wsc", "a.shs", "a.msh", "a.xbap", "a.vsto", "a.website"]) {
      assert.equal(isCodeLaunchingType(name), true, name);
    }
  });

  it("sees through the trailing dots and spaces Windows ignores", () => {
    assert.equal(effectiveExtension("payload.exe."), "exe");
    assert.equal(effectiveExtension("payload.exe  "), "exe");
    assert.equal(isCodeLaunchingType("C:\\x\\payload.exe. ."), true);
  });

  it("leaves documents, images and data alone", () => {
    for (const name of ["a.md", "a.txt", "a.pdf", "a.png", "a.json", "a.docx", "a.csv", "README", ".gitignore", "a.tar.gz"]) {
      assert.equal(isCodeLaunchingType(name), false, name);
    }
  });
});

/** The refusal reason, or null when the path may be opened. */
function reasonOf(decision) {
  return decision.ok === false ? decision.reason : null;
}

describe("checkOpenablePath", () => {
  async function scratch(fn) {
    const dir = await mkdtemp(join(tmpdir(), "harness-open-policy-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("opens folders and ordinary files", async () => {
    await scratch(async (dir) => {
      await writeFile(join(dir, "notes.md"), "hi");
      await mkdir(join(dir, "sub"));
      assert.equal((await checkOpenablePath(join(dir, "notes.md"))).ok, true);
      assert.equal((await checkOpenablePath(join(dir, "sub"))).ok, true);
    });
  });

  it("refuses code by extension and says where to find it", async () => {
    await scratch(async (dir) => {
      for (const name of ["payload.exe", "run.sh", "setup.msi", "shortcut.lnk"]) {
        await writeFile(join(dir, name), "x");
        const result = await checkOpenablePath(join(dir, name));
        assert.equal(result.ok, false, name);
        assert.equal(reasonOf(result), "unsafe-type");
        assert.ok(result.path);
      }
    });
  });

  it("refuses a path under a program, which is what a reveal fallback would open", async () => {
    await scratch(async (dir) => {
      await writeFile(join(dir, "payload.sh"), "x");
      const result = await checkOpenablePath(join(dir, "payload.sh"));
      assert.equal(reasonOf(result), "unsafe-type");
      await mkdir(join(dir, "Tool.app"));
      assert.equal(reasonOf(await checkOpenablePath(join(dir, "Tool.app"))), "unsafe-type");
    });
  });

  it("refuses an app bundle folder", async () => {
    await scratch(async (dir) => {
      await mkdir(join(dir, "Evil.app"));
      assert.equal(reasonOf(await checkOpenablePath(join(dir, "Evil.app"))), "unsafe-type");
    });
  });

  it("refuses a harmless-looking name that links to code", async () => {
    await scratch(async (dir) => {
      await writeFile(join(dir, "payload.exe"), "x");
      await symlink(join(dir, "payload.exe"), join(dir, "readme.txt"));
      assert.equal(reasonOf(await checkOpenablePath(join(dir, "readme.txt"))), "unsafe-type");
    });
  });

  it("treats an extensionless executable file as a program, but not on Windows semantics", async () => {
    await scratch(async (dir) => {
      await writeFile(join(dir, "runme"), "#!/bin/sh\n");
      await chmod(join(dir, "runme"), 0o755);
      await writeFile(join(dir, "Makefile"), "all:\n");
      await chmod(join(dir, "Makefile"), 0o644);
      if (process.platform !== "win32") {
        assert.equal(reasonOf(await checkOpenablePath(join(dir, "runme"))), "unsafe-type");
        assert.equal((await checkOpenablePath(join(dir, "Makefile"))).ok, true);
      }
    });
  });

  it("never resolves a network path on Windows", async () => {
    for (const value of ["\\\\attacker\\share\\x.txt", "//attacker/share/x.txt", "\\\\?\\UNC\\host\\share"]) {
      assert.equal(isNetworkPath(value), true, value);
    }
    let touched = 0;
    const result = await checkOpenablePath("\\\\attacker\\share\\x.txt", {
      platform: /** @type {NodeJS.Platform} */ ("win32"),
      realpath: async (value) => { touched += 1; return value; },
      stat: async () => { touched += 1; throw new Error("no"); },
    });
    assert.equal(reasonOf(result), "invalid");
    assert.equal(touched, 0);
    assert.equal(isNetworkPath("C:\\work\\x.txt"), false);
    assert.equal(isNetworkPath("/home/u/x.txt"), false);
  });

  it("rejects relative, empty and missing paths", async () => {
    assert.equal(reasonOf(await checkOpenablePath("")), "invalid");
    assert.equal(reasonOf(await checkOpenablePath("relative/file.txt")), "invalid");
    assert.equal(reasonOf(await checkOpenablePath(join(tmpdir(), "definitely-not-here-xyz"))), "missing");
  });
});
