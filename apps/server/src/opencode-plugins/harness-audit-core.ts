import type { AuditDetailValue } from "@harness/audit";

// Helpers for the harness-audit engine plugin. Kept out of the plugin entry
// because OpenCode calls every function a plugin module exports.

const PATH_KEYS = ["filePath", "file_path", "path", "target", "destination"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
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
