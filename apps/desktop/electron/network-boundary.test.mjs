import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAppWindowRequest,
  createEgressRecorder,
  installAppWindowNetworkBoundary,
  isLoopbackHostname,
} from "./network-boundary.mjs";

test("loopback hosts are recognized in every spelling", () => {
  for (const host of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.8.9.10", "[::1]", "::1"]) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
  for (const host of ["localhost.evil.com", "128.0.0.1", "10.0.0.1", "example.com", "127.0.0.1.nip.io"]) {
    assert.equal(isLoopbackHostname(host), false, host);
  }
});

test("the app window never loads passive remote content", () => {
  for (const resourceType of ["image", "font", "script", "stylesheet", "subFrame", "media", "ping", "object", "cspReport"]) {
    assert.deepEqual(
      classifyAppWindowRequest({ url: "https://tracker.example.com/pixel.gif?session=1", resourceType }),
      { allow: false, host: "tracker.example.com" },
      resourceType,
    );
  }
});

test("local content and deliberate requests pass, remote ones are named for the audit log", () => {
  assert.deepEqual(classifyAppWindowRequest({ url: "http://127.0.0.1:8787/workspace", resourceType: "xhr" }), { allow: true, egressHost: null });
  assert.deepEqual(classifyAppWindowRequest({ url: "http://localhost:5173/src/main.tsx", resourceType: "script" }), { allow: true, egressHost: null });
  assert.deepEqual(classifyAppWindowRequest({ url: "file:///app/index.html", resourceType: "mainFrame" }), { allow: true, egressHost: null });
  assert.deepEqual(classifyAppWindowRequest({ url: "data:image/png;base64,AAAA", resourceType: "image" }), { allow: true, egressHost: null });
  assert.deepEqual(classifyAppWindowRequest({ url: "blob:file:///1234", resourceType: "image" }), { allow: true, egressHost: null });
  assert.deepEqual(
    classifyAppWindowRequest({ url: "https://workspace.example.com:8443/events", resourceType: "xhr" }),
    { allow: true, egressHost: "workspace.example.com:8443" },
  );
});

test("each destination is audited once per launch", () => {
  const events = [];
  const recorder = createEgressRecorder({ event: (kind, detail) => events.push({ kind, ...detail }) });
  recorder.egress("api.example.com", "main");
  recorder.egress("api.example.com", "app-window");
  recorder.blocked("cdn.example.com", "image");
  recorder.blocked("cdn.example.com", "image");
  recorder.blocked("cdn.example.com", "font");
  assert.deepEqual(events, [
    { kind: "network.egress", host: "api.example.com", via: "main" },
    { kind: "network.blocked", host: "cdn.example.com", resourceType: "image" },
    { kind: "network.blocked", host: "cdn.example.com", resourceType: "font" },
  ]);
});

test("the installed boundary cancels only the app window's passive remote loads", () => {
  let listener = null;
  const events = [];
  installAppWindowNetworkBoundary({
    session: { webRequest: { onBeforeRequest: (_filter, fn) => { listener = fn; } } },
    isAppWebContents: (id) => id === 7,
    recorder: createEgressRecorder({ event: (kind, detail) => events.push({ kind, ...detail }) }),
  });
  const decide = (details) => {
    let response = null;
    listener(details, (value) => { response = value; });
    return response;
  };
  assert.deepEqual(decide({ url: "https://cdn.example.com/a.png", resourceType: "image", webContentsId: 7 }), { cancel: true });
  assert.deepEqual(decide({ url: "https://cdn.example.com/a.png", resourceType: "image", webContentsId: 9 }), { cancel: false });
  assert.deepEqual(decide({ url: "https://cdn.example.com/a.png", resourceType: "image", webContentsId: undefined }), { cancel: false });
  assert.deepEqual(decide({ url: "https://remote.example.com/api", resourceType: "xhr", webContentsId: 7 }), { cancel: false });
  assert.deepEqual(events, [
    { kind: "network.blocked", host: "cdn.example.com", resourceType: "image" },
    { kind: "network.egress", host: "remote.example.com", via: "app-window" },
  ]);
});
