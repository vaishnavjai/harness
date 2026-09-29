import { describe, expect, test } from "bun:test";

import { REDACTED, canonicalEnginePath, proxyPathCarriesCredentials, redactProviderSecrets, redactSecretsDeep } from "./provider-key-redaction.js";

const KEY = "sk-live-0123456789abcdef";

describe("provider key redaction", () => {
  test("redacts by field name and by exact value, at any depth", () => {
    const payload = {
      provider: { openai: { options: { apiKey: KEY, baseURL: "https://api.openai.com/v1" } } },
      providers: [{ id: "x", key: "kept", note: `see ${KEY} in logs`, auth: { access_token: "tok-1", refresh_token: "tok-2" } }],
      untouched: 3,
    };
    const text = JSON.stringify(redactSecretsDeep(payload, [KEY]));
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("tok-1");
    expect(text).not.toContain("tok-2");
    expect(text).toContain(REDACTED);
    expect(text).toContain("https://api.openai.com/v1");
    expect(text).toContain('"untouched":3');
  });

  test("credential-bearing routes are inspected for any method", () => {
    for (const path of ["/config", "/config/providers", "/provider", "/global/config", "/config/", "/provider/"]) {
      for (const method of ["GET", "HEAD", "PATCH", "PUT", "POST"]) {
        expect(proxyPathCarriesCredentials(method, path)).toBe(true);
      }
    }
    expect(proxyPathCarriesCredentials("GET", "/session")).toBe(false);
    expect(proxyPathCarriesCredentials("GET", "/session/ses_1/message")).toBe(false);
  });

  test("spellings the engine decodes to a credential route are inspected too", () => {
    for (const path of [
      "/%63onfig", "//config", "///config/", "/config/%70roviders", "/%70rovider", "/%67lobal/config", "/global//config", "/./config",
      "/session/../config", "/config/./providers", "/%2e/config", "/%252e%252e/config", "/%2563onfig", "/config?x=1", "/%2Fconfig", "/config%2fproviders",
    ]) {
      expect(proxyPathCarriesCredentials("GET", path)).toBe(true);
    }
    // A path that cannot be decoded is checked rather than trusted.
    expect(proxyPathCarriesCredentials("GET", "/%E0%A4%A")).toBe(true);
  });

  test("canonicalEnginePath resolves what the engine's router would", () => {
    expect(canonicalEnginePath("/%63onfig")).toBe("/config");
    expect(canonicalEnginePath("//global///config/")).toBe("/global/config");
    expect(canonicalEnginePath("/a/b/../c/./d")).toBe("/a/c/d");
    expect(canonicalEnginePath("/%252e%252e/config")).toBe("/config");
    expect(canonicalEnginePath("/%E0%A4%A")).toBeNull();
    expect(canonicalEnginePath("/")).toBe("/");
  });

  test("rewrites a JSON config response and leaves other responses alone", async () => {
    const config = new Response(JSON.stringify({ provider: { openai: { options: { apiKey: KEY } } } }), {
      headers: { "content-type": "application/json", "content-length": "999" },
    });
    const safe = await redactProviderSecrets(config, { method: "GET", normalizedPath: "/config", loadSecrets: async () => [KEY] });
    expect(await safe.text()).not.toContain(KEY);
    expect(safe.headers.get("content-length")).toBeNull();

    for (const normalizedPath of ["/%63onfig", "//config", "/config/%70roviders"]) {
      const disguised = new Response(JSON.stringify({ provider: { openai: { options: { apiKey: KEY } } } }), { headers: { "content-type": "application/json" } });
      const scrubbed = await redactProviderSecrets(disguised, { method: "GET", normalizedPath, loadSecrets: async () => [KEY] });
      expect(await scrubbed.text(), normalizedPath).not.toContain(KEY);
    }

    const session = new Response(`{"note":"${KEY}"}`, { headers: { "content-type": "application/json" } });
    const same = await redactProviderSecrets(session, { method: "GET", normalizedPath: "/session", loadSecrets: async () => [KEY] });
    expect(await same.text()).toContain(KEY);
  });

  test("withholds output it cannot check instead of leaking it", async () => {
    const broken = new Response(`not json ${KEY}`, { headers: { "content-type": "application/json" } });
    const result = await redactProviderSecrets(broken, { method: "GET", normalizedPath: "/provider", loadSecrets: async () => [KEY] });
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain(KEY);
  });

  test("ignores very short secrets that would corrupt ordinary text", () => {
    expect(JSON.stringify(redactSecretsDeep({ a: "abc abc" }, []))).toBe('{"a":"abc abc"}');
  });
});
