import { z } from "zod";

/**
 * Bring-your-own-LLM settings for the embedded Hindsight memory engine.
 *
 * Memory consolidation (retain) and retrieval (recall) call the user's own
 * model endpoints: a local server (Ollama, vLLM, llama.cpp, LM Studio) by
 * default, or a hosted provider when the user supplies an API key. API keys
 * are never part of these settings; they live in the OS-keychain-backed
 * secret store and are passed to the engine process only through its
 * environment.
 */

export const DEFAULT_MEMORY_PORT = 8888;
export const DEFAULT_MEMORY_BANK_ID = "harness";
export const DEFAULT_LOCAL_LLM_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_LOCAL_LLM_MODEL = "llama3.1:8b";
export const DEFAULT_LOCAL_EMBEDDINGS_MODEL = "nomic-embed-text";

/**
 * Providers the memory engine can call. `openai-compatible` covers vLLM,
 * llama.cpp's server and any other `/v1/chat/completions` endpoint.
 */
export const MEMORY_LLM_PROVIDERS = [
  "ollama",
  "openai-compatible",
  "lmstudio",
  "openai",
  "anthropic",
  "gemini",
  "groq",
] as const;
export type MemoryLlmProvider = (typeof MEMORY_LLM_PROVIDERS)[number];

/** Providers that run on the user's machine or network and need no API key. */
const LOCAL_PROVIDERS: ReadonlySet<MemoryLlmProvider> = new Set(["ollama", "openai-compatible", "lmstudio"]);

const HOSTED_DEFAULT_BASE_URL: Partial<Record<MemoryLlmProvider, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  groq: "https://api.groq.com/openai/v1",
};

/** Output widths of common embedding models, so startup needs no probe call. */
export const KNOWN_EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "bge-m3": 1024,
  "snowflake-arctic-embed": 1024,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Endpoint must use http or https")
  .refine((value) => !new URL(value).username && !new URL(value).password, "Put credentials in the API key field, not the URL");

const llmSchema = z.object({
  provider: z.enum(MEMORY_LLM_PROVIDERS).default("ollama"),
  baseUrl: httpUrl.optional(),
  model: z.string().trim().min(1).max(200).default(DEFAULT_LOCAL_LLM_MODEL),
});

const embeddingsSchema = z.object({
  /** OpenAI-compatible `/v1/embeddings` endpoint; defaults to the LLM endpoint. */
  baseUrl: httpUrl.optional(),
  model: z.string().trim().min(1).max(200).default(DEFAULT_LOCAL_EMBEDDINGS_MODEL),
  dimensions: z.number().int().positive().max(16_384).optional(),
});

export const memorySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1024).max(65_535).default(DEFAULT_MEMORY_PORT),
  bankId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "Bank id may use letters, digits, '.', '_' and '-'")
    .default(DEFAULT_MEMORY_BANK_ID),
  llm: llmSchema.default({ provider: "ollama", model: DEFAULT_LOCAL_LLM_MODEL }),
  embeddings: embeddingsSchema.default({ model: DEFAULT_LOCAL_EMBEDDINGS_MODEL }),
});

export type HarnessMemorySettings = z.infer<typeof memorySettingsSchema>;

export const DEFAULT_MEMORY_SETTINGS: HarnessMemorySettings = memorySettingsSchema.parse({});

/** Parse persisted or user-supplied settings; invalid input throws a ZodError. */
export function parseMemorySettings(input: unknown): HarnessMemorySettings {
  return memorySettingsSchema.parse(input ?? {});
}

export function isLocalProvider(provider: MemoryLlmProvider): boolean {
  return LOCAL_PROVIDERS.has(provider);
}

/** Whether the provider needs an API key from the secret store to work. */
export function providerRequiresApiKey(provider: MemoryLlmProvider): boolean {
  return !isLocalProvider(provider);
}

