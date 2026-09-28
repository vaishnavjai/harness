import { afterEach, expect, test, vi } from "vitest";
import { configuredLiveProvider } from "../worlds/live-provider.ts";

afterEach(() => vi.unstubAllEnvs());

test("credentials alone never opt into real inference", async () => {
  vi.stubEnv("HARNESS_LIVE_PROVIDER", "");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
  expect(await configuredLiveProvider()).toBeNull();
});

test("explicit direct OpenAI preserves the credential destination and both selected models", async () => {
  vi.stubEnv("HARNESS_LIVE_PROVIDER", "OpenAI");
  vi.stubEnv("HARNESS_LIVE_KEY_ENV", "HARNESS_TEST_PROVIDER_KEY");
  vi.stubEnv("HARNESS_TEST_PROVIDER_KEY", "synthetic-test-key");
  vi.stubEnv("HARNESS_LIVE_MODELS", "model-one,model-two");
  const provider = await configuredLiveProvider();
  expect(provider?.baseURL).toBe("https://api.openai.com/v1");
  expect(provider?.key).toBe("synthetic-test-key");
  expect(provider?.models.map(model => model.id)).toEqual(["model-one", "model-two"]);
});

test("missing credentials fail instead of falling back to a scripted model", async () => {
  vi.stubEnv("HARNESS_LIVE_PROVIDER", "OpenAI");
  vi.stubEnv("HARNESS_LIVE_KEY_ENV", "HARNESS_TEST_PROVIDER_KEY");
  vi.stubEnv("HARNESS_TEST_PROVIDER_KEY", "");
  vi.stubEnv("HARNESS_LIVE_MODELS", "model-one,model-two");
  await expect(configuredLiveProvider()).rejects.toThrow("no mock fallback");
});
