import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { readAuditTail, verifyAuditLog } from "@harness/audit";

import { createDesktopAudit, createTerminalCommandRecorder, summarizeCommandArgs } from "./desktop-audit.mjs";

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop audit", () => {
  test("summarises command arguments to identifiers, never contents", () => {
    assert.deepEqual(
      summarizeCommandArgs([{ workspaceId: "ws_1", name: "notes", content: "# private notes\nsecret stuff" }]),
      { workspaceId: "ws_1", name: "notes", contentChars: 28 },
    );
    assert.deepEqual(summarizeCommandArgs(["/tmp/a.txt", "x".repeat(2_000)]), { arg0: "/tmp/a.txt", arg1: "[2000 chars]" });
  });

  test("records submitted terminal commands but never input after a password prompt", () => {
    const commands = [];
    const recorder = createTerminalCommandRecorder({ onCommand: (command) => commands.push(command) });
    recorder.input("ls -la\r");
    recorder.input("git sta");
    recorder.input("\x7f\x7ftatus\r");
    recorder.input("sudo apt update\r");
    recorder.output("[sudo] password for alex: ");
    recorder.input("hunter2\r");
    recorder.output("\r\nEnter passphrase for key '/home/alex/.ssh/id_ed25519': ");
    recorder.input("correct horse\r");
    recorder.input("\x1b[Aecho done\r");
    recorder.input("rm -rf /\x03");
    recorder.input("\r");
    assert.deepEqual(commands, ["ls -la", "git status", "sudo apt update", "echo done"]);
  });

  test("writes only audited commands, on a verifiable chain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-desktop-audit-"));
    roots.push(root);
    const filePath = path.join(root, "audit.log");
    const audit = createDesktopAudit({ filePath });
    audit.command("workspaceHarnessWrite", [{ workspaceId: "ws_1", content: "x" }], { ok: true });
    audit.command("appBuildInfo", [], { ok: true });
    audit.terminalStarted({ terminalId: "t1", shell: "/bin/zsh", cwd: "/tmp" });
    audit.terminalRecorder("t1").input("pnpm test\r");
    audit.terminalExited({ terminalId: "t1", exitCode: 0, signal: null });
    await audit.flush();
    const kinds = (await readAuditTail(filePath, 10)).map((record) => record.kind).reverse();
    assert.deepEqual(kinds, ["desktop.workspaceHarnessWrite", "terminal.session.start", "terminal.command", "terminal.session.exit"]);
    assert.deepEqual(await verifyAuditLog(filePath), { ok: true, records: 4, sessions: 1 });
  });
});
