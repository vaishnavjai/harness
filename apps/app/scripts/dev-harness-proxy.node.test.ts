import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, loadConfigFromFile } from "vite";
import { devHarnessProxy } from "../dev-harness-proxy.ts";
import { devDenProxy } from "../dev-den-proxy.ts";

test("Den proxy maps only the normalized hosted origin and strips the exact prefix", () => {
  assert.deepEqual(devDenProxy({}), {});
  for (const target of ["https://app.harness.invalid", " https://APP.harness.invalid:443/ "]) {
    const proxy = devDenProxy({ HARNESS_DEV_HEADLESS_DEN_TARGET: target })["/api/den"];
    assert.equal(proxy.target, "https://api.harness.invalid");
    assert.equal(proxy.changeOrigin, true);
    assert(proxy.rewrite);
    assert.equal(proxy.rewrite("/api/den/v1/me?x=a%2Fb&x=2"), "/v1/me?x=a%2Fb&x=2");
    assert.equal(proxy.rewrite("/api/den"), "/");
    assert.equal(proxy.rewrite("/api/den?x=1"), "?x=1");
    assert.equal(proxy.rewrite("/api/denial/v1/me"), "/api/denial/v1/me");
  }
  for (const target of ["http://127.0.0.1:8788", "https://den.example.test", "https://app.harness.invalid.evil.test", "https://sub.app.harness.invalid", "https://app.harness.invalid/path", "https://user:pass@app.harness.invalid", "https://app.harness.invalid?x=1", "https://app.harness.invalid/#fragment", "http://app.harness.invalid", "https://app.harness.invalid:444"]) {
    assert.deepEqual(devDenProxy({ HARNESS_DEV_HEADLESS_DEN_TARGET: target }), {
      "/api/den": { target, changeOrigin: true },
    });
  }
});

