import { addInitScript, browserScript, reattachSurface, reload, type Surface } from "@harness/cdp";
import { CATALOG_FAST_VARIANT, FAST_DEFAULT_VARIANT, fastVariantId } from "@harness/types/cloud-model-fast";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { evalIn, assertNoLiveSecret, liveOpenAiEnabled, liveOpenAiModel,  } from "@harness/behaviors";
import { resolveEvalEngine, SkipError, type Seed } from "@harness/env";
import type { MockAgentWorkload, MockMcpHandle } from "@harness/labs";
import { chatContinuity } from "./chat-continuity.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

type AppSurface = "electron" | "web";

declare global {
  interface Window {
    __modelEffortRequests?: unknown[];
    __harnessSubmissionFault?: { attempts: number; release: () => void };
    __harnessLongHistoryFault?: { dispose: () => void };
    __harnessWarmHistoryFault?: {
      state: {
        armed: boolean;
        released: boolean;
        expired: boolean;
        held: number;
        mutations: number;
        reads: {
          warm: boolean;
          limit: string | null;
          nativeCount: number;
          count: number;
          hasTail: boolean;
          delivered: boolean;
        }[];
      };
      arm: () => void;
      release: () => void;
      dispose: () => void;
    };
    __harnessStoppingFault?: {
      state: {
        attempts: number;
        held: number;
        nativeStatus: number | null;
        nativeFailed: boolean;
        released: boolean;
        failed: boolean;
        clickCaptured: boolean;
        trusted: boolean;
        elapsedMs: number | null;
        expired: boolean;
      };
      fail: () => void;
      dispose: () => void;
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function completionChunk(id: string, content: string, finishReason: string | null) {
  return {
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  };
}

function sendStream(response: ServerResponse, chunks: unknown[], intervalMs = 0): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let index = 0;
  const writeNext = () => {
    const chunk = chunks[index];
    if (chunk !== undefined) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      index += 1;
      setTimeout(writeNext, intervalMs);
      return;
    }
    response.end("data: [DONE]\n\n");
  };
  writeNext();
}

export async function configureProvider(
  seed: Seed,
  app: Surface,
  workspaceId: string,
  providerId: string,
  modelId: string,
  opencode: Record<string, unknown>,
  engine = resolveEvalEngine(),
): Promise<void> {
  // TODO(primitive): configure a workspace provider and select its model.
  const result = await seed.evalIn(app, browserScript(async (workspaceId, providerId, modelId, defaultModel, opencodeJson) => {
    const port = localStorage.getItem("harness.server.port");
    const token = localStorage.getItem("harness.server.token");
    if (!port || !token) return "missing local server credentials";
    const opencode = JSON.parse(opencodeJson);
    const request = async (path: string, init?: RequestInit) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      const text = await response.text();
      let reloadPending = response.status === 504;
      if (path.endsWith("/engine/reload") && response.status === 503) {
        try {
          const error: unknown = JSON.parse(text);
          reloadPending = typeof error === "object" && error !== null && "code" in error
            && error.code === "opencode_engine_unreachable";
        } catch {
          reloadPending = false;
        }
      }
      // Initial engine startup can race config reload. The readiness check
      // below must still observe the configured model in the live composer.
      if (!response.ok && !(path.endsWith("/engine/reload") && reloadPending)) {
        return path + " failed: " + response.status + " " + text.slice(0, 500);
      }
      return "ok";
    };
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({ opencode }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok") return reloaded;
    const raw = localStorage.getItem("harness.preferences");
    let preferences: Record<string, unknown> = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("harness.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: providerId, modelID: modelId },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("harness.defaultModel", defaultModel);
    localStorage.removeItem("harness.sessionModels." + workspaceId);
    return "ok";
  }, [workspaceId, providerId, modelId, `${providerId}/${modelId}`, JSON.stringify(opencode)]), { awaitPromise: true, timeoutMs: 120_000 });
  if (result !== "ok") throw new Error(`Provider configuration failed: ${String(result)}`);
  // Wait for navigation before starting the model-readiness evaluation;
  // scheduling location.reload() can run that evaluation in the old document.
  await reload(app);
  // The display name the app gives the configured model once its provider list
  // contains it; a fixture provider declares it in opencode.json, a live one is
  // read from the engine catalog.
  const configuredModel = recordValue(recordValue(recordValue(opencode, "provider"), providerId), "models");
  const configuredNameValue = recordValue(recordValue(configuredModel, modelId), "name");
  const configuredName = typeof configuredNameValue === "string" ? configuredNameValue : null;
  const ready = await seed.evalIn(app, browserScript(async (workspaceId, engine, providerId, modelId, configuredName) => {
    const deadline = Date.now() + 60000;
    const expectedRef = providerId + "/" + modelId;
    let observed = "";
    while (Date.now() < deadline) {
      const base = "http://127.0.0.1:" + localStorage.getItem("harness.server.port");
      const headers = { Authorization: "Bearer " + localStorage.getItem("harness.server.token") };
      try {
        const statusResponse = await fetch(base + "/experimental/engine-v2-preview/status", { headers });
        const status = statusResponse.ok ? await statusResponse.json() : null;
        const selected = status ? status.enabled && status.chatRouting : false;
        if ((engine === "v2") !== selected || (!statusResponse.ok && statusResponse.status !== 404)) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        const mounted = base + "/workspace/" + encodeURIComponent(workspaceId);
        const response = await fetch(mounted + (engine === "v2" ? "/opencode2/api/model" : "/opencode/session"), { headers });
        if (response.ok && window.__harnessControl) {
          let catalogName: string | null = null;
          if (engine === "v2") {
            const record = (value: unknown): value is Record<string, unknown> =>
              typeof value === "object" && value !== null && !Array.isArray(value);
            const catalog: unknown = await response.json();
            const items: unknown[] = Array.isArray(catalog) ? catalog : record(catalog) && Array.isArray(catalog.data) ? catalog.data : [];
            const entry = items.find((item) => record(item) && item.id === modelId && item.providerID === providerId);
            if (!record(entry)) throw new Error("catalog pending");
            catalogName = typeof entry.name === "string" ? entry.name : null;
          }
          // The engine lists the provider; now the app must too. Its composer
          // shows the model's display name only once the app's own provider
          // list contains the configured model, and the stored default must
          // have survived boot rather than being replaced by an organization
          // model while that list was still loading.
          const name = configuredName ?? catalogName ?? modelId;
          const chip = document.querySelector<HTMLElement>('button[aria-label="Change model"]');
          const chipText = chip?.innerText.trim() ?? "";
          const stored = localStorage.getItem("harness.defaultModel");
          observed = JSON.stringify({ composerModel: chipText, storedDefault: stored, expected: { name, ref: expectedRef } });
          if (stored === expectedRef && chipText.startsWith(name)) return true;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return observed || false;
  }, [workspaceId, engine, providerId, modelId, configuredName]), { awaitPromise: true, timeoutMs: 120_000 });
  if (ready !== true) {
    throw new Error(`Selected ${engine} engine did not become ready after provider configuration`
      + (typeof ready === "string" ? `; last observed ${ready}` : "."));
  }
}

async function seedControls(
  seed: Seed,
  app: Surface,
  calls: readonly { action: string; args?: unknown }[],
): Promise<void> {
  for (const call of calls) await arrangeControl(seed, app, call.action, call.args);
}

export async function arrangeControl(
  seed: Seed,
  app: Surface,
  action: string,
  args?: unknown,
): Promise<unknown> {
  // TODO(primitive): invoke a named renderer fixture control and await its result.
  return seed.evalIn(app, browserScript(async (action, argsJson) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const available = window.__harnessControl?.listActions().find((candidate) => candidate.id === action && !candidate.disabled);
      if (available) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await window.__harnessControl.execute(action, JSON.parse(argsJson));
    if (!result?.ok) throw new Error(String(result?.error ?? "control action failed"));
    return result.value;
  }, [action, JSON.stringify(args ?? null)]), { awaitPromise: true, timeoutMs: 120_000 });
}

async function seedSessionRetry(
  seed: Seed,
  app: Surface,
  options: { title?: string } = {},
): Promise<{ sessionId: string; title: string }> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await seed.session(app, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }
  throw new Error(`Session creation did not settle: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function emptyChat(seed: Seed) {
  const app = await seed.desktop({ name: "chat-empty" });
  const workspace = await seed.workspace(app, seed.tmpPath("chat-empty"));
  const session = await seedSessionRetry(seed, app);
  return { app, workspace, session };
}

export async function paletteSessionActions(seed: Seed) {
  const app = await seed.desktop({ name: "command-palette-pin-rename" });
  const workspace = await seed.workspace(app, seed.tmpPath("command-palette-pin-rename"));
  const session = await seedSessionRetry(seed, app, { title: "Palette pin rename probe" });
  return { app, workspace, session };
}

export async function shimmerChat(seed: Seed) {
  const base = await emptyChat(seed);
  await seedControls(seed, base.app, [{ action: "eval.chat_loading.seed" }]);
  return base;
}

export async function focusContinuity(seed: Seed) {
  const app = await seed.desktop({ name: "composer-focus-continuity" });
  const workspace = await seed.workspace(app, seed.tmpPath("composer-focus-continuity"));
  const session = await seedSessionRetry(seed, app);
  return { app, workspace, session };
}

/** Model picker contract through a real native engine and a synthetic provider. */
export async function modelPickerEffortWeb(seed: Seed) {
  const engine = resolveEvalEngine();
  const fastProviderId = "fast-witness";
  const fastModelId = "gpt-5.4";
  const providerId = "effort-witness";
  const modelId = "reasoning-model";
  const prompt = "Explain why the sky looks blue.";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: prompt, latestUserTurn: true, finalReply: "Air scatters blue light more strongly.", steps: [],
  }] });
  const workspacePath = seed.tmpPath("model-picker-effort");
  const app = await seed.appWeb({ name: "model-picker-effort", workspacePath, mocks: { agent: mock } });
  // Observe model references without consuming or changing the app's requests.
  await addInitScript(app.client, () => {
    window.__modelEffortRequests = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "POST" && /\/opencode2\/api\/session\/[^/]+\/model$/.test(new URL(url, location.href).pathname)) {
        const body: unknown = await new Request(input instanceof Request ? input.clone() : input, init).json();
        window.__modelEffortRequests?.push(body);
      }
      return originalFetch(input, init);
    };
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing effort provider witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, { provider: {
    [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Effort witness",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-effort-key" },
      models: {
        [modelId]: { name: "Reasoning witness", reasoning: true, variants: {
          low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" },
          CustomExact: { reasoningEffort: "low" },
          auto: { reasoningEffort: "low" },
          hidden: { disabled: true, reasoningEffort: "high" },
        } },
        standard: { name: "Standard witness", reasoning: false },
      },
    },
    [fastProviderId]: {
      npm: "@ai-sdk/openai", name: "Fast witness",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-fast-key" },
      models: { [fastModelId]: { name: "Fast witness", reasoning: true, variants: {
        high: { reasoningEffort: "high" },
        [CATALOG_FAST_VARIANT]: { disabled: true, harnessNativeFast: 1 },
      } } },
    },
  } }, engine);
  const session = await seedSessionRetry(seed, app, { title: "Model effort contract" });
  return { app, engine, workspace, session, prompt, providerId, modelId,
    fastProviderId, fastModelId, fastDefaultVariant: FAST_DEFAULT_VARIANT, fastHighVariant: fastVariantId("high"),
    modelRequests: () => seed.evalIn(app, () => window.__modelEffortRequests ?? []),
    runtimeFacts: async () => ({
      ...await seed.evalIn(app, () => ({ browser: navigator.userAgent, electronBridge: Boolean(window.__HARNESS_ELECTRON__) })),
      sourceSha: app.actualSourceSha,
    }),
    readNative: (path: string) => seed.evalIn(app, browserScript(async (path) => {
      const base = "http://127.0.0.1:" + localStorage.getItem("harness.server.port");
      const response = await fetch(base + path, {
        headers: { Authorization: "Bearer " + localStorage.getItem("harness.server.token") },
        signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    }, [path]), { awaitPromise: true, timeoutMs: 20_000 }),
    requests: async () => (await witness.agentRequests({ promptMarker: prompt })).filter((request) => request.kind === "final"),
  };
}

async function startManualApprovalServer(approvalTimeoutMs: number) {
  const script = `
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { startServer } = await import("./src/server.ts");
    const root = mkdtempSync(join(tmpdir(), "harness-attachment-spec-"));
    const server = await startServer({
      host: "127.0.0.1", port: 0, token: "owt_spec_token", hostToken: "owt_spec_host_token",
      approval: { mode: "manual", timeoutMs: ${approvalTimeoutMs} }, corsOrigins: ["*"],
      workspaces: [{ id: "ws_spec", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
      authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
      logFormat: "pretty", logRequests: false,
    });
    console.log("SPEC_SERVER_PORT:" + server.port);
    setInterval(() => {}, 60000);
  `;
  // Isolate runtime state: without this the spawned server reads the host's
  // ~/.config/harness/runtime.sqlite, and a persisted managed policy there
  // turns every write into an instant 403 policy_unavailable.
  const child = spawn("bun", ["--conditions=development", "-e", script], {
    cwd: join(repoRoot, "apps", "server"),
    env: { ...process.env, HARNESS_RUNTIME_DB: join(mkdtempSync(join(tmpdir(), "harness-attachment-spec-runtime-")), "runtime.sqlite") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("Standalone harness-server did not report a port within 30s.")), 30_000);
    let buffered = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const match = buffered.match(/SPEC_SERVER_PORT:(\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Standalone harness-server exited early (code ${code}): ${(stderr || buffered).slice(0, 500)}`));
    });
    child.on("error", reject);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    token: "owt_spec_token",
    dispose: () => { child.kill("SIGKILL"); },
  };
}

export const renderCycleFirstReply = "Historical response is complete.";
export const renderCycleMarker = "STREAM_RENDER_CYCLE";
export const renderCycleChunks = Array.from({ length: 48 }, (_, index) => `chunk-${index + 1} `);

export async function renderCycle(seed: Seed) {
  const providerId = "chat-render-cycle-mock";
  const modelId = "chat-render-cycle-model";
  const requests: string[] = [];
  let completionIndex = 0;
  const provider = createServer((request, response) => {
    const url = request.url ?? "";
    requests.push(`${request.method ?? "UNKNOWN"} ${url}`);
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }
    void readBody(request).then((body) => {
      const streaming = body.includes(renderCycleMarker);
      const contents = streaming ? renderCycleChunks : [renderCycleFirstReply];
      completionIndex += 1;
      const id = `chatcmpl-render-cycle-${completionIndex}`;
      const chunks = [
        { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        ...contents.map((content) => completionChunk(id, content, null)),
        completionChunk(id, "", "stop"),
      ];
      setTimeout(() => sendStream(response, chunks, streaming ? 35 : 0), streaming ? 0 : 1_000);
    });
  });
  const baseUrl = await listen(provider);
  try {
    const app = await seed.desktop({ name: "chat-render-cycle-stability", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, seed.tmpPath("chat-render-cycle"));
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Chat render-cycle mock",
          options: { baseURL: `${baseUrl}/v1`, apiKey: "sk-chat-render-cycle" },
          models: { [modelId]: { name: "Chat render-cycle model" } },
        },
      },
    });
    // TODO(primitive): enable the renderer profiler before desktop launch.
    await seed.evalIn(app, () => {
      localStorage.setItem("harness.debug.profiler", "1");
      localStorage.removeItem("harness.debug.profilerOverlay");
      location.reload();
      return true;
    });
    const controlsReady = await seed.evalIn(app, async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (window.__harnessControl?.listActions().some((action) => action.id === "session.create_task" && !action.disabled)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }, { awaitPromise: true, timeoutMs: 120_000 });
    if (controlsReady !== true) throw new Error("Session controls did not return after enabling the profiler.");
    const session = await seedSessionRetry(seed, app);
    await seed.composerText(app, `Reply with exactly: ${renderCycleFirstReply}`);
    // TODO(primitive): send an arranged historical turn and await its completion.
    const historical = await seed.evalIn(app, browserScript(async (expectedReply) => {
      const sent = await window.__harnessControl.execute("composer.send", null);
      if (!sent?.ok) throw new Error(String(sent?.error ?? "composer.send failed"));
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (document.body.innerText.includes(expectedReply)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }, [renderCycleFirstReply]), { awaitPromise: true, timeoutMs: 120_000 });
    if (historical !== true) throw new Error(`Historical turn did not complete. Requests: ${requests.join("; ")}`);
    return {
      app,
      workspace,
      session,
      async [Symbol.asyncDispose]() { await close(provider); },
    };
  } catch (error) {
    await close(provider);
    throw error;
  }
}

