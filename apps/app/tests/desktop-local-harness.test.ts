import { describe, expect, test } from "bun:test";

import type { HarnessServerInfo } from "../src/app/lib/desktop";
import {
  isReadyLocalHarnessServerInfo,
  LOCAL_HARNESS_READINESS_RETRY_DELAY_MS,
  harnessServerSettingsChanged,
  shouldAttemptDesktopLocalReconnect,
  waitForReadyLocalHarnessServerInfo,
  type DesktopLocalReconnectInput,
} from "../src/react-app/shell/desktop-local-harness";

describe("harnessServerSettingsChanged", () => {
  test("does not refresh the renderer for an unchanged healthy server", () => {
    const settings = {
      urlOverride: "http://127.0.0.1:4187",
      portOverride: 4187,
      token: "owner",
      hostToken: "host",
      remoteAccessEnabled: false,
    };

    expect(harnessServerSettingsChanged(settings, { ...settings })).toBe(false);
    expect(harnessServerSettingsChanged(settings, { ...settings, token: "new-owner" })).toBe(true);
  });
});

function serverInfo(overrides: Partial<HarnessServerInfo> = {}): HarnessServerInfo {
  return {
    running: false,
    remoteAccessEnabled: false,
    host: null,
    port: null,
    baseUrl: null,
    connectUrl: null,
    mdnsUrl: null,
    lanUrl: null,
    clientToken: null,
    ownerToken: null,
    hostToken: null,
    managedOpencodeBinPath: null,
    managedOpencodeBinSource: null,
    pid: null,
    lastStdout: null,
    lastStderr: null,
    managedOpencodeExecution: null,
    ...overrides,
  };
}

const readyInfo = () =>
  serverInfo({ running: true, baseUrl: "http://127.0.0.1:4187", ownerToken: "tok_owner" });

describe("isReadyLocalHarnessServerInfo", () => {
  test("requires running, a base URL, and at least one token", () => {
    expect(isReadyLocalHarnessServerInfo(readyInfo())).toBe(true);
    expect(
      isReadyLocalHarnessServerInfo(
        serverInfo({ running: true, baseUrl: "http://127.0.0.1:4187", clientToken: "tok_client" }),
      ),
    ).toBe(true);
    expect(
      isReadyLocalHarnessServerInfo(
        serverInfo({ running: false, baseUrl: "http://127.0.0.1:4187", ownerToken: "tok_owner" }),
      ),
    ).toBe(false);
    expect(
      isReadyLocalHarnessServerInfo(serverInfo({ running: true, ownerToken: "tok_owner" })),
    ).toBe(false);
    expect(
      isReadyLocalHarnessServerInfo(serverInfo({ running: true, baseUrl: "http://127.0.0.1:4187" })),
    ).toBe(false);
    expect(isReadyLocalHarnessServerInfo(null)).toBe(false);
  });
});

describe("waitForReadyLocalHarnessServerInfo", () => {
  test("keeps polling through a restart gap until the server is ready", async () => {
    const responses: Array<HarnessServerInfo | null> = [
      serverInfo({ running: false }),
      serverInfo({ running: true, baseUrl: "http://127.0.0.1:4187" }),
      readyInfo(),
    ];
    let calls = 0;
    const waits: number[] = [];

    const result = await waitForReadyLocalHarnessServerInfo({
      fetchInfo: async () => responses[Math.min(calls++, responses.length - 1)] ?? null,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    expect(calls).toBe(3);
    expect(waits).toEqual([
      LOCAL_HARNESS_READINESS_RETRY_DELAY_MS,
      LOCAL_HARNESS_READINESS_RETRY_DELAY_MS,
    ]);
    expect(isReadyLocalHarnessServerInfo(result)).toBe(true);
  });

  test("tolerates bridge errors while polling", async () => {
    let calls = 0;
    const result = await waitForReadyLocalHarnessServerInfo({
      fetchInfo: async () => {
        calls += 1;
        if (calls < 3) throw new Error("bridge not ready");
        return readyInfo();
      },
      wait: async () => {},
    });

    expect(calls).toBe(3);
    expect(isReadyLocalHarnessServerInfo(result)).toBe(true);
  });

  test("is bounded: reports the last unready observation after max attempts", async () => {
    let calls = 0;
    const result = await waitForReadyLocalHarnessServerInfo({
      fetchInfo: async () => {
        calls += 1;
        return serverInfo({ running: false });
      },
      maxAttempts: 4,
      wait: async () => {},
    });

    expect(calls).toBe(4);
    expect(isReadyLocalHarnessServerInfo(result)).toBe(false);
    expect(result?.running).toBe(false);
  });
});

describe("shouldAttemptDesktopLocalReconnect", () => {
  const disconnectedLocal: DesktopLocalReconnectInput = {
    desktopRuntime: true,
    bootPhase: "ready",
    bootRouteReady: true,
    routeLoading: false,
    hasClient: false,
    connectionPending: false,
    workspaceType: "local",
  };

  test("never runs before desktop runtime bootstrap settles", () => {
    expect(
      shouldAttemptDesktopLocalReconnect({ ...disconnectedLocal, bootPhase: "bootstrapping-workspaces" }),
    ).toBe(false);
    expect(
      shouldAttemptDesktopLocalReconnect({ ...disconnectedLocal, bootPhase: "starting-engine" }),
    ).toBe(false);
    expect(
      shouldAttemptDesktopLocalReconnect({ ...disconnectedLocal, bootPhase: "activating-workspace" }),
    ).toBe(false);
    expect(
      shouldAttemptDesktopLocalReconnect({
        ...disconnectedLocal,
        bootPhase: "idle",
        bootRouteReady: false,
      }),
    ).toBe(false);
  });

  test("runs once boot completed, definitively failed, or is idle after route readiness", () => {
    expect(shouldAttemptDesktopLocalReconnect(disconnectedLocal)).toBe(true);
    expect(shouldAttemptDesktopLocalReconnect({ ...disconnectedLocal, bootPhase: "error" })).toBe(true);
    expect(
      shouldAttemptDesktopLocalReconnect({
        ...disconnectedLocal,
        bootPhase: "idle",
        bootRouteReady: true,
      }),
    ).toBe(true);
  });

  test("runs for a retained connection whose republished info is still pending", () => {
    expect(
      shouldAttemptDesktopLocalReconnect({
        ...disconnectedLocal,
        hasClient: true,
        connectionPending: true,
      }),
    ).toBe(true);
  });

  test("stays quiet for healthy, loading, non-desktop, and non-local cases", () => {
    expect(
      shouldAttemptDesktopLocalReconnect({ ...disconnectedLocal, hasClient: true }),
    ).toBe(false);
    expect(
      shouldAttemptDesktopLocalReconnect({ ...disconnectedLocal, routeLoading: true }),
    ).toBe(false);
    expect(
      shouldAttemptDesktopLocalReconnect({ ...disconnectedLocal, desktopRuntime: false }),
    ).toBe(false);
    expect(
      shouldAttemptDesktopLocalReconnect({ ...disconnectedLocal, workspaceType: "remote" }),
    ).toBe(false);
    expect(
      shouldAttemptDesktopLocalReconnect({ ...disconnectedLocal, workspaceType: null }),
    ).toBe(false);
  });
});