test("Den HTTP proxy sends auth, cookies, method, body and query directly without redirects", async () => {
  const received: Array<{ url?: string; authorization?: string; cookie?: string; method?: string; host?: string; body: string }> = [];
  const backend = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, method: req.method, host: req.headers.host, body });
    res.end("direct-api");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  assert(address && typeof address !== "string");
  const proxy = devDenProxy({ HARNESS_DEV_HEADLESS_DEN_TARGET: "https://app.harness.invalid" })["/api/den"];
  assert.equal(proxy.target, "https://api.harness.invalid");
  const vite = await createViteServer({
    configFile: false, logLevel: "silent", server: { host: "127.0.0.1", port: 0,
      proxy: { "/api/den": { ...proxy, target: `http://127.0.0.1:${address.port}` } },
    },
  });
  try {
    await vite.listen();
    const viteAddress = vite.httpServer?.address();
    assert(viteAddress && typeof viteAddress !== "string");
    const response = await fetch(`http://127.0.0.1:${viteAddress.port}/api/den/v1/me?x=a%2Fb`, {
      method: "POST", headers: { Authorization: "Bearer fixture", Cookie: "session=fixture" }, body: "fixture-body", redirect: "manual",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(await response.text(), "direct-api");
    assert.deepEqual(received, [{ url: "/v1/me?x=a%2Fb", authorization: "Bearer fixture", cookie: "session=fixture", method: "POST", host: `127.0.0.1:${address.port}`, body: "fixture-body" }]);
  } finally {
    await vite.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});

test("an explicit local Den API target bypasses the web redirect and preserves the API path", () => {
  const proxy = devDenProxy({
    HARNESS_DEV_HEADLESS_DEN_TARGET: "http://127.0.0.1:8788",
    HARNESS_DEV_HEADLESS_DEN_API_TARGET: "http://127.0.0.1:8787",
  })["/api/den"];
  assert.equal(proxy.target, "http://127.0.0.1:8787");
  assert.equal(proxy.rewrite?.("/api/den/v1/org?active=true"), "/v1/org?active=true");
});

test("Harness proxy is development-only and needs only a loopback target", () => {
  const env = { HARNESS_DEV_MODE: "1", HARNESS_DEV_HARNESS_PROXY_TARGET: "http://127.0.0.1:8778" };
  assert.deepEqual(devHarnessProxy({ ...env, HARNESS_DEV_MODE: "0" }), {});
  assert.deepEqual(devHarnessProxy({ HARNESS_DEV_MODE: "1" }), {});
  const proxy = devHarnessProxy(env)["/api/harness"];
  assert(proxy);
  assert.equal(proxy.ws, true);
  assert.equal(proxy.rewrite("/api/harness/sessions?x=1"), "/sessions?x=1");
  assert.equal(proxy.rewrite("/api/harness"), "/");
  assert(!("headers" in proxy));
  assert(!("configure" in proxy));
  assert.throws(() => devHarnessProxy({ ...env, HARNESS_DEV_HARNESS_PROXY_TARGET: "https://outside.example.test" }));
});

test("Vite same-origin proxy preserves client bearer auth on HTTP and WS without host token injection", async () => {
  const received: Array<{ url?: string; authorization?: string; host?: string; hostToken?: string | string[] }> = [];
  const backend = createServer((req, res) => {
    received.push({ url: req.url, authorization: req.headers.authorization, host: req.headers.host, hostToken: req.headers["x-harness-host-token"] });
    res.end("backend");
  });
  backend.on("upgrade", (req, socket) => {
    received.push({ url: req.url, authorization: req.headers.authorization, host: req.headers.host, hostToken: req.headers["x-harness-host-token"] });
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  assert(address && typeof address !== "string");
  const vite = await createViteServer({
    configFile: false, logLevel: "silent", server: { host: "127.0.0.1", port: 0,
      proxy: devHarnessProxy({ HARNESS_DEV_MODE: "1", HARNESS_DEV_HARNESS_PROXY_TARGET: `http://127.0.0.1:${address.port}`,
        HARNESS_HOST_TOKEN: "must-not-inject" }),
    },
  });
  try {
    await vite.listen();
    const viteAddress = vite.httpServer?.address();
    assert(viteAddress && typeof viteAddress !== "string");
    const origin = `http://127.0.0.1:${viteAddress.port}`;
    const response = await fetch(`${origin}/api/harness/probe?x=1`, { headers: { Authorization: "Bearer client" } });
    assert.equal(await response.text(), "backend");
    await fetch(`${origin}/api/harness/unauthenticated`);
    await new Promise<void>((resolve, reject) => {
      const req = request(`${origin}/api/harness/socket`, {
        headers: { Connection: "Upgrade", Upgrade: "websocket", Authorization: "Bearer ws-client", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
      }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject);
      req.end();
    });
    assert.deepEqual(received, [
      { url: "/probe?x=1", authorization: "Bearer client", host: `127.0.0.1:${address.port}`, hostToken: undefined },
      { url: "/unauthenticated", authorization: undefined, host: `127.0.0.1:${address.port}`, hostToken: undefined },
      { url: "/socket", authorization: "Bearer ws-client", host: `127.0.0.1:${address.port}`, hostToken: undefined },
    ]);
  } finally {
    await vite.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});

test("source Vite accepts a nonsecret host suffix and lets HMR derive the current location", async () => {
  const selected = {
    HARNESS_DEV_MODE: "1", HARNESS_DEV_HARNESS_PROXY_TARGET: "http://127.0.0.1:8778",
    HARNESS_DEV_BROWSER_HOST_SUFFIX: ".example.test", HARNESS_DEV_HEADLESS_DEN_TARGET: "https://app.harness.invalid",
  };
  const previous = new Map(Object.keys(selected).map((key) => [key, process.env[key]]));
  Object.assign(process.env, selected);
  try {
    const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, fileURLToPath(new URL("../vite.config.ts", import.meta.url)));
    assert(loaded);
    assert.equal(loaded.config.server?.hmr, undefined);
    assert(loaded.config.server?.allowedHosts !== true && loaded.config.server?.allowedHosts?.includes(".example.test"));
    assert(loaded.config.server?.proxy?.["/api/harness"]);
    const denProxy = loaded.config.server?.proxy?.["/api/den"];
    assert(denProxy && typeof denProxy !== "string");
    assert.equal(denProxy.target, "https://api.harness.invalid");
    for (const environment of [{ command: "build", mode: "production" }, { command: "serve", mode: "production", isPreview: true }] satisfies Array<import("vite").ConfigEnv>) {
      const production = await loadConfigFromFile(environment, fileURLToPath(new URL("../vite.config.ts", import.meta.url)));
      assert(production);
      assert.equal(production.config.server?.proxy?.["/api/harness"], undefined);
      assert.equal(production.config.server?.proxy?.["/api/den"], undefined);
      assert.equal(production.config.server?.hmr, undefined);
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