export const streamedMarkdownMarker = "STREAM_MARKDOWN_ANSWER";
export const streamedMarkdownReasoning = "Preparing the formatted response.";
/** A multi-block answer: heading, prose, list, table, fenced code, closing prose. */
export const streamedMarkdownAnswer = [
  "## Streamed answer heading",
  "",
  "Opening paragraph with **bold emphasis** and `inline-code.ts` in it.",
  "",
  "- alpha list item",
  "- beta list item",
  "",
  "| Column | Value |",
  "| --- | --- |",
  "| gamma row | 42 |",
  "",
  "```ts",
  "const streamed = \"delta\";",
  "```",
  "",
  "[Play video](clip.mp4)",
  "",
  "Closing paragraph epsilon.",
].join("\n");

const htmlToolName = "explode_html";
export const htmlClosingReply = "The session recovered after the failed upstream call.";
export const htmlSummary = "Upstream returned an HTML error page (502 Bad Gateway)";
const htmlError = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1>${"Z".repeat(1_024 * 1_024)}</body></html>`;

export async function clampHtml(seed: Seed) {
  const providerId = "clamp-html-errors-mock";
  const modelId = "clamp-html-errors-model";
  let toolsListed = 0;
  let toolCalls = 0;
  let closingRounds = 0;
  const mock = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
        return;
      }
      if (url.pathname === "/mcp") {
        if (request.method === "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const raw = await readBody(request);
        const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const replies: Record<string, unknown>[] = [];
        let delayMs = 0;
        for (const candidate of messages) {
          if (!isRecord(candidate)) continue;
          if (candidate.method === "tools/list") toolsListed += 1;
          if (candidate.method === "tools/call") {
            toolCalls += 1;
            delayMs = 4_000;
          }
          if (candidate.id === undefined) continue;
          const method = typeof candidate.method === "string" ? candidate.method : "";
          if (method === "initialize") replies.push({
            jsonrpc: "2.0", id: candidate.id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "html-error-mcp", version: "1.0.0" } },
          });
          else if (method === "tools/list") replies.push({
            jsonrpc: "2.0", id: candidate.id,
            result: { tools: [{ name: htmlToolName, title: "HTML upstream failure", description: "Returns a deterministic upstream HTML error page.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] },
          });
          else if (method === "tools/call") replies.push({ jsonrpc: "2.0", id: candidate.id, error: { code: -32_000, message: htmlError } });
          else replies.push({ jsonrpc: "2.0", id: candidate.id, result: {} });
        }
        if (replies.length === 0) {
          response.writeHead(202, { "access-control-allow-origin": "*" });
          response.end();
          return;
        }
        if (delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
        sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
        return;
      }
      if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        const raw = await readBody(request);
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) throw new Error("Mock provider received a non-object request.");
        const requestTools = parsed.tools;
        const id = "chatcmpl-clamp-html-errors";
        if (!Array.isArray(requestTools) || requestTools.length === 0) {
          sendStream(response, [{ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }, completionChunk(id, "Session title", null), completionChunk(id, "", "stop")], 400);
          return;
        }
        const messages = parsed.messages;
        if (Array.isArray(messages) && messages.some((message) => recordValue(message, "role") === "tool")) {
          closingRounds += 1;
          sendStream(response, [{ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }, completionChunk(id, htmlClosingReply, null), completionChunk(id, "", "stop")], 400);
          return;
        }
        let toolName: string | null = null;
        for (const tool of requestTools) {
          const fn = recordValue(tool, "function");
          const name = recordValue(fn, "name");
          if (typeof name === "string" && name.endsWith(htmlToolName)) toolName = name;
        }
        if (!toolName) {
          sendStream(response, [{ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }, completionChunk(id, "The deterministic MCP error tool was unavailable.", null), completionChunk(id, "", "stop")], 400);
          return;
        }
        sendStream(response, [
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_html_error", type: "function", function: { name: toolName, arguments: "{}" } }] }, finish_reason: null }] },
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ], 400);
        return;
      }
      sendJson(response, 404, { error: { message: "not found" } });
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  const baseUrl = await listen(mock);
  try {
    const app = await seed.desktop({ name: "clamp-html-errors", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, seed.tmpPath("clamp-html-errors"));
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible", name: "Clamp HTML errors mock",
          options: { baseURL: `${baseUrl}/v1`, apiKey: "sk-clamp-html-errors" },
          models: { [modelId]: { name: "Clamp HTML errors model", tool_call: true } },
        },
      },
      mcp: { "html-error": { type: "remote", url: `${baseUrl}/mcp`, enabled: true, oauth: false } },
    });
    const session = await seedSessionRetry(seed, app);
    return {
      app,
      workspace,
      session,
      counts: () => ({ toolsListed, toolCalls, closingRounds }),
      async [Symbol.asyncDispose]() { await close(mock); },
    };
  } catch (error) {
    await close(mock);
    throw error;
  }
}

type QueueRequest = { rawBody: string; lastUserText: string };

function lastUserText(rawBody: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return ""; }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return "";
  for (let index = parsed.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) return message.content.flatMap((part) => (
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
    )).join("");
  }
  return "";
}

async function writeProviderConfig(path: string, providerId: string, modelId: string, modelName: string, baseUrl: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: modelName,
        options: { baseURL: baseUrl, apiKey: "sk-harness-eval" },
        models: { [modelId]: { name: modelName } },
      },
    },
  }, null, 2)}\n`);
}

