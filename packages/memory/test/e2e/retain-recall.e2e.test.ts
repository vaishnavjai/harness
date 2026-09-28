// End-to-end: the real vendored Hindsight engine, started by the real
// supervisor through the real launcher, doing retain and recall against a
// stub of the user's local model server. Nothing leaves 127.0.0.1.
//
// Needs a runtime: `node scripts/hindsight/prepare-runtime.mjs --outdir .hindsight-runtime`
// (or HARNESS_HINDSIGHT_PYTHON). Skips otherwise. Postgres refuses to run as
// root, so when the suite runs as root the engine is started as `nobody`.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chown, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { HindsightSupervisor } from "../../src/HindsightSupervisor.js";
import { parseMemorySettings, type MemoryLlmProvider } from "../../src/memory-settings.js";
import { isProcessAlive, readPostmasterPid, waitForExit } from "../../src/process-tree.js";
import { resolveHindsightRuntime } from "../../src/runtime.js";

const repoRoot = resolve(import.meta.dir, "../../../..");
const runtime = resolveHindsightRuntime({ repoRoot, bundledRoot: join(repoRoot, ".hindsight-runtime") });
const asRoot = process.getuid?.() === 0;
const NOBODY = 65_534;
const DIMENSIONS = 768;

const REMEMBERED = "Jordan prefers pnpm over npm for every Harness workspace.";

/** Deterministic bag-of-words vectors: texts sharing words land close together. */
function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const index = Math.abs(hash) % DIMENSIONS;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

/** Answer Hindsight's structured-output calls by the schema they ask for. */
function structuredReply(schemaText: string, promptText: string): string {
  if (schemaText.includes('"facts"')) {
    const facts = promptText.includes("pnpm")
      ? [
          {
            what: REMEMBERED,
            when: "N/A",
            where: "N/A",
            who: "Jordan",
            why: "N/A",
            fact_kind: "conversation",
            fact_type: "world",
            entities: ["Jordan", "pnpm", "npm"],
          },
        ]
      : [];
    return JSON.stringify({ facts });
  }
  if (schemaText.includes('"creates"')) return JSON.stringify({ creates: [], updates: [], deletes: [] });
  return "{}";
}

interface ModelCall {
  path: string;
  authorization: string | null;
}

