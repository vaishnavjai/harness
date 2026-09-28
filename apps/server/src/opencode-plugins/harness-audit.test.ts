import { describe, expect, test } from "bun:test";
import { readAuditTail, verifyAuditLog } from "@harness/audit";
import { harnessAuditLogPath } from "@harness/paths";

import harnessAudit, { summarizeToolArgs } from "./harness-audit.js";

describe("harness audit plugin", () => {
  test("summarises commands and file writes without copying contents", () => {
    expect(summarizeToolArgs("bash", { command: "git status", workdir: "/w" })).toEqual({
      command: "git status",
      workdir: "/w",
      toolKind: "command",
    });
    expect(summarizeToolArgs("write", { filePath: "/w/a.md", content: "hello" })).toEqual({
      path: "/w/a.md",
      contentBytes: 5,
      toolKind: "file.write",
    });
    expect(summarizeToolArgs("mcp_search", { query: "q", limit: 3 })).toEqual({ argKeys: "query,limit", toolKind: "tool" });
  });

  test("records each tool call before and after it runs, on a verifiable chain", async () => {
    const hooks = await harnessAudit();
    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_1", callID: "call_1" },
      { args: { command: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstu npm test" } },
    );
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_1", callID: "call_1" }, { title: "npm test", metadata: { exit: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [after, before] = await readAuditTail(harnessAuditLogPath(), 2);
    expect(before?.kind).toBe("tool.execute");
    expect(before?.source).toBe("engine");
    expect(before?.actor).toBe("agent");
    expect(before?.detail?.command).toBe("OPENAI_API_KEY=[redacted] npm test");
    expect(after?.kind).toBe("tool.result");
    expect(after?.detail?.exit).toBe(0);
    expect((await verifyAuditLog(harnessAuditLogPath())).ok).toBe(true);
  });
});