async function selectModelInWorld(seed: Seed, app: Awaited<ReturnType<Seed["desktop"]>>, modelName: string): Promise<void> {
  // TODO(primitive): select a model as arranged state.
  const selected = await seed.evalIn(app, browserScript(async (modelName) => {
    const deadline = Date.now() + 60000;
    if (!document.querySelector<HTMLInputElement>('input[placeholder="Search providers and models..."]')) {
      const result = await window.__harnessControl.execute("session.model_picker.open", null);
      if (!result?.ok) return false;
    }
    while (Date.now() < deadline) {
      const input = document.querySelector<HTMLInputElement>('input[placeholder="Search providers and models..."]');
      if (input instanceof HTMLInputElement && input.value !== modelName) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, modelName);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
      const item = [...(dialog?.querySelectorAll("button") ?? [])]
        .find((candidate) => !candidate.disabled && (candidate.textContent ?? "").includes(modelName));
      if (item instanceof HTMLElement) {
        item.click();
        while (Date.now() < deadline) {
          if (!document.querySelector<HTMLInputElement>('input[placeholder="Search providers and models..."]')) return true;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }, [modelName]), { awaitPromise: true, timeoutMs: 120_000 });
  if (selected !== true) throw new Error(`Model ${modelName} was not selectable.`);
}

export const awayFirstPrompt = "away-drain first task";
export const awayQueuedPrompt = "away-drain queued follow-up";
export const awayFirstReply = "away-drain first reply";
export const awayQueuedReply = "away-drain queued reply";

export async function queuedDrainAway(seed: Seed) {
  const providerId = "away-drain-mock";
  const modelId = "away-drain-model";
  const modelName = "Away drain model";
  const requests: QueueRequest[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  const provider = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }
    void readBody(request).then((rawBody) => {
      let parsed: unknown;
      try { parsed = JSON.parse(rawBody); } catch { parsed = null; }
      const isMain = isRecord(parsed) && Array.isArray(parsed.tools) && parsed.tools.length > 0;
      if (isMain) requests.push({ rawBody, lastUserText: lastUserText(rawBody) });
      const reply = !isMain ? "Away drain session title" : rawBody.includes(awayQueuedPrompt) ? awayQueuedReply : awayFirstReply;
      const id = `chatcmpl-away-drain-${requests.length}`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      const finish = () => {
        response.write(`data: ${JSON.stringify(completionChunk(id, reply, null))}\n\n`);
        response.write(`data: ${JSON.stringify(completionChunk(id, "", "stop"))}\n\n`);
        response.end("data: [DONE]\n\n");
      };
      if (isMain && !rawBody.includes(awayQueuedPrompt)) void firstGate.then(finish);
      else setTimeout(finish, 200);
    });
  });
  const baseUrl = await listen(provider);
  try {
    const workspacePathA = seed.tmpPath("away-drain-a");
    const workspacePathB = seed.tmpPath("away-drain-b");
    await Promise.all([
      writeProviderConfig(workspacePathA, providerId, modelId, modelName, `${baseUrl}/v1`),
      writeProviderConfig(workspacePathB, providerId, modelId, modelName, `${baseUrl}/v1`),
    ]);
    const app = await seed.desktop({ name: "queued-drain-while-away", model: `${providerId}/${modelId}` });
    const workspaceA = await seed.workspace(app, workspacePathA);
    const sessionA = await seedSessionRetry(seed, app, { title: "Chat A" });
    await selectModelInWorld(seed, app, modelName);
    return {
      app,
      workspaceA,
      workspacePathB,
      sessionA,
      requests,
      releaseFirst,
      async [Symbol.asyncDispose]() {
        releaseFirst();
        await close(provider);
      },
    };
  } catch (error) {
    releaseFirst();
    await close(provider);
    throw error;
  }
}