export function resolveLlmBaseUrl(settings: HarnessMemorySettings): string {
  if (settings.llm.baseUrl) return settings.llm.baseUrl;
  if (settings.llm.provider === "lmstudio") return "http://127.0.0.1:1234/v1";
  return HOSTED_DEFAULT_BASE_URL[settings.llm.provider] ?? DEFAULT_LOCAL_LLM_BASE_URL;
}

export function resolveEmbeddingsBaseUrl(settings: HarnessMemorySettings): string {
  if (settings.embeddings.baseUrl) return settings.embeddings.baseUrl;
  // Anthropic and Gemini expose no OpenAI-compatible embeddings API; fall back
  // to the local default rather than sending memory text somewhere unexpected.
  if (settings.llm.provider === "anthropic" || settings.llm.provider === "gemini") return DEFAULT_LOCAL_LLM_BASE_URL;
  return resolveLlmBaseUrl(settings);
}

export function resolveEmbeddingDimensions(settings: HarnessMemorySettings): number | undefined {
  if (settings.embeddings.dimensions) return settings.embeddings.dimensions;
  const model = settings.embeddings.model.toLowerCase().replace(/:latest$/, "");
  return KNOWN_EMBEDDING_DIMENSIONS[model];
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(host) || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Remote hosts the engine may reach: exactly the user's configured model
 * endpoints. Loopback is always reachable and so is never listed.
 */
export function memoryEgressHosts(settings: HarnessMemorySettings): string[] {
  const hosts = new Set<string>();
  for (const url of [resolveLlmBaseUrl(settings), resolveEmbeddingsBaseUrl(settings)]) {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (!isLoopbackHostname(hostname)) hosts.add(hostname.toLowerCase());
  }
  return [...hosts].sort();
}

export interface MemorySecrets {
  /** API key for the LLM provider, when it needs one. */
  llmApiKey?: string;
  /** API key for the embeddings endpoint; defaults to llmApiKey. */
  embeddingsApiKey?: string;
}

/** Hindsight's provider name for a Harness provider choice. */
function hindsightLlmProvider(provider: MemoryLlmProvider): string {
  return provider === "openai-compatible" ? "openai" : provider;
}

/**
 * Environment for the engine's model calls. Local endpoints get a placeholder
 * key because the OpenAI client refuses an empty one; it is never sent to a
 * remote host because local providers only talk to the configured base URL.
 */
export function buildModelEnvironment(settings: HarnessMemorySettings, secrets: MemorySecrets): Record<string, string> {
  const llmKey = secrets.llmApiKey?.trim() || (isLocalProvider(settings.llm.provider) ? "local-no-key" : "");
  if (!llmKey) {
    throw new Error(`The ${settings.llm.provider} memory provider needs an API key.`);
  }
  const embeddingsKey = secrets.embeddingsApiKey?.trim() || llmKey;
  const env: Record<string, string> = {
    HINDSIGHT_API_LLM_PROVIDER: hindsightLlmProvider(settings.llm.provider),
    HINDSIGHT_API_LLM_MODEL: settings.llm.model,
    HINDSIGHT_API_LLM_API_KEY: llmKey,
    // A model server that is still starting must not block memory startup;
    // Settings reports endpoint reachability separately.
    HINDSIGHT_API_SKIP_LLM_VERIFICATION: "true",
    HINDSIGHT_API_EMBEDDINGS_PROVIDER: "openai",
    HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: resolveEmbeddingsBaseUrl(settings),
    HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: settings.embeddings.model,
    HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: embeddingsKey,
    // Reciprocal rank fusion: no reranker model, no download, no extra endpoint.
    HINDSIGHT_API_RERANKER_PROVIDER: "rrf",
  };
  // Hosted SDKs keep their own endpoint conventions unless the user overrides
  // the URL; resolveLlmBaseUrl still names their host for the egress allowlist.
  if (settings.llm.baseUrl || isLocalProvider(settings.llm.provider)) {
    env.HINDSIGHT_API_LLM_BASE_URL = resolveLlmBaseUrl(settings);
  }
  const dimensions = resolveEmbeddingDimensions(settings);
  if (dimensions) env.HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS = String(dimensions);
  return env;
}
