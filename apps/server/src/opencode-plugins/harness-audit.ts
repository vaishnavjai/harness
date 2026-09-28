import { createAuditLogger, type AuditDetailValue } from "@harness/audit";
import { harnessAuditLogPath } from "@harness/paths";

// Records every tool the agent runs (shell commands, file writes and edits,
// MCP calls) in the Harness audit log before it executes, and its outcome
// after. Arguments are summarised, never copied wholesale: the log keeps the
// command and the file paths a tool touched, not file contents or tool output.

const audit = createAuditLogger({
  filePath: harnessAuditLogPath(),
  source: "engine",
  onError: (error) => console.warn("[harness-audit] could not write the audit log:", error),
});

const PATH_KEYS = ["filePath", "file_path", "path", "target", "destination"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The audit-relevant parts of a tool call's arguments. */
export function summarizeToolArgs(tool: string, args: unknown): Record<string, AuditDetailValue> {
  if (!isRecord(args)) return {};
  const detail: Record<string, AuditDetailValue> = {};
  if (typeof args.command === "string") detail.command = args.command;
  if (typeof args.workdir === "string") detail.workdir = args.workdir;
  for (const key of PATH_KEYS) {
    if (typeof args[key] === "string") {
      detail.path = args[key];
      break;
    }
  }
  if (typeof args.content === "string") detail.contentBytes = Buffer.byteLength(args.content);
  if (typeof args.newString === "string") detail.editBytes = Buffer.byteLength(args.newString);
  if (typeof args.patchText === "string") detail.patchBytes = Buffer.byteLength(args.patchText);
  if (typeof args.url === "string") detail.url = args.url;
  if (!Object.keys(detail).length) detail.argKeys = Object.keys(args).slice(0, 12).join(",");
  detail.toolKind = /^(bash|shell)$/i.test(tool) ? "command" : /^(write|edit|patch|multiedit)$/i.test(tool) ? "file.write" : "tool";
  return detail;
}

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