type SequentialRequestLabel = "first" | "one" | "two" | "unexpected";
type SequentialRequest = { label: SequentialRequestLabel; lastUserText: string };

export const sequentialFirstPrompt = "Start the long deterministic task for sequential queue proof.";
export const sequentialQueuedOne = "Queued follow-up ONE for sequential drain proof.";
export const sequentialQueuedTwo = "Queued follow-up TWO for sequential drain proof.";
export const sequentialReplies = [
  "Deterministic long-task reply.",
  "Deterministic drain-one reply.",
  "Deterministic drain-two reply.",
];

export async function queuedSequential(seed: Seed) {
  const providerId = "sequential-queue-mock";
  const modelId = "sequential-queue-model";
  const modelName = "Sequential queue model";
  const requests: SequentialRequest[] = [];
  let releaseFirst: () => void = () => undefined;
  let releaseOne: () => void = () => undefined;
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  const oneGate = new Promise<void>((resolveGate) => { releaseOne = resolveGate; });
  const classify = (rawBody: string): SequentialRequestLabel => {
    if (rawBody.includes(sequentialQueuedTwo)) return "two";
    if (rawBody.includes(sequentialQueuedOne)) return "one";
    if (rawBody.includes(sequentialFirstPrompt)) return "first";
    return "unexpected";
  };
  const provider = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }
    void readBody(request).then((rawBody) => {
      let parsed: unknown;
      try { parsed = JSON.parse(rawBody); } catch { parsed = null; }
      const isMain = isRecord(parsed) && Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const label = classify(rawBody);
      if (isMain) requests.push({ label, lastUserText: lastUserText(rawBody) });
      const reply = !isMain
        ? "Session title"
        : label === "first" ? sequentialReplies[0]
          : label === "one" ? sequentialReplies[1]
            : label === "two" ? sequentialReplies[2]
              : `Unexpected completion for: ${rawBody.slice(0, 200)}`;
      const id = `chatcmpl-sequential-queue-${requests.length}`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const write = (chunk: unknown): void => {
        if (!response.writableEnded) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };
      write({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      const finish = (): void => {
        write(completionChunk(id, reply, null));
        setTimeout(() => {
          write(completionChunk(id, "", "stop"));
          setTimeout(() => {
            if (!response.writableEnded) response.end("data: [DONE]\n\n");
          }, 300);
        }, 300);
      };
      if (isMain && label === "first") void firstGate.then(finish);
      else if (isMain && label === "one") void oneGate.then(finish);
      else setTimeout(finish, 400);
    });
  });
  const baseUrl = await listen(provider);
  try {
    const workspacePath = seed.tmpPath("sequential-queue");
    await writeProviderConfig(workspacePath, providerId, modelId, modelName, `${baseUrl}/v1`);
    const app = await seed.desktop({ name: "sequential-queue", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, workspacePath);
    const session = await seedSessionRetry(seed, app);
    await selectModelInWorld(seed, app, modelName);
    return {
      app,
      workspace,
      session,
      requests,
      releaseFirst,
      releaseOne,
      async [Symbol.asyncDispose]() {
        releaseFirst();
        releaseOne();
        await close(provider);
      },
    };
  } catch (error) {
    releaseFirst();
    releaseOne();
    await close(provider);
    throw error;
  }
}

