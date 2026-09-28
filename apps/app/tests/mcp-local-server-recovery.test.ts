import { afterEach, describe, expect, test } from "bun:test";

import { MCP_QUICK_CONNECT } from "../src/app/constants";
import { createHarnessServerClient } from "../src/app/lib/harness-server";
import { createHarnessServerStore } from "../src/react-app/domains/connections/harness-server-store";
import type { McpDirectoryInfo } from "../src/app/constants";
import { submitMcpEntry } from "../src/react-app/domains/connections/modals/add-mcp-submission";
import type { HarnessServerStore } from "../src/react-app/domains/connections/harness-server-store";
import { createConnectionsStore } from "../src/react-app/domains/connections/store";

const originalWindow = globalThis.window;

function installDesktopWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __HARNESS_ELECTRON__: {} },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("local MCP server recovery", () => {
  test("returns submission feedback when local server recovery never settles", async () => {
    installDesktopWindow();
    let recoveryAttempts = 0;
    const stalledRecovery = new Promise<never>(() => undefined);
    const harnessServer = {
      getSnapshot: () => ({
        harnessServerStatus: "disconnected",
        harnessServerClient: null,
        harnessServerCapabilities: null,
      }),
      ensureLocalHarnessServerClient: () => {
        recoveryAttempts += 1;
        return stalledRecovery;
      },
    } as unknown as HarnessServerStore;
    const store = createConnectionsStore({
      checkDesktopAppRestriction: () => false,
      client: () => null,
      setClient: () => undefined,
      projectDir: () => "/tmp/harness-mcp-recovery",
      selectedWorkspaceId: () => "workspace_local",
      selectedWorkspaceRoot: () => "/tmp/harness-mcp-recovery",
      workspaceType: () => "local",
      harnessServer,
      runtimeWorkspaceId: () => null,
      ensureRuntimeWorkspaceId: async () => "workspace_local",
      localHarnessServerRecoveryTimeoutMs: 10,
      developerMode: () => false,
    });
    const entry: McpDirectoryInfo = {
      name: "Stalled recovery",
      description: "",
      type: "remote",
      url: "https://example.com/mcp",
      oauth: true,
      managedOAuth: true,
    };

    const result = await Promise.race([
      submitMcpEntry(store.connectMcp, entry, "Fallback error"),
      new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), 250)),
    ]);

    expect(recoveryAttempts).toBe(1);
    expect(result).not.toBe("still pending");
    expect(result).not.toBeNull();
    expect(store.getSnapshot().mcpConnectingName).toBeNull();
  });
});

describe("bundled Computer Use setup", () => {
  async function connectWithHelper(command: string[] | null) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __HARNESS_ELECTRON__: { invokeDesktop: async (name: string) => name === "getComputerUseMcpCommand" ? command : null } },
    });
    const server = createHarnessServerStore({
      startupPreference: () => "server", documentVisible: () => true, developerMode: () => false,
      runtimeWorkspaceId: () => "setup-workspace", activeClient: () => null,
      selectedWorkspaceDisplay: () => ({ id: "setup-workspace", name: "Setup", path: "/tmp/setup", preset: "starter", workspaceType: "local" }),
      restartLocalServer: async () => false, createRemoteWorkspaceFlow: async () => false,
    });
    const saved: Array<Parameters<ReturnType<typeof createHarnessServerClient>["addMcp"]>[1]> = [];
    const client = {
      ...createHarnessServerClient({ baseUrl: "http://127.0.0.1:1" }),
      addMcp: async (_workspace: string, payload: Parameters<ReturnType<typeof createHarnessServerClient>["addMcp"]>[1]) => { saved.push(payload); return { items: [] }; },
      listMcp: async () => ({ items: [] }),
    };
    const getSnapshot: typeof server.getSnapshot = () => ({ ...server.getSnapshot(), harnessServerStatus: "connected", harnessServerClient: client });
    const store = createConnectionsStore({
      checkDesktopAppRestriction: () => false, client: () => null, setClient: () => {},
      projectDir: () => "/tmp/setup", selectedWorkspaceId: () => "setup-workspace", selectedWorkspaceRoot: () => "/tmp/setup",
      workspaceType: () => "local", harnessServer: { ...server, getSnapshot }, runtimeWorkspaceId: () => "setup-workspace", developerMode: () => false,
    });
    const entry = MCP_QUICK_CONNECT.find((entry) => entry.id === "computer-use");
    if (!entry) throw new Error("Computer Use catalog entry missing");
    expect(entry.command).toEqual([]);
    const result = await store.connectMcp(entry);
    return { result, saved };
  }

  test("resolves the desktop helper before validating the empty catalog command", async () => {
    const command = ["/Applications/Harness.app/Contents/Resources/helpers/Harness Computer Use.app/Contents/MacOS/ComputerUse", "mcp"];
    const { result, saved } = await connectWithHelper(command);
    expect(result).toEqual({ ok: true });
    expect(saved).toEqual([{ name: "computer-use", config: { type: "local", enabled: true, command } }]);
  });

  test("missing helper returns an actionable error without saving a connection", async () => {
    const { result, saved } = await connectWithHelper(null);
    expect(result).toEqual({ ok: false, error: "Computer Use requires the bundled Harness helper on macOS." });
    expect(saved).toEqual([]);
  });
});
