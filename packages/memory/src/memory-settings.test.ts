import { describe, expect, test } from "bun:test";

import {
  buildModelEnvironment,
  DEFAULT_MEMORY_SETTINGS,
  memoryEgressHosts,
  parseMemorySettings,
  providerRequiresApiKey,
  resolveEmbeddingDimensions,
} from "./memory-settings.js";

describe("memory settings", () => {
  test("default to a local Ollama endpoint on loopback, disabled until opted in", () => {
    expect(DEFAULT_MEMORY_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_MEMORY_SETTINGS.port).toBe(8888);
    expect(DEFAULT_MEMORY_SETTINGS.llm.provider).toBe("ollama");
    const env = buildModelEnvironment(DEFAULT_MEMORY_SETTINGS, {});
    expect(env.HINDSIGHT_API_LLM_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(env.HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(env.HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS).toBe("768");
    expect(env.HINDSIGHT_API_RERANKER_PROVIDER).toBe("rrf");
    expect(env.HINDSIGHT_API_SKIP_LLM_VERIFICATION).toBe("true");
    expect(memoryEgressHosts(DEFAULT_MEMORY_SETTINGS)).toEqual([]);
  });

  test("map vLLM / llama.cpp style servers to Hindsight's OpenAI-compatible provider", () => {
    const settings = parseMemorySettings({
      llm: { provider: "openai-compatible", baseUrl: "http://gpu-box.lan:8000/v1", model: "qwen2.5-14b" },
      embeddings: { model: "bge-m3" },
    });
    const env = buildModelEnvironment(settings, {});
    expect(env.HINDSIGHT_API_LLM_PROVIDER).toBe("openai");
    expect(env.HINDSIGHT_API_LLM_BASE_URL).toBe("http://gpu-box.lan:8000/v1");
    expect(env.HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS).toBe("1024");
    expect(memoryEgressHosts(settings)).toEqual(["gpu-box.lan"]);
  });

  test("hosted providers need a key and allow exactly their own host", () => {
    const settings = parseMemorySettings({
      llm: { provider: "openai", model: "gpt-4.1-mini" },
      embeddings: { model: "text-embedding-3-small" },
    });
    expect(providerRequiresApiKey("openai")).toBe(true);
    expect(() => buildModelEnvironment(settings, {})).toThrow("needs an API key");
    const env = buildModelEnvironment(settings, { llmApiKey: "sk-test-123456" });
    expect(env.HINDSIGHT_API_LLM_API_KEY).toBe("sk-test-123456");
    expect(env.HINDSIGHT_API_LLM_BASE_URL).toBeUndefined();
    expect(memoryEgressHosts(settings)).toEqual(["api.openai.com"]);
  });

  test("never send memory text to a provider without an embeddings API", () => {
    const settings = parseMemorySettings({ llm: { provider: "anthropic", model: "claude-haiku-4-5" } });
    const env = buildModelEnvironment(settings, { llmApiKey: "sk-ant-test" });
    expect(env.HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(memoryEgressHosts(settings)).toEqual(["api.anthropic.com"]);
  });

  test("reject endpoints that are not plain http(s) or carry credentials", () => {
    expect(() => parseMemorySettings({ llm: { baseUrl: "file:///etc/passwd" } })).toThrow();
    expect(() => parseMemorySettings({ llm: { baseUrl: "https://user:pass@llm.example.com/v1" } })).toThrow();
    expect(() => parseMemorySettings({ bankId: "../other" })).toThrow();
    expect(() => parseMemorySettings({ port: 80 })).toThrow();
  });

  test("drop trailing slashes from endpoints so Ollama's native /api/chat URL is built correctly", () => {
    const settings = parseMemorySettings({
      enabled: true,
      llm: { provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1/", model: "llama3.1:8b" },
      embeddings: { baseUrl: " http://127.0.0.1:11434/v1// ", model: "nomic-embed-text" },
    });
    expect(settings.llm.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(settings.embeddings.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(buildModelEnvironment(settings, {}).HINDSIGHT_API_LLM_BASE_URL).toBe("http://127.0.0.1:11434/v1");
  });

  test("embedding dimensions come from settings, then the known-model table", () => {
    expect(resolveEmbeddingDimensions(parseMemorySettings({ embeddings: { model: "nomic-embed-text:latest" } }))).toBe(768);
    expect(resolveEmbeddingDimensions(parseMemorySettings({ embeddings: { model: "custom", dimensions: 512 } }))).toBe(512);
    expect(resolveEmbeddingDimensions(parseMemorySettings({ embeddings: { model: "custom" } }))).toBeUndefined();
  });
});