async function configureCrossWorkspaces(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  workspaceIds: string[],
  baseUrl: string,
): Promise<void> {
  // TODO(primitive): configure one provider across several workspaces and select its model.
  const configured = await seed.evalIn(app, browserScript(async (workspaceIdsJson, providerBaseUrl) => {
    const port = localStorage.getItem("harness.server.port");
    const token = localStorage.getItem("harness.server.token");
    if (!port || !token) return "missing local server credentials";
    const workspaceIds = JSON.parse(workspaceIdsJson);
    const root = "http://127.0.0.1:" + port;
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    for (const workspaceId of workspaceIds) {
      const patch = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          opencode: {
            permission: { bash: "allow" },
            provider: {
              "composer-switch-mock": {
                npm: "@ai-sdk/openai-compatible",
                name: "Composer switch model",
                options: { baseURL: providerBaseUrl, apiKey: "sk-composer-switch" },
                models: { "composer-switch-model": { name: "Composer switch model", tool_call: true } },
              },
            },
          },
        }),
      });
      if (!patch.ok) return "config:" + patch.status + ":" + (await patch.text()).slice(0, 300);
      const reload = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST", headers });
      if (!reload.ok && reload.status !== 504) return "reload:" + reload.status + ":" + (await reload.text()).slice(0, 300);
    }
    const raw = localStorage.getItem("harness.preferences");
    let preferences: Record<string, unknown> = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("harness.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: "composer-switch-mock", modelID: "composer-switch-model" },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("harness.defaultModel", "composer-switch-mock/composer-switch-model");
    return "ok";
  }, [JSON.stringify(workspaceIds), `${baseUrl}/v1`]), { awaitPromise: true, timeoutMs: 180_000 });
  if (configured !== "ok") throw new Error(`Cross-workspace provider configuration failed: ${String(configured)}`);
  await seed.evalIn(app, () => { location.reload(); return true; });
}

export async function markdownArtifact(seed: Seed) {
  const app = await seed.desktop({ name: "markdown-editor-autosave" });
  const workspace = await seed.workspace(app, seed.tmpPath("markdown-editor-autosave"));
  const session = await seedSessionRetry(seed, app);
  try {
    await arrangeControl(seed, app, "browser.open_url", { url: "about:blank" });
  } catch {
    // The browser can report ERR_ABORTED after it has already mounted the artifact side panel.
  }
  await arrangeControl(seed, app, "eval.artifact_tabs.seed_overflow", { count: 12 });
  return { app, workspace, session };
}

export async function mermaidChat(seed: Seed) {
  const app = await seed.desktop({ name: "mermaid-rendering" });
  const workspace = await seed.workspace(app, seed.tmpPath("mermaid-rendering"));
  const session = await seedSessionRetry(seed, app, { title: "Mermaid rendering proof" });
  await arrangeControl(seed, app, "eval.mermaid.set_theme", { mode: "light" });
  await arrangeControl(seed, app, "eval.markdown_primitive.seed_chat");
  return { app, workspace, session };
}

export const safeFirstPrompt = "First turn for safe edit proof.";
export const safeSecondPrompt = "Second turn that should be replaced.";
export const safeEditedPrompt = "Edited second turn that replaces the original.";
export const safeLegacyPrompt = "Legacy session restore proof.";
export const safeReplies = [
  "Deterministic first reply.",
  "Deterministic second reply.",
  "Deterministic edited reply.",
  "Deterministic legacy reply.",
];

export async function safeEdit(seed: Seed) {
  const providerId = "safe-edit-resend-mock";
  const modelId = "safe-edit-resend-model";
  let mainCompletionCount = 0;
  const provider = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }
    void readBody(request).then((rawBody) => {
      let parsed: unknown;
      try { parsed = JSON.parse(rawBody); } catch { parsed = null; }
      const isMain = isRecord(parsed) && Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const reply = !isMain
        ? "Session title"
        : rawBody.includes(safeEditedPrompt) ? safeReplies[2]
          : rawBody.includes(safeSecondPrompt) ? safeReplies[1]
            : rawBody.includes(safeLegacyPrompt) ? safeReplies[3]
              : rawBody.includes(safeFirstPrompt) ? safeReplies[0]
                : `Unexpected completion for: ${rawBody.slice(0, 200)}`;
      if (isMain) mainCompletionCount += 1;
      const id = `chatcmpl-safe-edit-${mainCompletionCount}`;
      const chunks = [
        { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        completionChunk(id, reply, null),
        completionChunk(id, "", "stop"),
      ];
      sendStream(response, chunks, 400);
    });
  });
  const baseUrl = await listen(provider);
  try {
    const app = await seed.desktop({ name: "safe-edit-resend", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, seed.tmpPath("safe-edit-resend"));
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Safe edit resend mock",
          options: { baseURL: `${baseUrl}/v1`, apiKey: "sk-safe-edit-resend" },
          models: { [modelId]: { name: "Safe edit resend model" } },
        },
      },
    });
    const session = await seedSessionRetry(seed, app);
    return {
      app,
      workspace,
      session,
      mainCompletionCount: () => mainCompletionCount,
      async [Symbol.asyncDispose]() { await close(provider); },
    };
  } catch (error) {
    await close(provider);
    throw error;
  }
}

export async function sessionErrorCard(seed: Seed) {
  const app = await seed.desktop({ name: "session-error-technical-details" });
  const workspace = await seed.workspace(app, seed.tmpPath("session-error-details"));
  const session = await seedSessionRetry(seed, app, { title: "Session error proof" });
  await arrangeControl(seed, app, "eval.session_error.seed");
  return {
    app, workspace, session,
    seedStorageError: (kind: "disk-full" | "database-error", surface: "transcript" | "banner" = "transcript") => arrangeControl(seed, app, "eval.session_error.seed", { kind, surface }),
  };
}

export async function snapshotFailure(seed: Seed) {
  const app = await seed.desktop({ name: "composer-snapshot-failure" });
  const workspace = await seed.workspace(app, seed.tmpPath("composer-snapshot-failure"));
  const session = await seedSessionRetry(seed, app, { title: "Composer snapshot failure proof" });
  await arrangeControl(seed, app, "eval.chat_transcript.seed");
  const failureJson = await seed.evalIn(app, browserScript(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const available = window.__harnessControl?.listActions()
        .find((candidate) => candidate.id === "eval.session_snapshot.fail" && !candidate.disabled);
      if (available) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await window.__harnessControl.execute("eval.session_snapshot.fail", null);
    if (!result?.ok) throw new Error(String(result?.error ?? "control action failed"));
    return JSON.stringify(result.result);
  }, []), { awaitPromise: true, timeoutMs: 120_000 });
  const failure: unknown = typeof failureJson === "string" ? JSON.parse(failureJson) : failureJson;
  if (!isRecord(failure) || failure.isError !== true) {
    throw new Error(`Session snapshot failure was not established: ${JSON.stringify(failure)}`);
  }
  return { app, workspace, session };
}

/** More stored messages than OpenCode's `limit`-paged transcript read used to fetch. */
export const longHistoryCount = 150;
export const longHistoryTitle = "Long conversation";
export const longHistoryOtherTitle = "Unrelated short task";
export const longHistoryFirst = "LONG-HISTORY-FIRST-MESSAGE 7c31";
export const longHistoryLast = "LONG-HISTORY-LAST-MESSAGE 7c31";

