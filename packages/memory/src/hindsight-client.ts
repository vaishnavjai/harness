import { z } from "zod";

import { isLoopbackHostname } from "./memory-settings.js";

/**
 * Minimal client for the embedded Hindsight engine's REST API.
 *
 * It only ever talks to a loopback endpoint and always sends the per-launch
 * bearer token the supervisor minted, so the token cannot be sent to another
 * host even if a caller passes the wrong URL.
 */

export interface HindsightEndpointRef {
  baseUrl: string;
  token: string;
}

export type MemoryFactType = "world" | "experience" | "observation";

export interface RetainItemInput {
  content: string;
  context?: string;
  /** ISO timestamp of when the remembered event happened. */
  timestamp?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  documentId?: string;
}

export interface RecallOptions {
  maxTokens?: number;
  budget?: "low" | "mid" | "high";
  types?: MemoryFactType[];
  tags?: string[];
}

const bankSchema = z.object({
  bank_id: z.string(),
  name: z.string().nullish(),
  fact_count: z.number().optional(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

const bankListSchema = z.object({ banks: z.array(bankSchema) });

const retainResponseSchema = z
  .object({
    success: z.boolean(),
    bank_id: z.string(),
    items_count: z.number(),
    // Hindsight serializes this field under its alias, `async`.
    async: z.boolean(),
    operation_id: z.string().nullish(),
  })
  .transform(({ async: isAsync, ...rest }) => ({ ...rest, is_async: isAsync }));

const recallResultSchema = z.object({
  id: z.string(),
  text: z.string(),
  type: z.string().nullish(),
  context: z.string().nullish(),
  occurred_start: z.string().nullish(),
  mentioned_at: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
});

const recallResponseSchema = z.object({ results: z.array(recallResultSchema) });

const memoryUnitSchema = z.object({
  id: z.string(),
  text: z.string(),
  context: z.string().nullish(),
  date: z.string().nullish(),
  fact_type: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
});

const memoryListSchema = z.object({
  items: z.array(memoryUnitSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type MemoryBank = z.infer<typeof bankSchema>;
export type RetainResult = z.infer<typeof retainResponseSchema>;
export type RecallHit = z.infer<typeof recallResultSchema>;
export type MemoryUnit = z.infer<typeof memoryUnitSchema>;
export type MemoryPage = z.infer<typeof memoryListSchema>;

export class HindsightRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HindsightRequestError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HindsightMemoryClientOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function assertLoopbackBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
    throw new Error(`The memory engine must be reached over loopback HTTP, not ${url.origin}`);
  }
  return url;
}

function bankPath(bankId: string): string {
  return `/v1/default/banks/${encodeURIComponent(bankId)}`;
}

export class HindsightMemoryClient {
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly endpoint: HindsightEndpointRef,
    options: HindsightMemoryClientOptions = {},
  ) {
    this.origin = assertLoopbackBaseUrl(endpoint.baseUrl).origin;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private async request<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.endpoint.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HindsightRequestError(`Memory engine ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`, response.status);
    }
    return schema.parse(text ? JSON.parse(text) : {});
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.origin}/health`, { signal: AbortSignal.timeout(3_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listBanks(): Promise<MemoryBank[]> {
    return (await this.request("GET", "/v1/default/banks", bankListSchema)).banks;
  }

  /** Create the bank if needed (idempotent upsert). */
  async ensureBank(bankId: string, name = "Harness"): Promise<void> {
    await this.request("PUT", bankPath(bankId), z.unknown(), { name });
  }

  async retain(bankId: string, items: RetainItemInput[], options: { async?: boolean } = {}): Promise<RetainResult> {
    if (items.length === 0) throw new Error("retain needs at least one item");
    return this.request("POST", `${bankPath(bankId)}/memories`, retainResponseSchema, {
      async: options.async ?? false,
      items: items.map((item) => ({
        content: item.content,
        ...(item.context ? { context: item.context } : {}),
        ...(item.timestamp ? { timestamp: item.timestamp } : {}),
        ...(item.metadata ? { metadata: item.metadata } : {}),
        ...(item.tags?.length ? { tags: item.tags } : {}),
        ...(item.documentId ? { document_id: item.documentId } : {}),
      })),
    });
  }

  async recall(bankId: string, query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
    const response = await this.request("POST", `${bankPath(bankId)}/memories/recall`, recallResponseSchema, {
      query,
      max_tokens: options.maxTokens ?? 2_048,
      budget: options.budget ?? "mid",
      ...(options.types?.length ? { types: options.types } : {}),
      ...(options.tags?.length ? { tags: options.tags } : {}),
    });
    return response.results;
  }

  async listMemories(
    bankId: string,
    options: { limit?: number; offset?: number; query?: string; type?: MemoryFactType } = {},
  ): Promise<MemoryPage> {
    const params = new URLSearchParams({
      limit: String(Math.min(Math.max(options.limit ?? 50, 1), 500)),
      offset: String(Math.max(options.offset ?? 0, 0)),
    });
    if (options.query) params.set("q", options.query);
    if (options.type) params.set("type", options.type);
    return this.request("GET", `${bankPath(bankId)}/memories/list?${params}`, memoryListSchema);
  }
}
