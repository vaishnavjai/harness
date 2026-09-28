/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import type { HarnessAuditRecord } from "@harness/types/desktop-ipc";

import { Button } from "@/components/ui/button";
import { auditLogRead, auditLogVerify } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { cn } from "@/lib/utils";
import {
  LayoutSection,
  LayoutSectionContent,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { SettingsListSearchInput } from "../settings-list";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";

const SOURCE_LABEL: Record<HarnessAuditRecord["source"], string> = {
  desktop: "Desktop",
  server: "Local server",
  engine: "Agent",
  memory: "Memory",
};

/** Plain-language summary of a record, sentence-first (DESIGN C4). */
export function describeAuditRecord(record: HarnessAuditRecord): string {
  const detail = record.detail ?? {};
  const command = typeof detail.command === "string" ? detail.command : null;
  const path = typeof detail.path === "string" ? detail.path : null;
  switch (record.kind) {
    case "tool.execute":
      if (command) return `Agent ran \`${command}\``;
      if (path) return `Agent used ${record.subject ?? "a tool"} on ${path}`;
      return `Agent used ${record.subject ?? "a tool"}`;
    case "tool.result":
      return `${record.subject ?? "Tool"} finished${typeof detail.exit === "number" ? ` with exit code ${detail.exit}` : ""}`;
    case "terminal.command":
      return `Ran \`${record.subject ?? ""}\` in a terminal`;
    case "terminal.session.start":
      return `Opened a terminal (${record.subject ?? "shell"})`;
    case "terminal.session.exit":
      return "Closed a terminal";
    default:
      if (record.kind.startsWith("desktop.") || record.kind.startsWith("server.")) {
        const action = record.kind.split(".").slice(1).join(" ");
        return `${action}${record.subject && record.subject !== record.kind.split(".")[1] ? ` · ${record.subject}` : ""}`;
      }
      return record.kind;
  }
}

export function AuditLogView() {
  if (!isDesktopRuntime()) {
    return (
      <LayoutStack>
        <SettingsNotice>The audit log is kept by the Harness desktop app.</SettingsNotice>
      </LayoutStack>
    );
  }
  return <DesktopAuditLogView />;
}

function DesktopAuditLogView() {
  const [filter, setFilter] = useState("");
  const records = useQuery({ queryKey: ["audit", "tail"], queryFn: () => auditLogRead({ limit: 300 }), refetchInterval: 10_000 });
  const verification = useQuery({ queryKey: ["audit", "verify"], queryFn: () => auditLogVerify() });

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = records.data?.records ?? [];
    if (!needle) return all;
    return all.filter((record) =>
      [record.kind, record.subject ?? "", describeAuditRecord(record), JSON.stringify(record.detail ?? {})]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [filter, records.data]);

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>Audit log</LayoutSectionTitle>
        </LayoutSectionHeader>
        <LayoutSectionContent>
          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>Integrity</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>
                <span className="font-mono text-xs">{records.data?.path ?? "~/.config/harness/audit.log"}</span>
              </LayoutSectionItemDescription>
              <LayoutSectionItemHeaderActions>
                {verification.data ? (
                  <SettingsStatusBadge
                    tone={verification.data.ok ? "ready" : "error"}
                    label={
                      verification.data.ok
                        ? `Chain intact · ${verification.data.records} records`
                        : `Tampering found at line ${verification.data.firstBreak?.line ?? "?"}`
                    }
                  />
                ) : null}
                <Button variant="outline" size="sm" disabled={verification.isFetching} onClick={() => void verification.refetch()}>
                  Verify now
                </Button>
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
            {verification.data && !verification.data.ok ? (
              <SettingsNotice tone="error">{verification.data.firstBreak?.reason}</SettingsNotice>
            ) : null}
          </LayoutSectionItem>

          <SettingsListSearchInput value={filter} placeholder="Filter by command, path or tool" onChange={(event) => setFilter(event.target.value)} />

          {records.isPending ? (
            <div className="h-40 animate-pulse rounded-xl bg-dls-hover" />
          ) : records.isError ? (
            <SettingsNotice tone="error">Couldn't read the audit log. Check that Harness can open the file above.</SettingsNotice>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {filter ? "No records match this filter." : "Nothing recorded yet. Agent tool runs, terminal commands and file writes appear here."}
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-dls-border">
              {visible.map((record) => (
                <AuditRow key={record.hash} record={record} />
              ))}
            </div>
          )}
        </LayoutSectionContent>
      </LayoutSection>
    </LayoutStack>
  );
}

function AuditRow({ record }: { record: HarnessAuditRecord }) {
  const [open, setOpen] = useState(false);
  const time = new Date(record.ts);
  return (
    <div className="py-2 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={14} className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="w-36 shrink-0 font-mono text-xs text-muted-foreground" title={record.ts}>
          {Number.isNaN(time.getTime()) ? record.ts : time.toLocaleString()}
        </span>
        <span className="min-w-0 flex-1 truncate text-dls-text">{describeAuditRecord(record)}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{SOURCE_LABEL[record.source] ?? record.source}</span>
      </button>
      {open ? (
        <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 pl-7 text-xs">
          <dt className="text-muted-foreground">Event</dt>
          <dd className="font-mono">{record.kind}</dd>
          <dt className="text-muted-foreground">Initiated by</dt>
          <dd>{record.actor}</dd>
          {Object.entries(record.detail ?? {}).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="break-all font-mono">{String(value)}</dd>
            </div>
          ))}
          <dt className="text-muted-foreground">Session</dt>
          <dd className="break-all font-mono">{record.session.slice(0, 16)}</dd>
          <dt className="text-muted-foreground">Record hash</dt>
          <dd className="break-all font-mono">{record.hash}</dd>
        </dl>
      ) : null}
    </div>
  );
}