/** A long stored conversation opened cold, from another selected session. */
export async function longHistory(seed: Seed, options: { holdAncillaryReads?: boolean } = {}) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("native v1 stored history (HARNESS_EVAL_ENGINE=v1)");
  const app = await seed.desktop({ name: "session-full-history" });
  const workspace = await seed.workspace(app, seed.tmpPath("session-full-history"));
  const createStoredSession = (title: string) => seed.evalIn(app, browserScript(async (workspaceId, title) => {
    const port = localStorage.getItem("harness.server.port");
    const token = localStorage.getItem("harness.server.token");
    if (!port || !token) throw new Error("Long history arrangement requires the owned local server");
    const response = await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}/opencode/session`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Long history session creation failed: ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string"
      || !("title" in body) || body.title !== title) throw new Error("Native session did not preserve its seeded title");
    return { sessionId: body.id, title };
  }, [workspace.workspaceId, title]), { timeoutMs: 20_000 });
  const session = options.holdAncillaryReads
    ? await createStoredSession(longHistoryTitle)
    : await seedSessionRetry(seed, app, { title: longHistoryTitle });
  // TODO(primitive): store many engine messages without a model turn.
  const seeded = await seed.evalIn(app, browserScript(async (workspaceId, sessionId, count, first, last) => {
    const port = localStorage.getItem("harness.server.port");
    const token = localStorage.getItem("harness.server.token");
    if (!port || !token) return "missing local server credentials";
    const base = "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId)
      + "/opencode/session/" + encodeURIComponent(sessionId) + "/message";
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    for (let index = 0; index < count; index += 1) {
      const text = index === 0 ? first : index === count - 1 ? last : "Stored history message " + (index + 1) + " of " + count + ".";
      const response = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ noReply: true, parts: [{ type: "text", text }] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return "seed:" + index + ":" + response.status + ":" + (await response.text()).slice(0, 200);
    }
    const stored = await fetch(base, { headers, signal: AbortSignal.timeout(15000) });
    if (!stored.ok) return "stored:" + stored.status;
    const storedMessages = await stored.json();
    return Array.isArray(storedMessages) ? storedMessages.length : "stored:not-an-array";
  }, [workspace.workspaceId, session.sessionId, longHistoryCount, longHistoryFirst, longHistoryLast]), { awaitPromise: true, timeoutMs: 180_000 });
  if (seeded !== longHistoryCount) throw new Error(`Long history was not stored: ${String(seeded)}`);
  const other = options.holdAncillaryReads
    ? await createStoredSession(longHistoryOtherTitle)
    : await seedSessionRetry(seed, app, { title: longHistoryOtherTitle });
  if (options.holdAncillaryReads) {
    await seed.evalIn(app, browserScript((workspaceId, sessionId) => {
      location.hash = `/workspace/${encodeURIComponent(workspaceId)}/session/${encodeURIComponent(sessionId)}`;
    }, [workspace.workspaceId, other.sessionId]));
  }
  const ancillaryFaultKey = `harness.eval.long-history-ancillary.${session.sessionId}`;
  const ancillaryFault = options.holdAncillaryReads
    ? await addInitScript(app.client, browserScript((workspaceId, sessionId, storageKey, count, last) => {
      if (window.top !== window) return;
      const port = localStorage.getItem("harness.server.port");
      if (!port || !/^\d+$/.test(port)) throw new Error("Long history fault requires the owned local server port");
      const serverOrigin = `http://127.0.0.1:${port}`;
      const paths = ["workspace", "w"].map((mount) => `/${mount}/${encodeURIComponent(workspaceId)}/opencode/session`);
      const statusPaths = new Set(paths.map((path) => `${path}/status`));
      const todoPaths = new Set(paths.map((path) => `${path}/${encodeURIComponent(sessionId)}/todo`));
      const messagePaths = new Set(paths.map((path) => `${path}/${encodeURIComponent(sessionId)}/message`));
      const originalFetch = window.fetch;
      type Read = {
        id: number;
        kind: "status" | "todo";
        openedAt: number | null;
        startedAt: number;
        settledAt: number | null;
        outcome: "pending" | "aborted" | "failed";
        abortName: string | null;
        sameTurnAbort: boolean;
      };
      type Paint = {
        at: number;
        elapsedMs: number;
        messageCount: number;
        latestVisible: boolean;
        historyComplete: boolean;
        reads: Read[];
        released: boolean;
        expired: boolean;
      };
      const reads: Read[] = [];
      const opening: { openedAt: number | null; trusted: boolean; first: Paint | null; latest: Paint | null; full: Paint | null } = {
        openedAt: null, trusted: false, first: null, latest: null, full: null,
      };
      const pageReads: { before: string | null; limit: string | null; nextCursor: string | null }[] = [];
      const state = {
        workspaceId, sessionId, documentId: performance.timeOrigin, opening, reads,
        status: { attempts: 0, pending: 0, aborted: 0, failed: 0 },
        todo: { attempts: 0, pending: 0, aborted: 0, failed: 0 },
        history: { limited: 0, full: 0, fullSucceeded: 0, single: 0, pageReads },
        released: false,
        expired: false,
      };
      const publish = () => localStorage.setItem(storageKey, JSON.stringify(state));
      let frame = 0;
      const sample = () => {
        if (opening.openedAt === null || state.released) return;
        const root = document.querySelector<HTMLElement>(`[data-session-surface-id="${sessionId}"]`);
        const viewport = root?.querySelector<HTMLElement>("[data-thread-scroll]")?.getBoundingClientRect();
        if (root && viewport && document.visibilityState === "visible") {
          const messages = [...root.querySelectorAll<HTMLElement>("[data-message-id]")];
          const visible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
              && rect.bottom > Math.max(0, viewport.top) && rect.top < Math.min(innerHeight, viewport.bottom)
              && rect.right > Math.max(0, viewport.left) && rect.left < Math.min(innerWidth, viewport.right);
          };
          const latest = messages.find((message) => message.textContent?.includes(last));
          const at = performance.now();
          const paint: Paint = {
            at, elapsedMs: at - opening.openedAt, messageCount: messages.length,
            latestVisible: Boolean(latest && visible(latest)),
            historyComplete: Boolean(root.querySelector('[data-thread-history-complete="true"]')),
            reads: reads.map((read) => ({ ...read })), released: state.released, expired: state.expired,
          };
          let changed = false;
          if (!opening.first && messages.some(visible)) { opening.first = paint; changed = true; }
          if (!opening.latest && paint.latestVisible) { opening.latest = paint; changed = true; }
          if (!opening.full && paint.messageCount === count && paint.historyComplete && messages.some(visible)) {
            opening.full = paint;
            changed = true;
          }
          if (changed) publish();
        }
        if (!opening.first || !opening.latest || !opening.full) frame = requestAnimationFrame(sample);
      };
      const captureOpen = (event: MouseEvent) => {
        if (opening.openedAt !== null || !event.isTrusted) return;
        const button = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement
          && node.getAttribute("data-testid") === `sidebar-session-${sessionId}`);
        if (!button || button.closest("[data-sidebar-session-workspace-id]")?.getAttribute("data-sidebar-session-workspace-id") !== workspaceId) return;
        opening.openedAt = performance.now();
        opening.trusted = true;
        publish();
        frame = requestAnimationFrame(sample);
      };
      window.addEventListener("click", captureOpen, true);
      const pending = new Set<() => void>();
      const wrappedFetch: typeof window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (method !== "GET" || url.origin !== serverOrigin) return originalFetch.call(window, input, init);
        const kind = statusPaths.has(url.pathname) ? "status" : todoPaths.has(url.pathname) ? "todo" : null;
        if (!kind) {
          const historyRead = messagePaths.has(url.pathname);
          const full = historyRead && !url.searchParams.has("limit");
          const pageRead: (typeof pageReads)[number] | null = historyRead
            ? { before: url.searchParams.get("before"), limit: url.searchParams.get("limit"), nextCursor: null } : null;
          if (pageRead) {
            pageReads.push(pageRead);
            if (full) state.history.full += 1;
            else state.history.limited += 1;
            publish();
          } else if ([...messagePaths].some((path) => url.pathname.startsWith(`${path}/`) && !url.pathname.slice(path.length + 1).includes("/"))) {
            state.history.single += 1;
            publish();
          }
          const response = await originalFetch.call(window, input, init);
          if (pageRead) {
            pageRead.nextCursor = response.headers.get("X-Next-Cursor");
            if (full && response.ok) state.history.fullSucceeded += 1;
            publish();
          }
          return response;
        }
        const counter = state[kind];
        const read: Read = {
          id: reads.length + 1, kind, openedAt: opening.openedAt, startedAt: performance.now(),
          settledAt: null, outcome: "pending", abortName: null, sameTurnAbort: false,
        };
        reads.push(read);
        counter.attempts += 1;
        const unavailable = () => new Response(JSON.stringify({ message: "Long history ancillary read unavailable" }), {
          status: 503, headers: { "content-type": "application/json" },
        });
        if (state.released) {
          read.outcome = "failed";
          read.settledAt = performance.now();
          counter.failed += 1;
          publish();
          return unavailable();
        }
        counter.pending += 1;
        publish();
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          let sameTurn = true;
          queueMicrotask(() => { sameTurn = false; });
          const settle = (aborted: boolean) => {
            if (read.settledAt !== null) return;
            read.settledAt = performance.now();
            read.outcome = aborted ? "aborted" : "failed";
            read.abortName = aborted && signal?.reason instanceof Error ? signal.reason.name : null;
            read.sameTurnAbort = aborted && sameTurn && read.abortName === "AbortError"
              && read.settledAt - read.startedAt < 50 && opening.first === null;
            signal?.removeEventListener("abort", onAbort);
            pending.delete(fail);
            counter.pending -= 1;
            if (aborted) counter.aborted += 1;
            else counter.failed += 1;
            publish();
            if (aborted) reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
            else resolve(unavailable());
          };
          const onAbort = () => settle(true);
          const fail = () => settle(false);
          pending.add(fail);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      };
      const release = () => {
        state.released = true;
        cancelAnimationFrame(frame);
        for (const fail of pending) fail();
        publish();
      };
      const expiry = window.setTimeout(() => { state.expired = true; release(); }, 180_000);
      const dispose = () => {
        window.clearTimeout(expiry);
        release();
        if (window.fetch === wrappedFetch) window.fetch = originalFetch;
        window.removeEventListener("pagehide", dispose);
        window.removeEventListener("click", captureOpen, true);
      };
      window.__harnessLongHistoryFault = { dispose };
      window.addEventListener("pagehide", dispose, { once: true });
      window.fetch = wrappedFetch;
      publish();
    }, [workspace.workspaceId, session.sessionId, ancillaryFaultKey, longHistoryCount, longHistoryLast]))
    : null;
  return {
    app, workspace, session, other, ancillaryFaultKey,
    async [Symbol.asyncDispose]() {
      if (!ancillaryFault) return;
      try { await evalIn(app, () => window.__harnessLongHistoryFault?.dispose(), { timeoutMs: 5_000, reattachAttempts: 0 }); }
      finally { await ancillaryFault.dispose(); }
    },
  };
}

