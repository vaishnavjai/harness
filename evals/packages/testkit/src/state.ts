import { browserScript } from "@harness/cdp";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { evalIn } from "@harness/behaviors";
import { defaultDaytonaExec, electronProfilePaths, execInSandbox } from "@harness/hosts";
import type { Surface } from "@harness/cdp";

export interface ConnectState {
  ok: boolean;
  status: "available" | "missing" | "invalid" | "unreadable" | null;
  connectEnabled: boolean | null;
  raw: unknown;
}

export interface ConnectStateFile {
  status: "missing" | "available" | "invalid";
  connectEnabled: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

export async function readConnectState(app: Surface): Promise<ConnectState> {
  const value = await evalIn(app, async () => {
    // Resolve the local server the same way the app does: live runtime info
    // from the Electron bridge first (loopback port + token are ephemeral per
    // boot), then the web-mode localStorage overrides as a fallback.
    let baseUrl = "";
    let token = "";
    try {
      const invokeDesktop = window.__HARNESS_ELECTRON__ && window.__HARNESS_ELECTRON__.invokeDesktop;
      if (invokeDesktop) {
        const info = await invokeDesktop("harnessServerInfo");
        if (info && info.running === true) {
          baseUrl = String(info.baseUrl ?? info.connectUrl ?? "").trim().replace(/\/+$/, "");
          token = String(info.ownerToken ?? info.clientToken ?? "").trim();
        }
      }
    } catch {}
    if (!baseUrl || !token) {
      const port = (localStorage.getItem("harness.server.port") ?? "").trim();
      baseUrl = port ? "http://127.0.0.1:" + port : baseUrl;
      token = token || (localStorage.getItem("harness.server.token") ?? "").trim();
    }
    if (!baseUrl || !token) {
      return { ok: false, status: null, connectEnabled: null, raw: { error: "Local server credentials are unavailable." } };
    }
    try {
      const response = await fetch(
        baseUrl + "/experimental/connect/state",
        { headers: { Authorization: "Bearer " + token } },
      );
      const text = await response.text();
      let raw: unknown = text;
      try { raw = text ? JSON.parse(text) : null; } catch {}
      return {
        ok: response.ok,
        status: raw && typeof raw === "object" && "status" in raw
          && (raw.status === "available" || raw.status === "missing" || raw.status === "invalid" || raw.status === "unreadable")
          ? raw.status
          : null,
        connectEnabled: raw && typeof raw === "object" && "connectEnabled" in raw && typeof raw.connectEnabled === "boolean"
          ? raw.connectEnabled
          : null,
        raw,
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        connectEnabled: null,
        raw: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }, { awaitPromise: true, timeoutMs: 15_000 });
  if (!isRecord(value)) throw new Error("The desktop returned an invalid Connect state.");
  return {
    ok: value.ok === true,
    status: value.status === "available" || value.status === "missing" || value.status === "invalid" || value.status === "unreadable"
      ? value.status
      : null,
    connectEnabled: typeof value.connectEnabled === "boolean" ? value.connectEnabled : null,
    raw: value.raw,
  };
}

/** Reads the caller-visible profile filesystem. */
export async function readConnectStateFile(
  app: Surface,
  deps?: { exec?: (sandbox: string, script: string) => Promise<string> },
): Promise<ConnectStateFile> {
  if (app.handle.hostKind !== "local" && app.handle.hostKind !== "daytona") {
    throw new Error(`readConnectStateFile supports local and daytona app profiles; received ${app.handle.hostKind}.`);
  }
  if (!app.handle.profileDir) throw new Error(`The ${app.handle.hostKind} app did not expose its profile directory.`);
  // The local server persists runtime state next to its config file
  // (`harnessConfigDir()`). The dev-mode desktop redirects that XDG config
  // root under its Electron userData dir (`<userData>/harness-dev-data/xdg/config`),
  // so probe the known layouts in order.
  const paths = electronProfilePaths(app.handle.profileDir);
  const pathJoin = app.handle.hostKind === "daytona" ? posix.join : join;
  const candidates = [
    pathJoin(paths.userDataDir, "harness-dev-data", "xdg", "config", "harness", "connect-state.json"),
    pathJoin(paths.configHome, "harness", "connect-state.json"),
    pathJoin(paths.homeDir, ".config", "harness", "connect-state.json"),
  ];
  let text: string | null = null;
  if (app.handle.hostKind === "daytona") {
    if (!app.handle.sandboxId) throw new Error("The daytona app did not expose its sandbox ID.");
    const sandbox = app.handle.sandboxId;
    const exec = deps?.exec ?? (async (sandboxId: string, script: string): Promise<string> => {
      const result = await execInSandbox(defaultDaytonaExec, sandboxId, script, {
        timeoutMs: 30_000,
        context: `connect-state read for ${sandboxId}`,
      });
      return result.stdout;
    });
    for (const path of candidates) {
      if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) {
        throw new Error(`Unsafe connect-state path ${JSON.stringify(path)}: only absolute paths containing letters, digits and . _ / - are allowed.`);
      }
      const output = await exec(sandbox, `if [ -f "${path}" ]; then cat "${path}"; else echo __HARNESS_TESTKIT_MISSING__; fi`);
      if (output.trim() !== "__HARNESS_TESTKIT_MISSING__") {
        text = output;
        break;
      }
    }
  } else {
    for (const path of candidates) {
      try {
        text = await readFile(path, "utf8");
        break;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
  if (text === null) return { status: "missing", connectEnabled: null };
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || typeof value.connectEnabled !== "boolean") {
      return { status: "invalid", connectEnabled: null };
    }
    return { status: "available", connectEnabled: value.connectEnabled };
  } catch {
    return { status: "invalid", connectEnabled: null };
  }
}
