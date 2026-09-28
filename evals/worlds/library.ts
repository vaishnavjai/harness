import { browserScript, locate } from "@harness/cdp";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { app as startApp, resolveEvalEngine } from "@harness/env";
import type { MockHandle, Seed } from "@harness/env";
import { evalIn as rawEvalIn } from "@harness/behaviors";
import type {  } from "@harness/behaviors";
import { allocateFreePort } from "@harness/cdp";
import { startMockMcp, type MockAgentWorkload } from "@harness/labs";
import { electronProfilePaths } from "@harness/hosts";
import { configureProvider } from "./chat.ts";
import { browserScriptValue, runBrowserHost } from "../packages/env/src/browser-task.ts";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function itemOf(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || !isRecord(body.item)) {
    throw new Error(`Response had no item: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.item;
}

export function stringField(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

export function booleanField(value: unknown, key: string): boolean | null {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : null;
}

function withDispose<T extends object>(value: T, dispose: () => Promise<void>): T & AsyncDisposable {
  return Object.assign(value, { [Symbol.asyncDispose]: dispose });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function streamChunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: `chatcmpl-${model}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sendStream(response: ServerResponse, chunks: Record<string, unknown>[]): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  let delay = 200;
  for (const chunk of chunks) {
    setTimeout(() => response.write(`data: ${JSON.stringify(chunk)}\n\n`), delay);
    delay += 200;
  }
  setTimeout(() => response.end("data: [DONE]\n\n"), delay);
}

function projectedTool(payload: Record<string, unknown>, ending: string): string | null {
  for (const tool of records(payload.tools)) {
    if (!isRecord(tool.function)) continue;
    const name = tool.function.name;
    if (typeof name === "string" && name.endsWith(ending)) return name;
  }
  return null;
}

function completedToolCount(payload: Record<string, unknown>): number {
  return records(payload.messages).filter((message) => message.role === "tool").length;
}

export function mcpCallBody(id: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

export const connectStateExpression = () => {
  const port = localStorage.getItem("harness.server.port") ?? "";
  const baseUrl = port ? "http://127.0.0.1:" + port : "";
  const token = localStorage.getItem("harness.server.token") ?? "";
  if (!baseUrl || !token) return { ok: false, status: null, connectEnabled: null };
  const request = new XMLHttpRequest();
  request.open("GET", baseUrl + "/experimental/connect/state", false);
  request.setRequestHeader("Authorization", "Bearer " + token);
  request.send();
  const raw = JSON.parse(request.responseText || "{}");
  return { ok: request.status >= 200 && request.status < 300, status: raw?.status ?? null, connectEnabled: raw?.connectEnabled ?? null };
};

export const runtimeGenerationExpression = async () => {
  const invokeDesktop = window.__HARNESS_ELECTRON__?.invokeDesktop;
  if (!invokeDesktop) return { running: false, baseUrl: "", generation: null };
  const info = await invokeDesktop("harnessServerInfo");
  return {
    running: info?.running === true,
    baseUrl: String(info?.baseUrl ?? ""),
    generation: typeof info?.generation === "number" ? info.generation : null,
  };
};

export const cloudHealthExpression = (workspaceId: string) => {
    const port = localStorage.getItem("harness.server.port");
    const token = localStorage.getItem("harness.server.token");
    if (!port || !token) return { error: "missing local server credentials" };
    const request = new XMLHttpRequest();
    request.open("GET", "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/mcp/harness-cloud/health?probe=1", false);
    request.setRequestHeader("Authorization", "Bearer " + token);
    request.send();
    return JSON.parse(request.responseText || "{}");
  };

export async function clearConnectStateFiles(app: Awaited<ReturnType<typeof startApp>>): Promise<void> {
  if (!app.handle.profileDir) throw new Error("The local desktop profile directory is unavailable.");
  const paths = electronProfilePaths(app.handle.profileDir);
  const candidates = [
    `${paths.userDataDir}/harness-dev-data/xdg/config/harness/connect-state.json`,
    `${paths.configHome}/harness/connect-state.json`,
    `${paths.homeDir}/.config/harness/connect-state.json`,
  ];
  await Promise.all(candidates.map((path) => rm(path, { force: true })));
}

const paperFlowSupport = ["Alex R.", "Jordan L.", "Priya N.", "Chris M.", "Dana W."];

export async function libraryConfigReadBudget(seed: Seed) {
  const app = await seed.desktop({ name: "library-config-read-budget" });
  await seed.workspace(app, repoRoot);
  // TODO(primitive): seed.networkObserver
  await seed.evalIn(app, () => {
    window.__opencodeConfigReads = 0;
    window.__librarySkillReads = 0;
    window.__libraryLifecycleReads = 0;
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const target = args[0] instanceof Request ? args[0].url : String(args[0]);
      if (typeof target === "string" && target.includes("/opencode-config")) window.__opencodeConfigReads += 1;
      if (typeof target === "string" && target.includes("/skills/browser-automation")) window.__librarySkillReads += 1;
      if (typeof target === "string" && (target.includes("/cloud-provider-sync/status") || target.includes("/opencode/config?") || target.endsWith("/mcp") || target.endsWith("/den-session"))) window.__libraryLifecycleReads += 1;
      return originalFetch.apply(this, args);
    };
    const bridge = window.__HARNESS_ELECTRON__;
    if (bridge?.invokeDesktop) {
      const originalInvoke = bridge.invokeDesktop.bind(bridge);
      bridge.invokeDesktop = function (command, ...rest) {
        if (command === "readOpencodeConfig") window.__opencodeConfigReads += 1;
        return originalInvoke(command, ...rest);
      };
    }
    location.hash = "#/settings/general";
    return true;
  });
  return { app };
}

export async function libraryStateTabs(seed: Seed) {
  const app = await seed.desktop({ name: "library-state-tabs" });
  await seed.workspace(app, repoRoot);
  // TODO(primitive): seed.route
  await seed.evalIn(app, () => { location.hash = "#/settings/general"; return true; });
  return { app };
}

const slackClientSecret = "slack-eval-client-secret-32-bytes";
export const slackScopes = [
  "search:read.public", "search:read.private", "chat:write", "channels:history", "groups:history",
  "im:history", "mpim:history", "users:read", "channels:read",
];

export const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

export function buildSkillMarkdown(name: string, headline: string, targetBytes: number): string {
  const sentence = "Orchestre le développement complet d'apps mobiles — idée, étude de marché, validation, croissance, déploiement. 大小阈值测试。";
  let markdown = `---\nname: ${name}\ndescription: Skill volumineux multi-octets qui prouve la limite de search_text.\n---\n\n# ${headline}\n\n`;
  while (utf8Bytes(markdown) < targetBytes) markdown += sentence;
  return markdown.trimEnd();
}

export async function mockToolsListCount(mock: MockHandle): Promise<number> {
  const requests = await mock.requests();
  return requests.filter((request) => {
    const methods = Reflect.get(request, "rpcMethods");
    return Array.isArray(methods) && methods.includes("tools/list");
  }).length;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fixture did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function configureWorkspaceModel(seed: Seed, input: {
  app: import("@harness/cdp").Surface;
  workspaceId: string;
  providerId: string;
  modelId: string;
  fixtureUrl: string;
  denApiUrl?: string;
  mcpToken?: string;
  appHostToken?: string;
  directMcp?: { name: string; url: string };
}): Promise<void> {
  // TODO(primitive): seed.workspaceRuntimeConfig
  const result = await rawEvalIn(input.app, browserScript(async (inputWorkspaceId, providerId, value, modelId, inputValue, inputValue2, inputProviderId, inputModelId, inputValue3) => {
    const port = localStorage.getItem("harness.server.port");
    const token = localStorage.getItem("harness.server.token");
    if (!port || !token) return "missing local server credentials";
    const request = async (path: string, init?: RequestInit) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 500);
      return "ok";
    };
    const workspaceId = inputWorkspaceId;
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({ opencode: {
        provider: {
          [providerId]: {
            npm: "@ai-sdk/openai-compatible",
            name: "E2E MCP App model",
            options: { baseURL: value, apiKey: "sk-e2e-fixture" },
            models: { [modelId]: { name: "E2E MCP App model", tool_call: true } },
          },
        },
        mcp: inputValue,
      } }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok" && !reloaded.includes("opencode_reload_timeout") && !reloaded.includes("opencode_engine_unreachable")) return reloaded;
    if (inputValue2) {
      const reconcile = await request("/workspace/" + encodeURIComponent(workspaceId) + "/mcp/harness-cloud/reconcile", {
        method: "POST", body: JSON.stringify(inputValue2),
      });
      if (reconcile !== "ok") return reconcile;
    }
    const deadline = Date.now() + 90_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const health = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/global/health", {
          headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(5_000),
        });
        if (health.ok) {
          const readiness: unknown = await health.json();
          if (readiness && typeof readiness === "object" && "healthy" in readiness && readiness.healthy === true) {
            healthy = true;
            break;
          }
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!healthy) return "Engine did not report healthy";
    const raw = localStorage.getItem("harness.preferences");
    let preferences: Record<string, unknown> = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch {}
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("harness.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: inputProviderId, modelID: inputModelId },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("harness.defaultModel", inputValue3);
    localStorage.removeItem("harness.sessionModels." + workspaceId);
    return "ok";
  }, [input.workspaceId, input.providerId, `${input.fixtureUrl}/v1`, input.modelId, input.directMcp ? {
          [input.directMcp.name]: { type: "remote", url: input.directMcp.url, enabled: true, oauth: false },
        } : {}, input.denApiUrl && input.mcpToken ? {
      config: {
        type: "remote", url: `${input.denApiUrl}/mcp/agent`, enabled: true,
        headers: { Authorization: `Bearer ${input.mcpToken}` }, oauth: false,
      },
      appHostAuthorization: input.appHostToken ? `Bearer ${input.appHostToken}` : undefined,
      provider: input.providerId, model: input.modelId, trigger: "spec-primitives-migration",
    } : null, input.providerId, input.modelId, `${input.providerId}/${input.modelId}`]), { awaitPromise: true, timeoutMs: 120_000 });
  if (result !== "ok") throw new Error(`Configuring the fixture model failed: ${String(result)}`);
}