function startModelServer() {
  const calls: ModelCall[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({ path: url.pathname, authorization: request.headers.get("authorization") });
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
      // Plain message text: the soft JSON mode embeds the schema in the prompt.
      const promptText = messages
        .map((message) => {
          const content = typeof message === "object" && message !== null && "content" in message ? message.content : "";
          return typeof content === "string" ? content : JSON.stringify(content);
        })
        .join("\n");
      if (url.pathname === "/v1/embeddings") {
        const inputs = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? "")];
        return Response.json({
          object: "list",
          model: body.model,
          data: inputs.map((text, index) => ({ object: "embedding", index, embedding: embed(text) })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }
      if (url.pathname === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: structuredReply(promptText, promptText) },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      }
      if (url.pathname === "/api/chat") {
        // Ollama's native API: the schema travels in `format`.
        return Response.json({
          model: body.model,
          created_at: new Date().toISOString(),
          message: { role: "assistant", content: structuredReply(JSON.stringify(body.format ?? {}), promptText) },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 10,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, calls, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function engineDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "harness-memory-e2e-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  for (const dir of [dataDir, join(dataDir, "home"), join(dataDir, "postgres"), join(dataDir, "run")]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (asRoot) await chown(dir, NOBODY, NOBODY);
  }
  return dataDir;
}

async function startEngine(provider: MemoryLlmProvider, modelBaseUrl: string, port: number) {
  if (!runtime) throw new Error("no runtime");
  const dataDir = await engineDataDir();
  const launch = asRoot
    ? {
        command: "setpriv",
        args: [`--reuid=${NOBODY}`, `--regid=${NOBODY}`, "--clear-groups", runtime.launch.command, ...runtime.launch.args],
      }
    : runtime.launch;
  const supervisor = new HindsightSupervisor({
    launch,
    dataDir,
    settings: parseMemorySettings({
      enabled: true,
      port,
      llm: { provider, baseUrl: modelBaseUrl, model: "stub-model" },
      embeddings: { model: "nomic-embed-text" },
    }),
    readyTimeoutMs: 240_000,
    installExitHooks: false,
    logger: { info: () => undefined, warn: (line) => process.stderr.write(`${line}\n`) },
  });
  cleanups.push(() => supervisor.stop());
  return { supervisor, dataDir };
}

const OTHER_ACCOUNT = 1;

/**
 * Tries to open the engine's database as a different OS account: with pg0's
 * well-known default login over TCP, through the engine's private socket, and
 * through /tmp. Also tries the real password, so a pass proves authentication
 * (not an unreachable server) is what keeps the other account out.
 */
async function probeDatabaseFromAnotherAccount(dataDir: string) {
  if (!runtime) throw new Error("no runtime");
  const postmaster = (await readFile(join(dataDir, "postgres", "postmaster.pid"), "utf8")).split("\n");
  const port = Number(postmaster[3]);
  const password = (await readFile(join(dataDir, "database-password"), "utf8")).trim();
  const script = [
    "import asyncio, json, sys",
    "import asyncpg",
    "port, run_dir, password = int(sys.argv[1]), sys.argv[2], sys.argv[3]",
    "async def attempt(**kwargs):",
    "    try:",
    "        conn = await asyncpg.connect(database='hindsight', timeout=5, port=port, ssl=False, **kwargs)",
    "        await conn.fetchval('select 1')",
    "        await conn.close()",
    "        return 'connected'",
    "    except Exception as error:",
    "        return type(error).__name__",
    "async def main():",
    "    print(json.dumps({",
    "        'defaultLoginTcp': await attempt(host='127.0.0.1', user='hindsight', password='hindsight'),",
    "        'privateSocket': await attempt(host=run_dir, user='hindsight', password='hindsight'),",
    "        'tmpSocket': await attempt(host='/tmp', user='hindsight', password='hindsight'),",
    "        'realPasswordTcp': await attempt(host='127.0.0.1', user='hindsight', password=password),",
    "    }))",
    "asyncio.run(main())",
  ].join("\n");
  const python = runtime.launch.command;
  const child = spawn("setpriv", [`--reuid=${OTHER_ACCOUNT}`, `--regid=${OTHER_ACCOUNT}`, "--clear-groups", python, "-I", "-c", script, String(port), join(dataDir, "run"), password], {
    stdio: ["ignore", "pipe", "pipe"],
    // The other account's own environment: nothing of this user's HOME.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", PYTHONNOUSERSITE: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolveExit) => child.once("close", resolveExit));
  if (!stdout.trim()) throw new Error(`database probe failed: ${stderr}`);
  return { port, results: JSON.parse(stdout) as Record<string, string> };
}

describe.skipIf(!runtime)("embedded Hindsight engine (real)", () => {
  for (const provider of ["openai-compatible", "ollama"] as const) {
    test(`retain then recall through a local ${provider} endpoint, fully on loopback`, async () => {
      const models = startModelServer();
      cleanups.push(() => models.server.stop(true));
      const { supervisor, dataDir } = await startEngine(provider, models.baseUrl, provider === "ollama" ? 18_877 : 18_876);

      const endpoint = await supervisor.start();
      expect(endpoint.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
      const client = supervisor.client();
      await client.ensureBank("harness");

      const retained = await client.retain("harness", [{ content: REMEMBERED, context: "chat with Jordan" }]);
      expect(retained.success).toBe(true);

      const hits = await client.recall("harness", "Which package manager does Jordan prefer?");
      expect(hits.map((hit) => hit.text).join("\n")).toContain("pnpm");
      const page = await client.listMemories("harness");
      expect(page.total).toBeGreaterThan(0);

      // Extraction went to the user's model server and nowhere else.
      const paths = new Set(models.calls.map((call) => call.path));
      expect(paths.has("/v1/embeddings")).toBe(true);
      expect(paths.has(provider === "ollama" ? "/api/chat" : "/v1/chat/completions")).toBe(true);

      if (asRoot && provider === "openai-compatible") {
        // Another OS account cannot open the memory database.
        const probe = await probeDatabaseFromAnotherAccount(dataDir);
        expect(probe.results.defaultLoginTcp).toBe("InvalidPasswordError");
        expect(probe.results.privateSocket).toBe("PermissionError");
        expect(probe.results.tmpSocket).not.toBe("connected");
        expect(probe.results.realPasswordTcp).toBe("connected");
        await expect(stat(`/tmp/.s.PGSQL.${probe.port}`)).rejects.toThrow();
        expect((await stat(join(dataDir, "run", `.s.PGSQL.${probe.port}`))).isSocket()).toBe(true);
      }

      // Stopping takes the embedded Postgres down with the engine.
      const postmaster = await readPostmasterPid(join(dataDir, "postgres"));
      expect(postmaster).not.toBeNull();
      await supervisor.stop();
      expect(await waitForExit(endpoint.pid, 10_000)).toBe(true);
      if (postmaster) expect(await waitForExit(postmaster, 15_000)).toBe(true);
      expect(isProcessAlive(endpoint.pid)).toBe(false);
    }, 360_000);
  }

  test("nothing survives a supervising process that is SIGKILLed", async () => {
    if (!runtime || process.platform === "win32") return;
    const dataDir = await engineDataDir();
    const launch = asRoot
      ? ["setpriv", `--reuid=${NOBODY}`, `--regid=${NOBODY}`, "--clear-groups", runtime.launch.command, ...runtime.launch.args]
      : [runtime.launch.command, ...runtime.launch.args];
    const host = spawn(process.execPath, [join(import.meta.dir, "real-supervisor-host.ts"), dataDir, "18878", ...launch], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(() => host.exitCode === null && host.kill("SIGKILL"));
    const enginePid = await new Promise<number>((resolveReady, reject) => {
      host.stdout.on("data", (chunk: Buffer) => {
        const match = /"pid":(\d+)/.exec(chunk.toString());
        if (match) resolveReady(Number(match[1]));
      });
      host.once("exit", (code) => reject(new Error(`host exited early with ${code}`)));
    });
    const postmaster = await readPostmasterPid(join(dataDir, "postgres"));
    expect(postmaster).not.toBeNull();
    host.kill("SIGKILL");
    // The launcher sees its stdin pipe close and shuts the engine and its
    // database down on its own.
    expect(await waitForExit(enginePid, 30_000)).toBe(true);
    if (postmaster) expect(await waitForExit(postmaster, 30_000)).toBe(true);
  }, 360_000);
});
