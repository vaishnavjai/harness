import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  initializeDenBootstrapConfig,
  readDenBootstrapConfig,
  refreshDenBootstrapConfigFromShell,
  setDenBootstrapConfig,
} from "../src/app/lib/den";
import { outboundEgressAllowed } from "../src/app/lib/enterprise-activation";

/**
 * An activation-required install must not make any request outside loopback
 * before the person submits a workspace address. The renderer's boot-time
 * bootstrap resolution and the AppRoot-level analytics / Cloud-inventory
 * effects both mount above the activation gate, so each is gated on its own.
 */

const originalWindow = globalThis.window;

const publicDistribution = {
  flavor: "public" as const,
  appName: "Harness",
  appIdentifier: "com.vaishnavjai.harness",
  protocolScheme: "harness",
  requireSignin: false,
  requireActivation: false,
};

const enterpriseDistribution = {
  flavor: "enterprise" as const,
  appName: "Harness Enterprise",
  appIdentifier: "com.vaishnavjai.harness",
  protocolScheme: "harness",
  requireSignin: true,
  requireActivation: true,
};

const activation = { activatedAt: "2026-07-27T12:00:00.000Z", denBaseUrl: "https://den.example.test" };

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

type ShellBootstrap = {
  baseUrl: string;
  apiBaseUrl?: string | null;
  requireSignin: boolean;
  enterpriseActivation?: { activatedAt: string; denBaseUrl: string };
};

describe("pre-activation outbound egress", () => {
  let fetches: string[];
  let shellBootstrap: ShellBootstrap;

  function installWindow(distribution: typeof publicDistribution | typeof enterpriseDistribution) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        dispatchEvent: () => true,
        __HARNESS_ELECTRON__: {
          meta: { distribution },
          invokeDesktop: async (command: string, ...args: unknown[]) => {
            if (command === "getDesktopBootstrapConfig") return shellBootstrap;
            if (command === "setDesktopBootstrapConfig") {
              const payload = args[0];
              if (typeof payload !== "object" || payload === null) throw new Error("bootstrap payload required");
              shellBootstrap = { ...shellBootstrap, ...payload };
              return shellBootstrap;
            }
            if (command === "__fetch" && typeof args[0] === "string") {
              fetches.push(args[0]);
              return {
                status: 200,
                statusText: "OK",
                headers: [["content-type", "application/json"]],
                body: JSON.stringify({ denApiUrl: `${new URL(args[0]).origin}/api/den` }),
              };
            }
            throw new Error(`Unexpected desktop command: ${command}`);
          },
        },
      },
    });
  }

  beforeEach(() => {
    fetches = [];
    // What the shell hands a machine that has never run Harness: the build
    // default, which for the hosted deployment is a host nobody chose.
    shellBootstrap = { baseUrl: "https://app.harness.invalid", requireSignin: true };
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("an unactivated enterprise install does not probe the hosted runtime config at boot", async () => {
    installWindow(enterpriseDistribution);

    await initializeDenBootstrapConfig();
    await refreshDenBootstrapConfigFromShell();

    expect(fetches).toEqual([]);
    expect(readDenBootstrapConfig().baseUrl).toBe("https://app.harness.invalid");
  });

  test("an activated enterprise install resolves its Den's runtime config at boot", async () => {
    installWindow(enterpriseDistribution);
    shellBootstrap = { baseUrl: activation.denBaseUrl, requireSignin: true, enterpriseActivation: activation };

    await initializeDenBootstrapConfig();

    expect(fetches).toEqual(["https://den.example.test/api/runtime-config"]);
    expect(readDenBootstrapConfig().apiBaseUrl).toBe("https://den.example.test/api/den");
  });

  test("a submitted workspace address is resolved even before activation completes", async () => {
    installWindow(enterpriseDistribution);
    await initializeDenBootstrapConfig();
    expect(fetches).toEqual([]);

    await setDenBootstrapConfig({ baseUrl: "https://den.example.test", requireSignin: true });

    expect(fetches).toContain("https://den.example.test/api/runtime-config");
    expect(fetches.every((url) => new URL(url).hostname === "den.example.test")).toBe(true);
  });

  test("the public flavor never probes the build-default Den nobody chose", async () => {
    installWindow(publicDistribution);

    await initializeDenBootstrapConfig();
    await refreshDenBootstrapConfigFromShell();

    expect(fetches).toEqual([]);
  });

  test("the public flavor resolves the runtime config of a Den someone chose", async () => {
    installWindow(publicDistribution);
    shellBootstrap = { baseUrl: "https://den.example.test", requireSignin: false };

    await initializeDenBootstrapConfig();

    expect(fetches).toEqual(["https://den.example.test/api/runtime-config"]);
  });
});

describe("outboundEgressAllowed", () => {
  test("never holds back an install that does not require activation", () => {
    expect(outboundEgressAllowed(publicDistribution, {})).toBe(true);
    expect(outboundEgressAllowed(publicDistribution, {}, { desktopConfigLoading: true })).toBe(true);
  });

  test("holds an activation-required install back until activated, independently of desktop policy readiness", () => {
    expect(outboundEgressAllowed(enterpriseDistribution, {})).toBe(false);
    expect(outboundEgressAllowed(enterpriseDistribution, {}, { desktopConfigLoading: false })).toBe(false);
    expect(outboundEgressAllowed(enterpriseDistribution, { enterpriseActivation: activation }, { desktopConfigLoading: true })).toBe(true);
    expect(outboundEgressAllowed(enterpriseDistribution, { enterpriseActivation: activation }, { desktopConfigLoading: false })).toBe(true);
    expect(outboundEgressAllowed(enterpriseDistribution, { enterpriseActivation: activation })).toBe(true);
  });

  test("honours a bootstrap that opts another artifact into activation", () => {
    expect(outboundEgressAllowed(publicDistribution, { requireActivation: true })).toBe(false);
    expect(outboundEgressAllowed(publicDistribution, { requireActivation: true, enterpriseActivation: activation })).toBe(true);
  });
});

describe("AppRoot egress wiring", () => {
  const appRootSource = readFileSync(new URL("../src/react-app/shell/app-root.tsx", import.meta.url), "utf8");

  test("gates the Cloud inventory prefetch on outbound egress being allowed, and has no analytics", () => {
    expect(appRootSource).toContain("if (!egressAllowed) return;\n    prefetchCloudInventory();");
    expect(appRootSource).toContain("desktopConfigLoading: desktopConfig.loading,");
    expect(appRootSource).not.toMatch(/initAnalytics|captureAnalyticsEvent|posthog/i);
  });
});