async function reloadConfiguredApp(app: import("@harness/cdp").Surface): Promise<void> {
  // TODO(primitive): seed.reloadConfiguredDesktop
  await rawEvalIn(app, () => { location.reload(); return true; }).catch(() => undefined);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await rawEvalIn(app, () => (Boolean(window.__harnessControl))).catch(() => false) === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The configured desktop control did not return after reload.");
}

export const connectionActionQuestion = {
  header: "Connection",
  question: "Connect Notion to continue?",
  options: [
    { label: "Authenticate", description: "Connect this account to continue." },
    { label: "Skip", description: "Continue without this connection." },
  ],
  multiple: false,
  custom: false,
};
export const connectionActionSkipPrompt = "Skip Notion setup if I choose.";
export const connectionStatusSkipPrompt = "Recheck Notion sign-in and skip if I choose.";
export const ordinaryDiscoveryPrompt = "Create a dashboard using my notes.";
export const ordinaryDiscoveryReply = "I found the available capabilities for the dashboard.";
export const connectionActionPrompt = "I want to connect Notion.";
export const connectionStatusPrompt = "Check my Notion connection so I can sign in.";

export const allConnectorsPrompt = "Show me all the quick-add connectors.";
export const allConnectorsReply = "Here are all the connectors available to add.";
export const connectorCatalogPrompt = "I want to set up Slack.";
export const connectorCatalogReply = "Slack setup options are available in your organization Connections dashboard.";

export const inlineResourceUri = "ui://harness/artifacts/arv_eval_card/views/avr_eval_card/index.html";
export const inlineReply = "The interactive artifact card is ready.";

export const remoteResourceUri = "ui://project-atlas/view.html";
export const remoteReply = "Project Atlas is open through its standard MCP server.";

export function rpcBody(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}
