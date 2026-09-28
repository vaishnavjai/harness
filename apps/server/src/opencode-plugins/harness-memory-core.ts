// Helpers for the harness-memory engine plugin. Kept out of the plugin entry
// because OpenCode calls every function a plugin module exports.

import { z } from "zod";
import { appendAgentInstructions, createInstructionSection } from "./agent-instruction-compose.js";

const ENGINE_SECRET_HEADER = "x-harness-engine-secret";
const REQUEST_TIMEOUT_MS = 60_000;
export const MEMORY_UNAVAILABLE = "Memory is off or not running. The user can turn it on in Settings > Memory.";

type FetchMemory = (url: string, init: RequestInit) => Promise<Response>;

export interface MemoryPluginInput {
  serverUrl: string;
  secret: string;
  fetchImpl?: FetchMemory;
}

const MEMORY_INSTRUCTIONS = `## Long-term memory
- memory_recall searches what you learned in earlier conversations with this user (their preferences, projects, decisions). Call it when prior context would change your answer, before asking the user to repeat themselves.
- memory_retain stores a durable fact the user wants remembered or that will matter in later conversations. Write it as one self-contained statement. Never store passwords, API keys, tokens or other secrets.
- Memory runs only on this computer. If it is off, say so and carry on without it.`;

export const recallArgsSchema = z.object({
  query: z.string().min(1).max(2_000).describe("What to look up, in plain words, e.g. \"which package manager the user prefers\"."),
  maxTokens: z.number().int().min(256).max(8_192).optional().describe("Upper bound on the size of the returned memories. Defaults to 2048."),
});

export const retainArgsSchema = z.object({
  content: z.string().min(1).max(50_000).describe("The fact to remember, as one self-contained statement."),
  context: z.string().max(500).optional().describe("Where it came from, e.g. \"chat about the release plan\"."),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/** POST to one of the server's engine memory routes. Only ever loopback. */
export async function callMemoryRoute(input: MemoryPluginInput, route: "recall" | "retain", body: unknown): Promise<unknown> {
  const base = input.serverUrl.replace(/\/+$/, "");
  if (!base || !input.secret || !isLoopbackUrl(base)) throw new Error(MEMORY_UNAVAILABLE);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${base}/engine/memory/${route}`, {
      method: "POST",
      headers: { [ENGINE_SECRET_HEADER]: input.secret, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(MEMORY_UNAVAILABLE);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === "string" ? payload.message : MEMORY_UNAVAILABLE;
    throw new Error(message);
  }
  return payload;
}

/** Render recalled memories for the model, newest facts as they came back. */
export function formatRecall(payload: unknown): string {
  const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
  const lines = results.flatMap((hit) => {
    if (!isRecord(hit) || typeof hit.text !== "string") return [];
    const details = [typeof hit.type === "string" ? hit.type : "", typeof hit.occurredAt === "string" ? hit.occurredAt : ""].filter(Boolean);
    return [`- ${hit.text}${details.length ? ` (${details.join(", ")})` : ""}`];
  });
  return lines.length ? `Memories:\n${lines.join("\n")}` : "No memories matched.";
}

export function createMemoryPlugin(input: MemoryPluginInput) {
  return async () => ({
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      appendAgentInstructions(output.system, createInstructionSection("memory", MEMORY_INSTRUCTIONS));
    },
    tool: {
      memory_recall: {
        description: "Search the user's long-term memory from earlier conversations (kept only on this computer). Returns matching facts.",
        args: recallArgsSchema.shape,
        async execute(rawArgs: unknown) {
          const args = recallArgsSchema.parse(rawArgs);
          try {
            return formatRecall(await callMemoryRoute(input, "recall", args));
          } catch (error) {
            return error instanceof Error ? error.message : MEMORY_UNAVAILABLE;
          }
        },
      },
      memory_retain: {
        description: "Store a durable fact in the user's long-term memory (kept only on this computer) so later conversations can recall it. Never store secrets.",
        args: retainArgsSchema.shape,
        async execute(rawArgs: unknown) {
          const args = retainArgsSchema.parse(rawArgs);
          try {
            await callMemoryRoute(input, "retain", args);
            return "Remembered.";
          } catch (error) {
            return error instanceof Error ? error.message : MEMORY_UNAVAILABLE;
          }
        },
      },
    },
  });
}
