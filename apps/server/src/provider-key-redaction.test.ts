import { describe, expect, test } from "bun:test";

import { REDACTED, proxyPathCarriesCredentials, redactProviderSecrets, redactSecretsDeep } from "./provider-key-redaction.js";

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

  test("only credential-bearing reads are inspected", () => {
    for (const path of ["/config", "/config/providers", "/provider", "/global/config"]) {
      expect(proxyPathCarriesCredentials("GET", path)).toBe(true);
    }
    expect(proxyPathCarriesCredentials("PATCH", "/config")).toBe(false);
    expect(proxyPathCarriesCredentials("GET", "/session")).toBe(false);
  });

  test("rewrites a JSON config response and leaves other responses alone", async () => {
    const config = new Response(JSON.stringify({ provider: { openai: { options: { apiKey: KEY } } } }), {
      headers: { "content-type": "application/json", "content-length": "999" },
    });
    const safe = await redactProviderSecrets(config, { method: "GET", normalizedPath: "/config", loadSecrets: async () => [KEY] });
    expect(await safe.text()).not.toContain(KEY);
    expect(safe.headers.get("content-length")).toBeNull();

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