export async function warmCachedLongHistory(seed: Seed) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("native v1 stored history (HARNESS_EVAL_ENGINE=v1)");
  const base = await longHistory(seed, { holdAncillaryReads: false });
  return {
    ...base,
    startHistoryFault: () => warmHistoryFault(seed, base.app, base.workspace.workspaceId, base.session.sessionId),
  };
}

async function warmHistoryFault(seed: Seed, app: Surface, workspaceId: string, sessionId: string) {
  await seed.evalIn(app, browserScript((workspaceId, sessionId, tail) => {
    if (window.__harnessWarmHistoryFault) throw new Error("A warm history fault is already active");
    const port = localStorage.getItem("harness.server.port");
    if (!port) throw new Error("Warm history fault requires the local server port");
    const origin = `http://127.0.0.1:${port}`;
    const paths = ["workspace", "w"].map((mount) =>
      `/${mount}/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}`);
    const originalFetch = window.fetch;
    const state: NonNullable<Window["__harnessWarmHistoryFault"]>["state"] = {
      armed: false, released: false, expired: false, held: 0, mutations: 0, reads: [],
    };
    const pending = new Set<() => void>();
    let expiry: ReturnType<typeof setTimeout>;
    const release = () => {
      state.released = true;
      clearTimeout(expiry);
      for (const resume of pending) resume();
    };
    const dispose = () => {
      release();
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    };
    const expire = () => { state.expired = true; dispose(); };
    const hasTail = (message: unknown) => {
      if (!message || typeof message !== "object" || !("parts" in message) || !Array.isArray(message.parts)) return false;
      return message.parts.some((part: unknown) => part && typeof part === "object"
        && "type" in part && part.type === "text" && "text" in part && part.text === tail);
    };
    const wrappedFetch: typeof window.fetch = async (...args) => {
      const [input, init] = args;
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const owned = url.origin === origin && paths.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`));
      if (owned && method !== "GET") state.mutations += 1;
      if (state.released || !owned || method !== "GET" || !paths.some((path) => url.pathname === `${path}/message`)) {
        return originalFetch.apply(window, args);
      }
      const warm = state.armed;
      const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
      const response = await originalFetch.apply(window, args);
      if (!response.ok) throw new Error(`Warm history read failed: HTTP ${response.status}`);
      const messages: unknown = await response.clone().json();
      signal?.throwIfAborted();
      if (!Array.isArray(messages)) throw new Error("Warm history read did not return native messages");
      const returned = warm ? messages : messages.filter((message: unknown) => !hasTail(message));
      const read = {
        warm, limit: url.searchParams.get("limit"), nativeCount: messages.length,
        count: returned.length, hasTail: returned.some(hasTail), delivered: false,
      };
      state.reads.push(read);
      if (warm && read.limit === null && !state.released) {
        state.held += 1;
        try {
          await new Promise<void>((resolveHold, rejectHold) => {
            const cleanup = () => { pending.delete(resume); signal?.removeEventListener("abort", abort); };
            const resume = () => { cleanup(); resolveHold(); };
            const abort = () => { cleanup(); rejectHold(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
            pending.add(resume);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        } finally {
          state.held -= 1;
        }
      }
      signal?.throwIfAborted();
      read.delivered = true;
      if (warm) return response;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(JSON.stringify(returned), { status: response.status, statusText: response.statusText, headers });
    };
    window.fetch = wrappedFetch;
    expiry = setTimeout(expire, 120_000);
    window.__harnessWarmHistoryFault = {
      state,
      arm: () => {
        if (state.armed || state.released) throw new Error("Warm history fault cannot be armed again");
        state.armed = true;
        clearTimeout(expiry);
        expiry = setTimeout(expire, 120_000);
      },
      release,
      dispose,
    };
  }, [workspaceId, sessionId, longHistoryLast]));

  return {
    read: () => seed.evalIn(app, () => {
      const fault = window.__harnessWarmHistoryFault;
      if (!fault) throw new Error("Warm history fault lost its document");
      const composer: unknown = window.__harness?.slice("composer");
      const snapshot = composer && typeof composer === "object" && "snapshotQuery" in composer ? composer.snapshotQuery : null;
      return {
        ...fault.state,
        snapshot: snapshot && typeof snapshot === "object" ? {
          sessionId: "dataSessionId" in snapshot && typeof snapshot.dataSessionId === "string" ? snapshot.dataSessionId : null,
          count: "dataMessageCount" in snapshot && typeof snapshot.dataMessageCount === "number" ? snapshot.dataMessageCount : null,
          status: "status" in snapshot && typeof snapshot.status === "string" ? snapshot.status : null,
          fetchStatus: "fetchStatus" in snapshot && typeof snapshot.fetchStatus === "string" ? snapshot.fetchStatus : null,
        } : null,
      };
    }),
    arm: () => seed.evalIn(app, () => {
      const fault = window.__harnessWarmHistoryFault;
      if (!fault) throw new Error("Warm history fault lost its document");
      fault.arm();
    }),
    release: () => seed.evalIn(app, () => {
      const fault = window.__harnessWarmHistoryFault;
      if (!fault || fault.state.held < 1 || fault.state.expired) throw new Error("No uncapped history response is held");
      fault.release();
    }),
    async [Symbol.asyncDispose]() {
      await seed.evalIn(app, () => {
        window.__harnessWarmHistoryFault?.dispose();
        delete window.__harnessWarmHistoryFault;
      });
    },
  };
}

export async function taskActivity(seed: Seed) {
  const app = await seed.desktop({ name: "task-activity-shimmer" });
  const workspace = await seed.workspace(app, seed.tmpPath("task-activity-shimmer"));
  const session = await seedSessionRetry(seed, app);
  await arrangeControl(seed, app, "eval.task_activity.seed", { withFollowup: true });
  return { app, workspace, session };
}

async function stoppingFeedbackFault(
  seed: Seed,
  app: Surface,
  workspaceId: string,
  sessionId: string,
) {
  await seed.evalIn(app, browserScript((workspaceId, sessionId) => {
    if (window.__harnessStoppingFault) throw new Error("A Stop feedback fault is already active");
    const port = localStorage.getItem("harness.server.port");
    if (!port) throw new Error("Stop feedback fault requires the local server port");
    const serverOrigin = `http://127.0.0.1:${port}`;
    const encodedWorkspaceId = encodeURIComponent(workspaceId);
    const encodedSessionId = encodeURIComponent(sessionId);
    const paths = new Set(["workspace", "w"].flatMap((mount) => [
      `/${mount}/${encodedWorkspaceId}/opencode/session/${encodedSessionId}/abort`,
      `/${mount}/${encodedWorkspaceId}/opencode2/api/session/${encodedSessionId}/interrupt`,
    ]));
    const originalFetch = window.fetch;
    let releaseHold = () => {};
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    const state = {
      attempts: 0,
      held: 0,
      nativeStatus: null as number | null,
      nativeFailed: false,
      released: false,
      failed: false,
      clickCaptured: false,
      trusted: false,
      elapsedMs: null as number | null,
      expired: false,
    };
    let clickedAt = 0;
    let frame = 0;
    let expiry: ReturnType<typeof setTimeout> | null = null;
    const sessionRoot = () => [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")]
      .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId) ?? null;
    const visible = (element: HTMLElement | null) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
    };
    const sample = () => {
      if (!state.clickCaptured || state.elapsedMs !== null) return;
      const button = sessionRoot()?.querySelector<HTMLButtonElement>('button[aria-label="Stopping…"][aria-busy="true"]') ?? null;
      if (button?.disabled && visible(button)) state.elapsedMs = performance.now() - clickedAt;
    };
    const paint = () => { sample(); frame = requestAnimationFrame(paint); };
    const capture = (event: MouseEvent) => {
      if (state.clickCaptured || !event.isTrusted || !(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>('button[aria-label="Stop"]');
      const root = sessionRoot();
      if (!button || !root?.contains(button)) return;
      state.clickCaptured = true;
      state.trusted = true;
      clickedAt = performance.now();
      expiry = setTimeout(() => { state.expired = true; }, 2_000);
      queueMicrotask(sample);
    };
    window.addEventListener("click", capture, true);
    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    frame = requestAnimationFrame(paint);

    const wrappedFetch: typeof window.fetch = async (...args) => {
      const input = args[0];
      const init = args[1];
      const requestUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (state.released || method !== "POST" || requestUrl.origin !== serverOrigin || !paths.has(requestUrl.pathname)) {
        return originalFetch(...args);
      }
      state.attempts += 1;
      state.held += 1;
      try {
        await hold;
        if (state.failed) {
          state.nativeStatus = 503;
          return new Response(JSON.stringify({ message: "Stop unavailable" }), {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "content-type": "application/json" },
          });
        }
        try {
          const response = await originalFetch(...args);
          state.nativeStatus = response.status;
          return response;
        } catch (error) {
          state.nativeFailed = true;
          throw error;
        }
      } finally {
        state.held -= 1;
      }
    };
    window.fetch = wrappedFetch;
    const release = (failed: boolean) => {
      if (state.released) return;
      state.failed = failed;
      state.released = true;
      releaseHold();
    };
    const dispose = () => {
      release(true);
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (expiry) clearTimeout(expiry);
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("click", capture, true);
    };
    window.__harnessStoppingFault = { state, fail: () => release(true), dispose };
  }, [workspaceId, sessionId]));

  let disposed = false;
  return {
    async read() {
      return seed.evalIn(app, browserScript((sessionId) => {
        const fault = window.__harnessStoppingFault;
        if (!fault) throw new Error("Stop feedback fault lost its document");
        const root = [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")]
          .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId) ?? null;
        const stopping = root?.querySelector<HTMLButtonElement>('button[aria-label="Stopping…"]') ?? null;
        const retry = root?.querySelector<HTMLButtonElement>('button[aria-label="Stop"]') ?? null;
        const run = root?.querySelector<HTMLButtonElement>('button[aria-label="Run task"]') ?? null;
        const error = root?.querySelector<HTMLElement>('[data-testid="session-error-card"]') ?? null;
        const aggregate = root?.querySelector<HTMLElement>("[data-tool-aggregate]") ?? null;
        const composer: unknown = window.__harness?.slice("composer");
        const snapshotQuery = composer && typeof composer === "object" && "snapshotQuery" in composer
          ? composer.snapshotQuery
          : null;
        const visible = (element: HTMLElement | null) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
            && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
        };
        return {
          ...fault.state,
          stoppingVisible: visible(stopping),
          stoppingDisabled: stopping?.disabled ?? false,
          ariaBusy: stopping?.getAttribute("aria-busy") ?? null,
          spinnerVisible: visible(stopping?.querySelector<HTMLElement>("svg.lucide-loader-circle.animate-spin") ?? null),
          retryEnabled: Boolean(retry && visible(retry) && !retry.disabled),
          runVisible: visible(run),
          errorText: error?.innerText.replace(/\s+/g, " ").trim() ?? "",
          aggregateText: aggregate?.innerText.replace(/\s+/g, " ").trim() ?? "",
          snapshotMessageCount: snapshotQuery && typeof snapshotQuery === "object" && "dataMessageCount" in snapshotQuery
            && typeof snapshotQuery.dataMessageCount === "number" ? snapshotQuery.dataMessageCount : 0,
          surfaceError: composer && typeof composer === "object" && "error" in composer ? composer.error : null,
        };
      }, [sessionId]));
    },
    async fail() {
      await seed.evalIn(app, () => {
        const fault = window.__harnessStoppingFault;
        if (!fault || fault.state.held < 1) throw new Error("No native Stop response is held");
        fault.fail();
      });
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      await seed.evalIn(app, () => {
        window.__harnessStoppingFault?.dispose();
        delete window.__harnessStoppingFault;
      });
    },
  };
}
