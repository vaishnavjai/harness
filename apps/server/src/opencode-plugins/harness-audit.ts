import { createAuditLogger } from "@harness/audit";
import { harnessAuditLogPath } from "@harness/paths";
import { isRecord, summarizeToolArgs } from "./harness-audit-core.js";

// Records every tool the agent runs (shell commands, file writes and edits,
// MCP calls) in the Harness audit log before it executes, and its outcome
// after. Arguments are summarised, never copied wholesale: the log keeps the
// command and the file paths a tool touched, not file contents or tool output.

const audit = createAuditLogger({
  filePath: harnessAuditLogPath(),
  source: "engine",
  onError: (error) => console.warn("[harness-audit] could not write the audit log:", error),
});

export default async function harnessAudit() {
  return {
    "tool.execute.before": async (input: { tool: string; sessionID?: string; callID?: string }, output: { args: unknown }) => {
      audit.record({
        kind: "tool.execute",
        actor: "agent",
        subject: input.tool,
        detail: { session: input.sessionID ?? null, call: input.callID ?? null, ...summarizeToolArgs(input.tool, output.args) },
      });
    },
    "tool.execute.after": async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { title?: string; metadata?: unknown },
    ) => {
      const metadata = isRecord(output.metadata) ? output.metadata : {};
      const exit = typeof metadata.exit === "number" ? metadata.exit : null;
      audit.record({
        kind: "tool.result",
        actor: "agent",
        subject: input.tool,
        detail: { session: input.sessionID ?? null, call: input.callID ?? null, exit, title: output.title ?? null },
      });
    },
  };
}
