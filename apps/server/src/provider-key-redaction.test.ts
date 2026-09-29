import { describe, expect, test } from "bun:test";

import { REDACTED, canonicalEnginePath, environmentSecretValues, proxyPathCarriesCredentials, redactProviderSecrets, redactSecretsDeep } from "./provider-key-redaction.js";

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
      "/CONFIG", "/Config", "/PROVIDER", "/pRoViDeR", "/config/PROVIDERS", "/config;a=b", "/config;", "/CoNfIg;x", "/provider;a", "/config/providers;a", "/global;x/config",
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
    expect(canonicalEnginePath("/config;a=b")).toBe("/config");
    expect(canonicalEnginePath("/global;x/config;y")).toBe("/global/config");
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

    // Any other JSON route is scrubbed by value too: the engine's spelling of a path is not ours to predict.
    const session = new Response(`{"note":"${KEY}","password":"kept-on-non-credential-routes"}`, { headers: { "content-type": "application/json" } });
    const scrubbedSession = await redactProviderSecrets(session, { method: "GET", normalizedPath: "/session", loadSecrets: async () => [KEY] });
    const scrubbedText = await scrubbedSession.text();
    expect(scrubbedText).not.toContain(KEY);
    expect(scrubbedText).toContain("kept-on-non-credential-routes");
  });

  test("leaves responses alone when there is nothing to look for", async () => {
    const body = new Response('{"a":1}', { headers: { "content-type": "application/json" } });
    expect(await redactProviderSecrets(body, { method: "GET", normalizedPath: "/session", loadSecrets: async () => [] })).toBe(body);
    const stream = new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } });
    expect(await redactProviderSecrets(stream, { method: "GET", normalizedPath: "/event", loadSecrets: async () => [KEY] })).toBe(stream);
    const lines = new Response('{"a":1}\n', { headers: { "content-type": "application/x-ndjson" } });
    expect(await redactProviderSecrets(lines, { method: "GET", normalizedPath: "/stream", loadSecrets: async () => [KEY] })).toBe(lines);
  });

  test("returns an ordinary JSON body unchanged when it holds no key", async () => {
    const response = new Response('{"messages":[{"text":"hello"}]}', { status: 201, headers: { "content-type": "application/json; charset=utf-8", "content-length": "31" } });
    const result = await redactProviderSecrets(response, { method: "GET", normalizedPath: "/session/ses_1/message", loadSecrets: async () => [KEY] });
    expect(result.status).toBe(201);
    expect(await result.text()).toBe('{"messages":[{"text":"hello"}]}');
    expect(result.headers.get("content-length")).toBeNull();
  });

  test("an unreadable vault withholds credential routes and leaves the rest alone", async () => {
    const failing = async () => { throw new Error("vault unreadable"); };
    const config = new Response('{"x":1}', { headers: { "content-type": "application/json" } });
    expect((await redactProviderSecrets(config, { method: "GET", normalizedPath: "/config", loadSecrets: failing })).status).toBe(502);
    const other = new Response('{"x":1}', { headers: { "content-type": "application/json" } });
    expect(await redactProviderSecrets(other, { method: "GET", normalizedPath: "/session", loadSecrets: failing })).toBe(other);
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

describe("keys that are not in the vault", () => {
  test("the engine's top-level key field is scrubbed on credential routes", async () => {
    const providers = { all: [{ id: "anthropic", source: "env", key: "sk-ant-not-in-the-vault", env: ["ANTHROPIC_API_KEY"] }, { id: "groq", source: "api", key: "gsk-legacy-auth-file" }] };
    const response = new Response(JSON.stringify(providers), { headers: { "content-type": "application/json" } });
    const text = await (await redactProviderSecrets(response, { method: "GET", normalizedPath: "/provider", loadSecrets: async () => [] })).text();
    expect(text).not.toContain("sk-ant-not-in-the-vault");
    expect(text).not.toContain("gsk-legacy-auth-file");
    expect(text).toContain("ANTHROPIC_API_KEY");
  });

  test("credential-named environment values are collected, and other variables are not", () => {
    const values = environmentSecretValues([
      ["ANTHROPIC_API_KEY", "sk-ant-from-env-0000"], ["GITHUB_TOKEN", "ghp_from_env_00000"], ["DB_PASSWORD", "hunter2hunter2"], ["AWS_SECRET_ACCESS_KEY", "aws-secret-value-1"],
      ["PATH", "/usr/local/bin:/usr/bin"], ["SSH_AUTH_SOCK", "/tmp/ssh-abcdef/agent.123"], ["OPENAI_API_KEY", "short"], ["EMPTY_TOKEN", ""], ["HOME", "/home/someone-long"],
    ]);
    expect(values.sort()).toEqual(["aws-secret-value-1", "ghp_from_env_00000", "hunter2hunter2", "sk-ant-from-env-0000"]);
  });

  test("provider key variables that do not say API_KEY are collected too", () => {
    const values = environmentSecretValues([
      ["ABLIT_KEY", "ablit-key-value-0001"], ["CLARIFAI_PAT", "clarifai-pat-value-01"], ["AICORE_SERVICE_KEY", "aicore-service-key-01"], ["KEYMAP", "us-international-layout"], ["MONKEY", "banana-banana-banana"],
    ]);
    expect(values.sort()).toEqual(["ablit-key-value-0001", "aicore-service-key-01", "clarifai-pat-value-01"]);
  });

  test("variables that hold a location are not treated as keys", () => {
    const values = environmentSecretValues([
      ["CLAUDE_SESSION_INGRESS_TOKEN_FILE", "session-ingress-token-file-name"], ["GOOGLE_APPLICATION_CREDENTIALS", "/home/someone/service-account.json"], ["AWS_SHARED_CREDENTIALS_FILE", "credentials-file-name"],
      ["PASSWORD_STORE_DIR", "password-store-directory"], ["PIP_INDEX_TOKEN_URL", "index-token-url-value"], ["WIN_CREDENTIAL", "C:\\Users\\someone\\cred.json"], ["PROXY_TOKEN", "https://user@proxy.example/token"],
    ]);
    expect(values).toEqual([]);
  });

  test("an unreadable vault still scrubs the keys that are known elsewhere on ordinary routes", async () => {
    const envKey = "ablit-key-value-0001";
    const failing = async () => { throw new Error("vault unreadable"); };
    const ordinary = new Response(JSON.stringify({ text: `printenv says ${envKey}` }), { headers: { "content-type": "application/json" } });
    const text = await (await redactProviderSecrets(ordinary, { method: "GET", normalizedPath: "/session/x/message", loadSecrets: failing, loadFallbackSecrets: async () => [envKey] })).text();
    expect(text).not.toContain(envKey);
    const credential = new Response('{"x":1}', { headers: { "content-type": "application/json" } });
    expect((await redactProviderSecrets(credential, { method: "GET", normalizedPath: "/config", loadSecrets: failing, loadFallbackSecrets: async () => [envKey] })).status).toBe(502);
  });

  test("an environment key is scrubbed from any JSON route by value", async () => {
    const envKey = "sk-ant-from-env-0000";
    const response = new Response(JSON.stringify({ messages: [{ text: `use ${envKey} for it` }] }), { headers: { "content-type": "application/json" } });
    const text = await (await redactProviderSecrets(response, { method: "GET", normalizedPath: "/session/x/message", loadSecrets: async () => environmentSecretValues([["ANTHROPIC_API_KEY", envKey]]) })).text();
    expect(text).not.toContain(envKey);
  });
});

describe("edge cases", () => {
  test("a key with characters JSON escapes is still found", async () => {
    const odd = 'sk-"quoted"\\back\tslash-0000';
    const response = new Response(JSON.stringify({ note: `key is ${odd}` }), { headers: { "content-type": "application/json" } });
    const text = await (await redactProviderSecrets(response, { method: "GET", normalizedPath: "/session", loadSecrets: async () => [odd] })).text();
    expect(text).not.toContain("quoted");
    expect(JSON.parse(text).note).toBe(`key is ${REDACTED}`);
  });

  test("a key used as a property name is scrubbed too", () => {
    const key = "sk-live-0123456789abcdef";
    expect(JSON.stringify(redactSecretsDeep({ [key]: 1, nested: { [`x-${key}`]: 2 } }, [key]))).not.toContain(key);
  });

  test("bodyless statuses pass through untouched, so they can never throw when rebuilt", async () => {
    for (const status of [204, 205, 304]) {
      const response = new Response(null, { status, headers: { "content-type": "application/json" } });
      expect(await redactProviderSecrets(response, { method: "GET", normalizedPath: "/config", loadSecrets: async () => [KEY] })).toBe(response);
    }
  });
});
