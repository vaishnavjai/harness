import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { HarnessAuditRecord, HarnessMemoryStatus } from "@harness/types/desktop-ipc";

GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryView } = await import("../src/react-app/domains/settings/pages/memory-view");
const { AuditLogView, describeAuditRecord } = await import("../src/react-app/domains/settings/pages/audit-log-view");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function memoryStatus(overrides: Partial<HarnessMemoryStatus["engine"]> = {}, enabled = true): HarnessMemoryStatus {
  return {
    settings: {
      enabled,
      port: 8888,
      bankId: "harness",
      llm: { provider: "ollama", model: "llama3.1:8b" },
      embeddings: { model: "nomic-embed-text" },
    },
    engine: {
      state: "ready",
      pid: 4242,
      baseUrl: "http://127.0.0.1:8888",
      port: 8888,
      startedAt: "2026-09-28T12:00:00Z",
      lastError: null,
      restarts: 0,
      recentLogs: [],
      ...overrides,
    },
    runtimeAvailable: true,
    dataDir: "/home/alex/.config/harness/data/hindsight",
    apiKeys: { llm: false, embeddings: false },
    egressHosts: [],
    llmBaseUrl: "http://127.0.0.1:11434/v1",
    embeddingsBaseUrl: "http://127.0.0.1:11434/v1",
  };
}

const auditRecords: HarnessAuditRecord[] = [
  {
    v: 1,
    ts: "2026-09-28T12:01:00.000Z",
    seq: 2,
    session: "b".repeat(64),
    source: "engine",
    kind: "tool.execute",
    actor: "agent",
    subject: "bash",
    detail: { command: "pnpm test", toolKind: "command" },
    prev: "a".repeat(64),
    hash: "c".repeat(64),
  },
  {
    v: 1,
    ts: "2026-09-28T12:00:00.000Z",
    seq: 1,
    session: "b".repeat(64),
    source: "desktop",
    kind: "terminal.command",
    actor: "user",
    subject: "git status",
    detail: { terminal: "term_1" },
    prev: "0".repeat(64),
    hash: "a".repeat(64),
  },
];

let calls: Array<{ command: string; args: unknown[] }> = [];
let responses: Record<string, unknown> = {};

beforeEach(() => {
  calls = [];
  responses = {
    memoryStatus: memoryStatus(),
    memoryList: { items: [{ id: "m1", text: "Alex prefers pnpm over npm.", fact_type: "world" }], total: 1, limit: 25, offset: 0 },
    memoryRecall: [{ id: "m1", text: "Alex prefers pnpm over npm.", type: "world" }],
    auditLogRead: { path: "/home/alex/.config/harness/audit.log", records: auditRecords },
    auditLogVerify: { ok: true, records: 2, sessions: 1 },
  };
  Reflect.set(window, "__HARNESS_ELECTRON__", {
    invokeDesktop: async (command: string, ...args: unknown[]) => {
      calls.push({ command, args });
      return responses[command];
    },
  });
});

async function render(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 50 && !(container.textContent ?? "").includes(text); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("Settings > Memory", () => {
  test("shows the loopback engine, where data lives, and that nothing leaves the device", async () => {
    const view = await render(<MemoryView />);
    await waitForText(view.container, "Alex prefers pnpm over npm.");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Running on 127.0.0.1:8888");
    expect(text).toContain("/home/alex/.config/harness/data/hindsight");
    expect(text).toContain("Stays on this device");
    expect(text).toContain("Model endpoint");
    expect(text).toContain("Alex prefers pnpm over npm.");
    await view.unmount();
  });

  test("names the only remote host when a hosted provider is configured", async () => {
    responses.memoryStatus = { ...memoryStatus(), egressHosts: ["api.openai.com"], apiKeys: { llm: true, embeddings: false } };
    const view = await render(<MemoryView />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Sends memory text only to api.openai.com");
    expect(text).toContain("Saved in your OS keychain");
    await view.unmount();
  });

  test("explains how to install the engine when the runtime is missing", async () => {
    responses.memoryStatus = { ...memoryStatus({ state: "stopped", pid: null, port: null }, false), runtimeAvailable: false };
    const view = await render(<MemoryView />);
    expect(view.container.textContent).toContain("npm run package");
    expect(view.container.textContent).not.toContain("Memories");
    await view.unmount();
  });
});

describe("Settings > Audit log", () => {
  test("lists records in plain language and reports chain integrity", async () => {
    const view = await render(<AuditLogView />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Chain intact · 2 records");
    expect(text).toContain("Agent ran `pnpm test`");
    expect(text).toContain("Ran `git status` in a terminal");
    expect(text).toContain("/home/alex/.config/harness/audit.log");
    expect(calls.map((call) => call.command)).toEqual(expect.arrayContaining(["auditLogRead", "auditLogVerify"]));
    await view.unmount();
  });

  test("flags a broken chain", async () => {
    responses.auditLogVerify = { ok: false, records: 1, sessions: 1, firstBreak: { line: 2, reason: "chain broken: a record was removed, reordered or inserted" } };
    const view = await render(<AuditLogView />);
    expect(view.container.textContent).toContain("Tampering found at line 2");
    expect(view.container.textContent).toContain("chain broken");
    await view.unmount();
  });

  test("describes file writes by the agent", () => {
    expect(describeAuditRecord({ ...auditRecords[0]!, subject: "write", detail: { path: "/w/notes.md" } })).toBe("Agent used write on /w/notes.md");
  });
});
